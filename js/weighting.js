/* weighting.js — weakness score, weights, weighted sampling, mastery status */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var FOCUS = [
    { label: 'Even', F: 1, hint: 'Every question is equally likely.' },
    { label: 'Light', F: 2, hint: 'Weak questions are up to 2× as likely.' },
    { label: 'Strong', F: 4, hint: 'Weak questions are up to 4× as likely.' },
    { label: 'Intense', F: 8, hint: 'Weak questions are up to 8× as likely.' },
    { label: 'Not mastered', F: 4, weakOnly: true, hint: 'Only questions you haven’t mastered, topped up if there aren’t enough.' },
    { label: 'Due first', F: 4, dueFirst: true, hint: 'Questions due for review (or answered wrong) first, then new ones, then the rest.' }
  ];
  var DEFAULT_FOCUS = 2;
  var MASTERY_DAYS = 21; // the one place "mastered" is defined: FSRS stability of at least this many days
  var ALL_MASTERED_NOTICE = 'Everything is mastered — showing a normal Strong-focus test';
  var NOTHING_DUE_NOTICE = 'Nothing is due for review — showing new questions first, then your weakest.';
  var DAY_MS = 86400000;

  var STATUSES = ['new', 'weak', 'learning', 'mastered'];
  var STATUS_LABEL = { 'new': 'New', weak: 'Weak', learning: 'Learning', mastered: 'Mastered' };

  // seen/correct/streak count every answer (accuracy %, Streak column).
  // daySeen/dayCorrect count only the first answer of each calendar day, so repeating a question
  // the same day (after seeing its answer) can't inflate readiness or hide a weak question.
  function blank() {
    return { reps: 0, lapses: 0, difficulty: null, stability: null,
      due: null, lastReview: null, lastGrade: null, lastAnswered: null,
      seen: 0, correct: 0, streak: 0, daySeen: 0, dayCorrect: 0 };
  }

  // First-answer-of-the-day counts. Records from before these existed fall back to all answers.
  function daily(p) {
    return typeof p.daySeen === 'number'
      ? { seen: p.daySeen, correct: p.dayCorrect || 0 }
      : { seen: p.seen || 0, correct: p.correct || 0 };
  }

  // Converts an old-shape record { seen, correct, streak, recent, lastSeen, lastCorrect }.
  // Runs lazily on read; the new shape is stored the next time the question is answered.
  // Stability is a rough seed that FSRS corrects after a review or two. An old Mastered question
  // (3 right in a row) stays Mastered until then, and each question is due one interval after it
  // was last seen, so upgrading doesn't make everything due at once.
  function migrateLegacy(p) {
    var streak = p.streak || 0;
    var stability = streak >= 3 ? MASTERY_DAYS : Math.max(1, streak * 3);
    var last = Date.parse(p.lastSeen);
    return {
      reps: p.seen || 0, lapses: 0, difficulty: 5, stability: stability,
      due: new Date((isNaN(last) ? Date.now() : last) + Math.max(1, Math.round(SET.fsrs.interval(stability))) * DAY_MS).toISOString(),
      lastReview: p.lastSeen || null,
      lastGrade: p.lastCorrect === false ? 1 : (p.lastCorrect === true ? 3 : null),
      seen: p.seen || 0, correct: p.correct || 0, streak: p.streak || 0
    };
  }

  function upgrade(p) { return p && p.reps === undefined ? migrateLegacy(p) : p; }

  function get(progress, id) {
    var p = progress && Object.prototype.hasOwnProperty.call(progress, id) && progress[id] ? progress[id] : null;
    return p ? upgrade(p) : blank();
  }

  function status(p) {
    p = upgrade(p);
    if (!p || !p.reps) return 'new';
    if (p.lastGrade === 1) return 'weak';
    if (p.stability >= MASTERY_DAYS) return 'mastered';
    return 'learning';
  }

  function weakness(p) {
    p = upgrade(p);
    if (!p || !p.reps) return 0.75;
    if (p.lastGrade === 1) return 1.0;
    var due = Date.parse(p.due);
    var daysOverdue = isNaN(due) ? 0 : (Date.now() - due) / DAY_MS;
    if (daysOverdue <= 0) return Math.min(0.3, ((p.difficulty || 5) / 10) * 0.3);
    return Math.min(0.8, daysOverdue / Math.max(p.stability || 1, 0.1));
  }

  function weight(p, F) { return 1 + (F - 1) * weakness(p); }

  function endOfDay(now) {
    var d = new Date(now === undefined || now === null ? Date.now() : now);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  // Needs review today: answered wrong last time, or FSRS due date is today or earlier (local time).
  function isDue(p, now) {
    p = upgrade(p);
    if (!p || !p.reps) return false;
    if (p.lastGrade === 1) return true;
    var due = Date.parse(p.due);
    return !isNaN(due) && due <= endOfDay(now);
  }

  function dueCount(questions, progress, now) {
    var c = { due: 0, 'new': 0 };
    questions.forEach(function (q) {
      var p = get(progress, q.id);
      if (!p.reps) c['new']++;
      else if (isDue(p, now)) c.due++;
    });
    return c;
  }

  // Chance of a right answer by pure guessing: 1 / (ways to choose k of n options).
  function guessRate(q) {
    var n = q.options.length, k = Math.max(1, q.answer.length), ways = 1;
    for (var i = 0; i < k; i++) ways = ways * (n - i) / (i + 1);
    return 1 / ways;
  }

  // Estimated chance of answering q right at time `at`.
  // Unseen: guessing. Seen: the average of FSRS recall (topped up by guessing on the part you'd forget)
  // and your smoothed accuracy on that question, so one lucky or unlucky answer can't dominate.
  function chanceRight(q, p, at) {
    var g = guessRate(q);
    p = upgrade(p);
    if (!p || !p.reps) return g;
    var last = Date.parse(p.lastReview);
    var elapsed = isNaN(last) ? 0 : Math.max(0, (at - last) / DAY_MS);
    var r = SET.fsrs.retrievability(elapsed, Math.max(p.stability || 0.1, 0.1));
    var memory = r + (1 - r) * g;
    var d = daily(p);
    var accuracy = (d.correct + g) / (d.seen + 1);
    return (memory + accuracy) / 2;
  }

  // Predicted mock-exam score. Topics are weighted like the exam (topicWeights, else bank share).
  // Returns { percent, seen, total, coverage, byTopic: [{ topic, percent, seen, total }] } (weakest topic first).
  function readiness(questions, progress, topicWeights, at) {
    at = at === undefined || at === null ? Date.now() : at;
    var topics = Object.create(null), seen = 0; // keyed by topic: no built-in names
    questions.forEach(function (q) {
      var p = get(progress, q.id);
      if (p.reps) seen++;
      var t = q.topic || 'Unlabeled';
      var row = topics[t] || (topics[t] = { topic: t, sum: 0, total: 0, seen: 0 });
      row.sum += chanceRight(q, p, at);
      row.total++;
      if (p.reps) row.seen++;
    });
    var wsum = 0, score = 0;
    var byTopic = Object.keys(topics).map(function (t) {
      var row = topics[t];
      var w = topicWeights ? Number(Object.prototype.hasOwnProperty.call(topicWeights, t) ? topicWeights[t] : 0) || 0 : row.total;
      var mean = row.sum / row.total;
      wsum += w; score += w * mean;
      return { topic: t, percent: Math.round(mean * 100), seen: row.seen, total: row.total };
    }).sort(function (a, b) { return a.percent - b.percent; });
    if (!wsum) { // weights name no topic in this bank: fall back to bank share
      score = 0; wsum = questions.length;
      Object.keys(topics).forEach(function (t) { score += topics[t].sum; });
    }
    return {
      percent: questions.length ? Math.round(score / wsum * 100) : 0,
      seen: seen, total: questions.length,
      coverage: pct(seen, questions.length),
      byTopic: byTopic
    };
  }

  // Expected score (%) on exactly these questions at time `at`: the mean chance of each being right.
  // Recorded when a mock exam starts, so it can later be compared with the real result.
  function expectedScore(questions, progress, at) {
    if (!questions.length) return 0;
    at = at === undefined || at === null ? Date.now() : at;
    var sum = 0;
    questions.forEach(function (q) { sum += chanceRight(q, get(progress, q.id), at); });
    return Math.round(sum / questions.length * 1000) / 10;
  }

  var PASS_CHANCE_MIN_COVERAGE = 30; // % of questions seen before chance of passing means anything

  var CALIBRATION_EXAMS = 5;   // most recent mock exams used
  var CALIBRATION_SHRINK = 2;  // pulls the correction towards 0 while there are few exams
  var CALIBRATION_CAP = 20;    // largest correction, in percentage points
  var CALIBRATION_MIN_ANSWERED = 0.8;

  // How far off the estimate has been on your own mock exams. Uses the latest exams that recorded a
  // prediction and were mostly answered. bias = sum(actual − predicted) / (exams + 2), capped at ±20.
  // Returns { bias, exams }.
  // The latest mock exams that recorded a prediction and were mostly answered.
  function calibrationExams(sessions) {
    return (sessions || []).filter(function (s) {
      return s && s.mode === 'exam' && typeof s.predicted === 'number' && typeof s.scorePercent === 'number' &&
        s.size > 0 && typeof s.answered === 'number' && s.answered / s.size >= CALIBRATION_MIN_ANSWERED;
    }).slice(-CALIBRATION_EXAMS);
  }

  function calibration(sessions) {
    var usable = calibrationExams(sessions);
    if (!usable.length) return { bias: 0, exams: 0 };
    var gap = usable.reduce(function (sum, s) { return sum + (s.scorePercent - s.predicted); }, 0);
    var bias = gap / (usable.length + CALIBRATION_SHRINK);
    bias = Math.max(-CALIBRATION_CAP, Math.min(CALIBRATION_CAP, bias));
    return { bias: (bias < 0 ? -1 : 1) * Math.round(Math.abs(bias)), exams: usable.length }; // round half away from 0, both directions
  }

  // Standard normal cumulative distribution (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
  function normalCdf(z) {
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * x);
    var erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }

  var MODEL_ERROR_DEFAULT = 8; // ± points assumed for the estimate itself until 3 mock exams can measure it
  var MODEL_ERROR_FLOOR = 3;   // never assume the estimate is better than this

  // Chance of reaching the pass mark on a mock exam of n questions from this set, given the
  // (calibrated) readiness %. Two sources of spread are combined:
  //   luck of the draw: sqrt(p(1 − p) / n)
  //   the estimate's own error: spread of (actual − predicted) over recent mock exams (8 points until 3 exist)
  // P = Φ((p − threshold) / spread), threshold = (questions needed − 0.5) / n.
  // Returns { percent, band: 'likely' | 'borderline' | 'unlikely', needed, modelError }.
  function passChance(readinessPct, n, passMarkPct, sessions) {
    n = Math.max(1, Math.floor(n));
    var p = Math.max(0, Math.min(1, readinessPct / 100));
    var needed = Math.min(n, Math.max(0, Math.ceil(passMarkPct / 100 * n - 1e-9)));
    var threshold = (needed - 0.5) / n;
    var gaps = calibrationExams(sessions).map(function (s) { return s.scorePercent - s.predicted; });
    var modelError = MODEL_ERROR_DEFAULT;
    if (gaps.length >= 3) {
      var mean = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length;
      var variance = gaps.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (gaps.length - 1);
      modelError = Math.max(MODEL_ERROR_FLOOR, Math.sqrt(variance));
    }
    var spread = Math.sqrt(p * (1 - p) / n + Math.pow(modelError / 100, 2));
    var percent = Math.round(normalCdf((p - threshold) / spread) * 100);
    return {
      percent: percent,
      band: percent >= 80 ? 'likely' : percent >= 50 ? 'borderline' : 'unlikely',
      needed: needed,
      modelError: Math.round(modelError * 10) / 10
    };
  }

  // Returns a new progress record with one counted review applied.
  // grade: 1 = Again (wrong), 2 = Hard, 3 = Good, 4 = Easy. maxIntervalDays caps the next interval.
  function record(p, grade, when, maxIntervalDays) {
    p = upgrade(p) || blank();
    when = when || new Date().toISOString();
    var next = SET.fsrs.next(
      { difficulty: p.difficulty, stability: p.stability, reps: p.reps, lapses: p.lapses, lastReview: p.lastReview, due: p.due },
      grade, when, maxIntervalDays
    );
    var correct = grade !== 1;
    var firstToday = !p.lastAnswered || !SET.fsrs.sameDay(Date.parse(p.lastAnswered), Date.parse(when));
    var d = daily(p);
    // A same-day right answer doesn't move the schedule, so lastReview stays at the counted review.
    return {
      reps: next.reps, lapses: next.lapses, difficulty: next.difficulty, stability: next.stability,
      due: next.due, lastReview: next.counted ? when : p.lastReview, lastGrade: grade, lastAnswered: when,
      seen: (p.seen || 0) + 1, correct: (p.correct || 0) + (correct ? 1 : 0),
      streak: correct ? (p.streak || 0) + 1 : 0,
      daySeen: d.seen + (firstToday ? 1 : 0), dayCorrect: d.correct + (firstToday && correct ? 1 : 0)
    };
  }

  // Whole days from now until an exam date ("YYYY-MM-DD", local midnight). null when unset or invalid.
  function daysUntil(examDate, now) {
    if (!examDate) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(examDate));
    if (!m) return null;
    var target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    var from = now === undefined || now === null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
    return Math.ceil((target - from) / DAY_MS);
  }

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Efraimidis–Spirakis weighted sampling without replacement.
  // key = u^(1/w); compared in log space (ln(u)/w) for numerical safety.
  function weightedSample(items, weightOf, n, rng) {
    rng = rng || Math.random;
    var keyed = items.map(function (item) {
      var u = rng();
      if (u <= 0) u = Number.MIN_VALUE;
      return { item: item, key: Math.log(u) / weightOf(item) };
    });
    keyed.sort(function (a, b) { return b.key - a.key; });
    var picked = keyed.slice(0, Math.max(0, Math.min(n, items.length))).map(function (k) { return k.item; });
    return shuffle(picked, rng);
  }

  // Picks practice question ids. Returns { ids, notice }.
  function selectPractice(questions, progress, n, focusIndex, rng) {
    var focus = FOCUS[focusIndex] || FOCUS[DEFAULT_FOCUS];
    var ids = questions.map(function (q) { return q.id; });
    n = Math.min(n, ids.length);
    var weightFor = function (F) { return function (id) { return weight(get(progress, id), F); }; };

    if (focus.dueFirst) {
      var due = [], fresh = [], rest = [];
      ids.forEach(function (id) {
        var p = get(progress, id);
        if (isDue(p)) due.push(id); else if (!p.reps) fresh.push(id); else rest.push(id);
      });
      var out = weightedSample(due, weightFor(focus.F), n, rng);
      if (out.length < n) out = out.concat(selectUniform(fresh, n - out.length, rng));
      if (out.length < n) out = out.concat(weightedSample(rest, weightFor(focus.F), n - out.length, rng));
      return { ids: shuffle(out, rng), notice: due.length ? null : NOTHING_DUE_NOTICE };
    }

    if (!focus.weakOnly) return { ids: weightedSample(ids, weightFor(focus.F), n, rng), notice: null };

    var pool = ids.filter(function (id) { return status(get(progress, id)) !== 'mastered'; });
    if (!pool.length) {
      return { ids: weightedSample(ids, weightFor(FOCUS[DEFAULT_FOCUS].F), n, rng), notice: ALL_MASTERED_NOTICE };
    }
    if (pool.length >= n) return { ids: weightedSample(pool, weightFor(focus.F), n, rng), notice: null };

    var inPool = {};
    pool.forEach(function (id) { inPool[id] = true; });
    var mastered = ids.filter(function (id) { return !inPool[id]; });
    var fill = weightedSample(mastered, weightFor(focus.F), n - pool.length, rng);
    return { ids: shuffle(pool.concat(fill), rng), notice: null };
  }

  function selectUniform(ids, n, rng) { return shuffle(ids, rng).slice(0, Math.min(n, ids.length)); }

  // Largest-remainder apportionment of n across keys by weight. Returns { key: int } summing to n.
  function apportion(keys, weights, n) {
    var total = keys.reduce(function (sum, k) { return sum + weights[k]; }, 0);
    var out = Object.create(null), rem = [], used = 0;
    keys.forEach(function (k) {
      var exact = total ? n * weights[k] / total : 0;
      out[k] = Math.floor(exact);
      used += out[k];
      rem.push({ k: k, r: exact - out[k] });
    });
    rem.sort(function (a, b) { return b.r - a.r || weights[b.k] - weights[a.k]; });
    for (var i = 0; used < n && rem.length; i = (i + 1) % rem.length) { out[rem[i].k]++; used++; }
    return out;
  }

  // Exam sampling that matches a topic blueprint.
  // targetWeights: { topic: percent }, or null for each topic's natural share of the bank.
  // Questions without a topic go in the "Unlabeled" bucket. Returns a shuffled id list.
  function selectStratified(questions, targetWeights, totalCount, rng) {
    var buckets = Object.create(null); // keyed by topic: no built-in names
    questions.forEach(function (q) {
      var t = q.topic || 'Unlabeled';
      (buckets[t] = buckets[t] || []).push(q.id);
    });
    var n = Math.max(0, Math.min(totalCount, questions.length));
    var weights = Object.create(null);
    Object.keys(buckets).forEach(function (t) {
      var w = targetWeights ? Number(Object.prototype.hasOwnProperty.call(targetWeights, t) ? targetWeights[t] : 0) : buckets[t].length;
      if (w > 0 && isFinite(w)) weights[t] = w;
    });
    var topics = Object.keys(weights);
    if (!topics.length) return selectUniform(questions.map(function (q) { return q.id; }), n, rng);

    // Fill quotas; a bucket too small for its quota hands the shortfall to the rest, by weight.
    var quota = Object.create(null), open = topics.slice(), left = n;
    topics.forEach(function (t) { quota[t] = 0; });
    while (left > 0 && open.length) {
      var share = apportion(open, weights, left);
      var full = [];
      left = 0;
      open.forEach(function (t) {
        var room = buckets[t].length - quota[t];
        var take = Math.min(share[t], room);
        quota[t] += take;
        left += share[t] - take;
        if (take >= room) full.push(t);
      });
      open = open.filter(function (t) { return full.indexOf(t) < 0; });
    }

    var picked = [];
    topics.forEach(function (t) { picked = picked.concat(selectUniform(buckets[t], quota[t], rng)); });
    // Topics weighted 0 (or left out) only top up an exam the weighted topics can't fill.
    if (picked.length < n) {
      var inPick = {};
      picked.forEach(function (id) { inPick[id] = true; });
      var rest = questions.map(function (q) { return q.id; }).filter(function (id) { return !inPick[id]; });
      picked = picked.concat(selectUniform(rest, n - picked.length, rng));
    }
    return shuffle(picked, rng);
  }

  function isCorrect(selected, answer) {
    if (!selected || selected.length !== answer.length) return false;
    var a = selected.slice().sort(function (x, y) { return x - y; });
    var b = answer.slice().sort(function (x, y) { return x - y; });
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Display order: order[displayPos] = original option index.
  function optionOrder(count, doShuffle, rng) {
    var order = [];
    for (var i = 0; i < count; i++) order.push(i);
    return doShuffle ? shuffle(order, rng) : order;
  }
  function toDisplay(order, originals) {
    return originals.map(function (o) { return order.indexOf(o); }).sort(function (x, y) { return x - y; });
  }
  function toOriginal(order, displayed) {
    return displayed.map(function (d) { return order[d]; });
  }

  function counts(questions, progress) {
    var c = { 'new': 0, weak: 0, learning: 0, mastered: 0, total: questions.length };
    questions.forEach(function (q) { c[status(get(progress, q.id))]++; });
    return c;
  }

  function pct(part, whole) { return whole ? Math.round((part / whole) * 100) : 0; }

  SET.weighting = {
    FOCUS: FOCUS,
    DEFAULT_FOCUS: DEFAULT_FOCUS,
    MASTERY_DAYS: MASTERY_DAYS,
    ALL_MASTERED_NOTICE: ALL_MASTERED_NOTICE,
    NOTHING_DUE_NOTICE: NOTHING_DUE_NOTICE,
    STATUSES: STATUSES,
    STATUS_LABEL: STATUS_LABEL,
    blank: blank,
    migrateLegacy: migrateLegacy,
    daily: daily,
    get: get,
    status: status,
    weakness: weakness,
    weight: weight,
    record: record,
    daysUntil: daysUntil,
    isDue: isDue,
    dueCount: dueCount,
    guessRate: guessRate,
    chanceRight: chanceRight,
    readiness: readiness,
    expectedScore: expectedScore,
    calibration: calibration,
    normalCdf: normalCdf,
    passChance: passChance,
    PASS_CHANCE_MIN_COVERAGE: PASS_CHANCE_MIN_COVERAGE,
    shuffle: shuffle,
    weightedSample: weightedSample,
    selectPractice: selectPractice,
    selectUniform: selectUniform,
    selectStratified: selectStratified,
    isCorrect: isCorrect,
    optionOrder: optionOrder,
    toDisplay: toDisplay,
    toOriginal: toOriginal,
    counts: counts,
    pct: pct
  };
})();
