/* weighting.js — weakness score, weights, weighted sampling, mastery status */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var FOCUS = [
    { label: 'Even', F: 1, hint: 'Every question is equally likely.' },
    { label: 'Light', F: 2, hint: 'Weak questions are up to 2× as likely.' },
    { label: 'Strong', F: 4, hint: 'Weak questions are up to 4× as likely.' },
    { label: 'Intense', F: 8, hint: 'Weak questions are up to 8× as likely.' },
    { label: 'Weak only', F: 4, weakOnly: true, hint: 'Only questions you haven’t mastered, topped up if there aren’t enough.' }
  ];
  var DEFAULT_FOCUS = 2;
  var MASTERED_STREAK = 3;
  var RECENT_KEEP = 10;
  var ALL_MASTERED_NOTICE = 'Everything is mastered — showing a normal Strong-focus test';

  var STATUSES = ['new', 'weak', 'learning', 'mastered'];
  var STATUS_LABEL = { 'new': 'New', weak: 'Weak', learning: 'Learning', mastered: 'Mastered' };

  function blank() {
    return { seen: 0, correct: 0, streak: 0, recent: [], lastSeen: null, lastCorrect: null };
  }

  function get(progress, id) {
    return progress && Object.prototype.hasOwnProperty.call(progress, id) && progress[id] ? progress[id] : blank();
  }

  function status(p) {
    if (!p || !p.seen) return 'new';
    if (p.streak >= MASTERED_STREAK) return 'mastered';
    if (p.lastCorrect === false) return 'weak';
    return 'learning';
  }

  function weakness(p) {
    if (!p || !p.seen) return 0.75;
    if (p.streak >= MASTERED_STREAK) return 0;
    var last5 = (p.recent || []).slice(-5);
    var w;
    if (last5.length) {
      var right = last5.filter(Boolean).length;
      w = 1 - right / last5.length;
    } else {
      w = p.lastCorrect === false ? 1 : 0;
    }
    if (p.lastCorrect === false) w = Math.max(w, 0.6);
    return w;
  }

  function weight(p, F) { return 1 + (F - 1) * weakness(p); }

  // Returns a new progress record with one counted attempt applied.
  function record(p, correct, when) {
    var n = p ? JSON.parse(JSON.stringify(p)) : blank();
    if (!Array.isArray(n.recent)) n.recent = [];
    n.seen = (n.seen || 0) + 1;
    if (correct) { n.correct = (n.correct || 0) + 1; n.streak = (n.streak || 0) + 1; }
    else { n.correct = n.correct || 0; n.streak = 0; }
    n.recent.push(!!correct);
    if (n.recent.length > RECENT_KEEP) n.recent = n.recent.slice(-RECENT_KEEP);
    n.lastSeen = when || new Date().toISOString();
    n.lastCorrect = !!correct;
    return n;
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
    MASTERED_STREAK: MASTERED_STREAK,
    ALL_MASTERED_NOTICE: ALL_MASTERED_NOTICE,
    STATUSES: STATUSES,
    STATUS_LABEL: STATUS_LABEL,
    blank: blank,
    get: get,
    status: status,
    weakness: weakness,
    weight: weight,
    record: record,
    shuffle: shuffle,
    weightedSample: weightedSample,
    selectPractice: selectPractice,
    selectUniform: selectUniform,
    isCorrect: isCorrect,
    optionOrder: optionOrder,
    toDisplay: toDisplay,
    toOriginal: toOriginal,
    counts: counts,
    pct: pct
  };
})();
