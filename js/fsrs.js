/* fsrs.js — FSRS-5 spaced-repetition scheduler (state update + next due date)
 *
 * Formulas follow the open-spaced-repetition FSRS-5 algorithm
 * (https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm).
 * The 19 weights default to the published values; a personalised set fitted by optimizer.js
 * (Settings → Personalise scheduling) replaces them when saved in settings.fsrs.
 */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var DEFAULT_WEIGHTS = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
    0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  // Allowed range of each weight (as py-fsrs v5 clamps them), with a stability floor of MIN_STABILITY.
  var BOUNDS = [[0.1, 100], [0.1, 100], [0.1, 100], [0.1, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],
    [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2]];
  var DECAY = -0.5;
  var FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81, so R(S, S) = 0.9
  var DEFAULT_RETENTION = 0.9;
  var MIN_RETENTION = 0.8, MAX_RETENTION = 0.95;
  var MIN_STABILITY = 0.1;
  var DAY_MS = 86400000;
  var AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

  var W = DEFAULT_WEIGHTS.slice(); // weights in use
  var retention = DEFAULT_RETENTION;

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  // True for an array of 19 finite numbers within BOUNDS.
  function validWeights(w) {
    if (!Array.isArray(w) || w.length !== DEFAULT_WEIGHTS.length) return false;
    for (var i = 0; i < w.length; i++) {
      if (typeof w[i] !== 'number' || !isFinite(w[i]) || w[i] < BOUNDS[i][0] || w[i] > BOUNDS[i][1]) return false;
    }
    return true;
  }

  // Switches the weights in use; anything invalid (or null) means the published defaults.
  function useWeights(w) { W = validWeights(w) ? w.slice() : DEFAULT_WEIGHTS.slice(); }
  function weights() { return W.slice(); }

  function validRetention(r) { return typeof r === 'number' && isFinite(r) && r >= MIN_RETENTION && r <= MAX_RETENTION; }
  function useRetention(r) { retention = validRetention(r) ? r : DEFAULT_RETENTION; }

  function toMs(t) {
    if (t === undefined || t === null) return Date.now();
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    var ms = Date.parse(t);
    return isNaN(ms) ? Date.now() : ms;
  }

  // R(t, S): probability of recall after t days with stability S.
  function retrievability(elapsedDays, stability) {
    return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
  }

  // Days until retrievability falls to the target retention.
  function interval(stability, r) {
    return (stability / FACTOR) * (Math.pow(r || retention, 1 / DECAY) - 1);
  }

  function initStability(g, w) { return Math.max((w || W)[g - 1], MIN_STABILITY); }

  function rawInitDifficulty(g, w) { w = w || W; return w[4] - Math.exp(w[5] * (g - 1)) + 1; }
  function initDifficulty(g, w) { return clamp(rawInitDifficulty(g, w), 1, 10); }

  // Linear damping towards 10, then mean reversion towards D0(Easy).
  function nextDifficulty(d, g, w) {
    w = w || W;
    var delta = -w[6] * (g - 3);
    var damped = d + delta * (10 - d) / 9;
    return clamp(w[7] * rawInitDifficulty(EASY, w) + (1 - w[7]) * damped, 1, 10);
  }

  function recallStability(d, s, r, g, w) {
    var hard = g === HARD ? w[15] : 1;
    var easy = g === EASY ? w[16] : 1;
    return s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy);
  }

  function forgetStability(d, s, r, w) {
    var sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
    return Math.min(sf, s);
  }

  // FSRS-5 short-term stability, used here only for a same-day lapse.
  function shortTermStability(s, g, w) { return s * Math.exp(w[17] * (g - 3 + w[18])); }

  // One review applied to a memory state { s, d } (null = new card). The single place the
  // state update lives: live scheduling (next) and the optimiser's replay both use it.
  // Repeats on the same day (as FSRS-4.5 treats them): a right answer leaves the memory state
  // unchanged (counted: false), so stability can only grow across real days; a wrong answer still
  // counts and lowers stability (FSRS-5 short-term formula).
  function step(st, g, elapsedDays, sameDayAsLast, w) {
    w = w || W;
    if (!st) return { s: initStability(g, w), d: initDifficulty(g, w), counted: true };
    if (sameDayAsLast && g !== AGAIN) return { s: st.s, d: st.d, counted: false };
    var s;
    if (sameDayAsLast) s = shortTermStability(st.s, g, w);
    else {
      var r = retrievability(elapsedDays, st.s);
      s = g === AGAIN ? forgetStability(st.d, st.s, r, w) : recallStability(st.d, st.s, r, g, w);
    }
    return { s: Math.max(s, MIN_STABILITY), d: nextDifficulty(st.d, g, w), counted: true };
  }

  // Same calendar day in local time.
  function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

  function startOfTomorrow(nowMs) {
    var d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // Applies a "latest due" cap (ms timestamp, e.g. the day before an exam). The cap never pulls a
  // review earlier than the start of tomorrow, so a question just answered can't come straight back.
  function capDue(due, latestDueMs, nowMs) {
    if (typeof latestDueMs !== 'number' || !isFinite(latestDueMs)) return due;
    return Math.min(due, Math.max(latestDueMs, startOfTomorrow(nowMs)));
  }

  // Natural due date: one interval (at least a day) after fromMs.
  function naturalDue(fromMs, s) { return fromMs + Math.max(1, Math.round(interval(s))) * DAY_MS; }

  // state: { difficulty, stability, reps, lapses, lastReview, due } or null for a new card.
  // grade: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy.
  // latestDueMs: optional latest moment the next review may be due (ms); null = no cap.
  function next(state, grade, now, latestDueMs) {
    var g = clamp(Math.round(Number(grade)) || GOOD, AGAIN, EASY);
    var nowMs = toMs(now);
    var st = state || {};
    var reps = st.reps || 0;
    var lapses = st.lapses || 0;
    var known = reps > 0 && typeof st.stability === 'number' && st.stability > 0 && typeof st.difficulty === 'number';
    var res;

    if (!known) res = step(null, g, 0, false);
    else {
      var hasLast = !!st.lastReview; // without one, treat this as the first counted review of the day
      var last = hasLast ? toMs(st.lastReview) : nowMs;
      var same = hasLast && sameDay(last, nowMs);
      res = step({ s: st.stability, d: st.difficulty }, g, Math.max(0, (nowMs - last) / DAY_MS), same);
      if (!res.counted) {
        var keptDue = st.due ? toMs(st.due) : naturalDue(last, st.stability);
        return {
          difficulty: st.difficulty,
          stability: st.stability,
          reps: reps + 1,
          lapses: lapses,
          due: new Date(capDue(keptDue, latestDueMs, nowMs)).toISOString(),
          lastReview: new Date(last).toISOString(),
          counted: false
        };
      }
      if (g === AGAIN) lapses++;
    }

    return {
      difficulty: res.d,
      stability: res.s,
      reps: reps + 1,
      lapses: lapses,
      due: new Date(capDue(naturalDue(nowMs, res.s), latestDueMs, nowMs)).toISOString(),
      lastReview: new Date(nowMs).toISOString(),
      counted: true
    };
  }

  SET.fsrs = {
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    BOUNDS: BOUNDS,
    DEFAULT_RETENTION: DEFAULT_RETENTION,
    MIN_RETENTION: MIN_RETENTION,
    MAX_RETENTION: MAX_RETENTION,
    MIN_STABILITY: MIN_STABILITY,
    AGAIN: AGAIN, HARD: HARD, GOOD: GOOD, EASY: EASY,
    validWeights: validWeights,
    useWeights: useWeights,
    weights: weights,
    validRetention: validRetention,
    useRetention: useRetention,
    retention: function () { return retention; },
    retrievability: retrievability,
    interval: interval,
    initStability: initStability,
    initDifficulty: initDifficulty,
    nextDifficulty: nextDifficulty,
    step: step,
    sameDay: sameDay,
    startOfTomorrow: startOfTomorrow,
    capDue: capDue,
    naturalDue: naturalDue,
    next: next
  };

  // Load a personalised set (and target retention) saved in settings, if any.
  if (SET.storage && SET.storage.getSettings) {
    try {
      var saved = SET.storage.getSettings();
      useWeights(saved.fsrs && saved.fsrs.weights);
      useRetention(saved.targetRetention);
    } catch (e) { /* storage unavailable: defaults */ }
  }
})();
