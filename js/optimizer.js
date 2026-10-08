/* optimizer.js — fits the 19 FSRS-5 weights to your own review log, in the browser, no libraries.
 *
 * Training data: the review logs of all banks (memory is a property of the person, not the bank).
 * Each question's answers are replayed in time order with the same state update the app uses
 * (fsrs.step); the first answer of each later day is one example: recalled (grade > 1) or not,
 * against the predicted recall R(elapsed, S). Same-day repeats only move the state (a same-day
 * lapse uses the short-term weights w17, w18), as in live scheduling.
 *
 * Fitting: w0–w3 (first stability per grade) are pretrained from first-to-second review outcomes;
 * the rest are fitted with Adam on finite-difference gradients of the binary cross-entropy, with an
 * L2 pull towards the defaults and every weight clamped to its allowed range. The new weights are
 * accepted only if they predict the newest 20% of reviews (held out) at least 2% better.
 */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var F = SET.fsrs;

  var DAY_MS = 86400000;
  var MIN_REVIEWS = 400, MIN_QUESTIONS = 100, MIN_DAYS = 14; // our thresholds for a meaningful fit
  var ACCEPT_GAIN = 0.02;          // held-out log-loss must improve by at least 2%
  var HOLDOUT = 0.2;               // newest share of examples kept for the acceptance test
  var PRETRAIN_MIN = 20;           // examples per first grade before w0–w3 are fitted
  var STEPS = 150, LEARNING_RATE = 0.02, FD_STEP = 1e-4, L2 = 5;
  var SLICE_MS = 30;               // work per slice, so the page stays responsive
  var EPS = 1e-6;
  var PROMPT_EVERY_DAYS = 30, PROMPT_EVERY_REVIEWS = 1000;

  function dayNumber(t) { var d = new Date(t); return d.getFullYear() * 512 + d.getMonth() * 32 + d.getDate(); }

  // Log entries ([qid, ms, grade, mode]) grouped per question, oldest first, with each answer's local day.
  // banks: [{ id, reviews }]. Returns { seqs: [{ t: [], g: [], day: [] }], firstT, lastT }.
  function buildData(banks) {
    var groups = Object.create(null), keys = [];
    banks.forEach(function (b) {
      (b.reviews || []).forEach(function (r) {
        var k = b.id + '\u0000' + r[0];
        if (!groups[k]) { groups[k] = []; keys.push(k); }
        groups[k].push(r);
      });
    });
    var firstT = Infinity, lastT = -Infinity;
    var seqs = keys.map(function (k) {
      var list = groups[k].slice().sort(function (a, b) { return a[1] - b[1]; });
      var s = { t: [], g: [], day: [] };
      list.forEach(function (r) {
        s.t.push(r[1]); s.g.push(r[2]); s.day.push(dayNumber(r[1]));
        if (r[1] < firstT) firstT = r[1];
        if (r[1] > lastT) lastT = r[1];
      });
      return s;
    });
    return { seqs: seqs, firstT: firstT, lastT: lastT };
  }

  // Every example's time, in order, so the newest 20% can be held out.
  function exampleTimes(data) {
    var times = [];
    data.seqs.forEach(function (s) {
      var lastDay = null;
      for (var k = 0; k < s.t.length; k++) {
        if (k > 0 && s.day[k] !== lastDay) times.push(s.t[k]);
        if (k === 0 || s.day[k] !== lastDay || s.g[k] === F.AGAIN) lastDay = s.day[k];
      }
    });
    return times.sort(function (a, b) { return a - b; });
  }

  // How much usable history there is: inter-day reviews, questions with any, and days spanned.
  function status(data) {
    var examples = exampleTimes(data).length;
    var questions = data.seqs.filter(function (s) { return s.t.length > 0; }).length;
    var days = data.seqs.length ? Math.floor((data.lastT - data.firstT) / DAY_MS) : 0;
    return {
      reviews: examples, questions: questions, days: days,
      ready: examples >= MIN_REVIEWS && questions >= MIN_QUESTIONS && days >= MIN_DAYS,
      MIN_REVIEWS: MIN_REVIEWS, MIN_QUESTIONS: MIN_QUESTIONS, MIN_DAYS: MIN_DAYS
    };
  }

  // Replays every question with weights w. Examples before splitT go to train, the rest to test.
  // Returns { train: { loss, n, se }, test: { loss, n, se } } (summed log-loss and squared error).
  function evaluate(w, data, splitT) {
    var out = { train: { loss: 0, n: 0, se: 0 }, test: { loss: 0, n: 0, se: 0 } };
    var seqs = data.seqs;
    for (var i = 0; i < seqs.length; i++) {
      var s = seqs[i], st = null, lastT = 0, lastDay = null;
      for (var k = 0; k < s.t.length; k++) {
        var g = s.g[k], t = s.t[k];
        if (!st) {
          var first = F.step(null, g, 0, false, w);
          st = { s: first.s, d: first.d }; lastT = t; lastDay = s.day[k];
          continue;
        }
        var same = s.day[k] === lastDay;
        var elapsed = Math.max(0, (t - lastT) / DAY_MS);
        if (!same) {
          var p = F.retrievability(elapsed, st.s);
          p = Math.min(1 - EPS, Math.max(EPS, p));
          var y = g > 1 ? 1 : 0;
          var bucket = t < splitT ? out.train : out.test;
          bucket.loss -= y ? Math.log(p) : Math.log(1 - p);
          bucket.se += (y - p) * (y - p);
          bucket.n++;
        }
        var res = F.step(st, g, elapsed, same, w);
        if (res.counted) { st = { s: res.s, d: res.d }; lastT = t; lastDay = s.day[k]; }
      }
    }
    return out;
  }

  function clampWeights(w) {
    return w.map(function (x, i) { return Math.min(F.BOUNDS[i][1], Math.max(F.BOUNDS[i][0], x)); });
  }

  // w0–w3 from first-to-second review outcomes, grouped by first grade (training examples only).
  // A grade with fewer than PRETRAIN_MIN examples keeps its default.
  function pretrain(data, splitT, base) {
    var by = { 1: [], 2: [], 3: [], 4: [] };
    data.seqs.forEach(function (s) {
      for (var k = 1; k < s.t.length; k++) {
        if (s.day[k] === s.day[0]) { if (s.g[k] === F.AGAIN) return; continue; } // same-day lapse changes the state
        if (s.t[k] < splitT) by[s.g[0]].push({ e: (s.t[k] - s.t[0]) / DAY_MS, y: s.g[k] > 1 ? 1 : 0 });
        return;
      }
    });
    var w = base.slice(), fitted = [];
    [1, 2, 3, 4].forEach(function (g) {
      var xs = by[g];
      if (xs.length < PRETRAIN_MIN) return;
      fitted[g - 1] = true;
      var loss = function (logS) {
        var S = Math.exp(logS), sum = 0;
        xs.forEach(function (x) {
          var p = Math.min(1 - EPS, Math.max(EPS, F.retrievability(x.e, S)));
          sum -= x.y ? Math.log(p) : Math.log(1 - p);
        });
        var pull = (logS - Math.log(base[g - 1])); // mild pull towards the default on small samples
        return sum / xs.length + pull * pull / xs.length;
      };
      // Golden-section search on log S over the allowed range.
      var lo = Math.log(F.BOUNDS[g - 1][0]), hi = Math.log(F.BOUNDS[g - 1][1]), phi = (Math.sqrt(5) - 1) / 2;
      var a = hi - phi * (hi - lo), b = lo + phi * (hi - lo), fa = loss(a), fb = loss(b);
      for (var it = 0; it < 60; it++) {
        if (fa < fb) { hi = b; b = a; fb = fa; a = hi - phi * (hi - lo); fa = loss(a); }
        else { lo = a; a = b; fa = fb; b = lo + phi * (hi - lo); fb = loss(b); }
      }
      w[g - 1] = Math.exp((lo + hi) / 2);
    });
    // A grade without enough examples keeps its default, but within the fitted grades around it,
    // so it can't drag them out of order.
    for (var i = 0; i < 4; i++) {
      if (fitted[i]) continue;
      for (var lo = i - 1; lo >= 0; lo--) if (fitted[lo]) { w[i] = Math.max(w[i], w[lo]); break; }
      for (var hi = i + 1; hi < 4; hi++) if (fitted[hi]) { w[i] = Math.min(w[i], w[hi]); break; }
    }
    // Keep the first stabilities in grade order, as FSRS expects (Again ≤ Hard ≤ Good ≤ Easy).
    for (var k = 1; k < 4; k++) if (w[k] < w[k - 1]) w[k] = w[k - 1];
    return clampWeights(w);
  }

  // A fitting job, advanced one step at a time by next(), so it can run in slices or all at once.
  // opts: { steps, base (weights to start from and pull towards; default the published set) }.
  function createJob(data, opts) {
    opts = opts || {};
    var defaults = F.DEFAULT_WEIGHTS.slice();
    var base = opts.base && F.validWeights(opts.base) ? opts.base.slice() : defaults;
    var steps = opts.steps || STEPS;
    var times = exampleTimes(data);
    var splitT = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * (1 - HOLDOUT)))] : Infinity;
    var free = [];
    for (var f = 4; f < 19; f++) free.push(f);
    var range = F.BOUNDS.map(function (b) { return b[1] - b[0]; });
    var lambda = L2 / Math.max(1, times.length);
    var w = null, u = null, m = null, v = null, t = 0, phase = 'pretrain', result = null;

    function toW(uu) {
      var out = w.slice();
      free.forEach(function (i, j) { out[i] = F.BOUNDS[i][0] + Math.min(1, Math.max(0, uu[j])) * range[i]; });
      return out;
    }
    function objective(uu) {
      var ww = toW(uu);
      var e = evaluate(ww, data, splitT).train;
      var pen = 0;
      free.forEach(function (i) { var z = (ww[i] - defaults[i]) / range[i]; pen += z * z; });
      return (e.n ? e.loss / e.n : 0) + lambda * pen;
    }

    function next() {
      if (phase === 'pretrain') {
        w = pretrain(data, splitT, base);
        u = free.map(function (i) { return (w[i] - F.BOUNDS[i][0]) / range[i]; });
        m = u.map(function () { return 0; });
        v = u.map(function () { return 0; });
        phase = 'fit';
        return;
      }
      if (phase === 'fit') {
        t++;
        var f0 = objective(u);
        var grad = u.map(function (x, j) {
          var up = u.slice(); up[j] = x + FD_STEP;
          return (objective(up) - f0) / FD_STEP;
        });
        var lr = LEARNING_RATE * (0.5 + 0.5 * Math.cos(Math.PI * t / steps)); // cosine decay
        for (var j = 0; j < u.length; j++) {
          m[j] = 0.9 * m[j] + 0.1 * grad[j];
          v[j] = 0.999 * v[j] + 0.001 * grad[j] * grad[j];
          var mh = m[j] / (1 - Math.pow(0.9, t)), vh = v[j] / (1 - Math.pow(0.999, t));
          u[j] = Math.min(1, Math.max(0, u[j] - lr * mh / (Math.sqrt(vh) + 1e-8)));
        }
        if (t >= steps) phase = 'evaluate';
        return;
      }
      if (phase === 'evaluate') {
        var fitted = clampWeights(toW(u));
        var before = evaluate(defaults, data, splitT).test;
        var after = evaluate(fitted, data, splitT).test;
        var lb = before.n ? before.loss / before.n : 0, la = after.n ? after.loss / after.n : 0;
        result = {
          weights: fitted,
          accepted: after.n > 0 && la <= lb * (1 - ACCEPT_GAIN),
          logLossBefore: lb, logLossAfter: la,
          rmseBefore: before.n ? Math.sqrt(before.se / before.n) : 0,
          rmseAfter: after.n ? Math.sqrt(after.se / after.n) : 0,
          improvement: lb ? (lb - la) / lb : 0,
          reviews: times.length, heldOut: after.n, splitT: splitT
        };
        phase = 'done';
      }
    }

    return {
      next: next,
      done: function () { return phase === 'done'; },
      progress: function () { return phase === 'pretrain' ? 0 : phase === 'fit' ? t / steps : 1; },
      result: function () { return result; }
    };
  }

  // Fits in one go (tests, small data). Same result as start() for the same data.
  function fit(data, opts) {
    var job = createJob(data, opts);
    while (!job.done()) job.next();
    return job.result();
  }

  // Fits in ~30 ms slices so the page stays responsive. (Web Workers aren't reliable from file://.)
  // Returns { promise (resolves the result, or { cancelled: true }), cancel }.
  function start(data, opts, onProgress) {
    var job = createJob(data, opts), cancelled = false;
    var promise = new Promise(function (resolve, reject) {
      function slice() {
        if (cancelled) { resolve({ cancelled: true }); return; }
        var until = Date.now() + SLICE_MS;
        try { while (!job.done() && Date.now() < until) job.next(); }
        catch (e) { reject(e); return; }
        if (onProgress) onProgress(job.progress());
        if (job.done()) resolve(job.result());
        else setTimeout(slice, 0);
      }
      setTimeout(slice, 0);
    });
    return { promise: promise, cancel: function () { cancelled = true; } };
  }

  /* ---------- using the stored logs ---------- */

  function storedBanks() {
    var S = SET.storage;
    return S.getIndex().banks.map(function (e) { return { id: e.id, reviews: S.getReviews(e.id) }; });
  }

  // A progress record rebuilt from a question's log entries with the weights in use (no exam cap).
  function replayRecord(entries) {
    var p = null;
    entries.slice().sort(function (a, b) { return a[1] - b[1]; }).forEach(function (r) {
      p = SET.weighting.record(p, r[2], new Date(r[1]).toISOString(), null);
    });
    return p;
  }

  // Rebuilds stability, difficulty and due date of every question whose whole history is in the log,
  // with the weights in use, then applies each bank's exam-date cap. Questions whose history started
  // before logging began keep their current state. Returns the number of questions rebuilt.
  function replayAll(now) {
    var S = SET.storage, W = SET.weighting, rebuilt = 0;
    S.getIndex().banks.forEach(function (entry) {
      var progress = S.getProgress(entry.id);
      var byId = Object.create(null);
      S.getReviews(entry.id).forEach(function (r) { (byId[r[0]] = byId[r[0]] || []).push(r); });
      var changed = false;
      Object.keys(progress).forEach(function (id) {
        var p = progress[id], log = byId[id];
        if (!p || !log || p.reps === undefined || log.length < (p.seen || 0)) return; // incomplete history
        progress[id] = replayRecord(log);
        changed = true;
        rebuilt++;
      });
      var r = W.reschedule(progress, entry.examDate, now);
      if (changed || r.moved) S.saveProgress(entry.id, r.progress, false);
    });
    return rebuilt;
  }

  // Saves fitted weights (null = back to the defaults) and replays every question with them.
  function apply(result, now) {
    var S = SET.storage;
    if (result && result.weights) {
      S.saveSettings({ fsrs: {
        weights: result.weights, fittedAt: new Date(now || Date.now()).toISOString(), reviews: result.reviews,
        logLossBefore: result.logLossBefore, logLossAfter: result.logLossAfter
      } });
    } else {
      S.saveSettings({ fsrs: null });
    }
    return replayAll(now);
  }

  // True when the bank page should suggest personalising: enough history, and not suggested (or
  // fitted) in the last 30 days or 1,000 reviews.
  function shouldPrompt(st, settings, now) {
    if (!st.ready) return false;
    now = now || Date.now();
    var marks = [settings.fsrsPrompt, settings.fsrs && { at: settings.fsrs.fittedAt, reviews: settings.fsrs.reviews }].filter(function (x) { return x && x.at; });
    if (!marks.length) return true;
    var last = marks.reduce(function (a, b) { return Date.parse(a.at) > Date.parse(b.at) ? a : b; });
    return now - Date.parse(last.at) >= PROMPT_EVERY_DAYS * DAY_MS || st.reviews - (last.reviews || 0) >= PROMPT_EVERY_REVIEWS;
  }

  SET.optimizer = {
    MIN_REVIEWS: MIN_REVIEWS, MIN_QUESTIONS: MIN_QUESTIONS, MIN_DAYS: MIN_DAYS, ACCEPT_GAIN: ACCEPT_GAIN,
    buildData: buildData,
    status: status,
    evaluate: evaluate,
    pretrain: pretrain,
    createJob: createJob,
    fit: fit,
    start: start,
    storedBanks: storedBanks,
    replayRecord: replayRecord,
    replayAll: replayAll,
    apply: apply,
    shouldPrompt: shouldPrompt
  };
})();
