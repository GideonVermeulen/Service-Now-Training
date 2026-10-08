/* fsrs.js — FSRS-5 spaced-repetition scheduler (state update + next due date)
 *
 * Formulas follow the open-spaced-repetition FSRS-5 algorithm
 * (https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm),
 * using its published 19 default weights. Parameters are not fitted per user.
 */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
    0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  var DECAY = -0.5;
  var FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81, so R(S, S) = 0.9
  var DESIRED_RETENTION = 0.9;
  var MIN_STABILITY = 0.1;
  var DAY_MS = 86400000;
  var AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

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

  // Days until retrievability falls to the desired retention.
  function interval(stability, retention) {
    var r = retention || DESIRED_RETENTION;
    return (stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
  }

  function initStability(g) { return Math.max(W[g - 1], MIN_STABILITY); }

  function rawInitDifficulty(g) { return W[4] - Math.exp(W[5] * (g - 1)) + 1; }
  function initDifficulty(g) { return clamp(rawInitDifficulty(g), 1, 10); }

  // Linear damping towards 10, then mean reversion towards D0(Easy).
  function nextDifficulty(d, g) {
    var delta = -W[6] * (g - 3);
    var damped = d + delta * (10 - d) / 9;
    return clamp(W[7] * rawInitDifficulty(EASY) + (1 - W[7]) * damped, 1, 10);
  }

  function recallStability(d, s, r, g) {
    var hard = g === HARD ? W[15] : 1;
    var easy = g === EASY ? W[16] : 1;
    return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
  }

  function forgetStability(d, s, r) {
    var sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    return Math.min(sf, s);
  }

  // FSRS-5 short-term stability, used here only for a same-day lapse.
  function shortTermStability(s, g) { return s * Math.exp(W[17] * (g - 3 + W[18])); }

  // Same calendar day in local time.
  function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

  function dueFrom(fromMs, s, maxIntervalDays, nowMs) {
    var days = Math.max(1, Math.round(interval(s)));
    var due = fromMs + days * DAY_MS;
    if (maxIntervalDays !== undefined && maxIntervalDays !== null && isFinite(maxIntervalDays)) {
      due = Math.min(due, nowMs + Math.max(1, Math.floor(maxIntervalDays)) * DAY_MS);
    }
    return due;
  }

  // state: { difficulty, stability, reps, lapses, lastReview, due } or null for a new card.
  // grade: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy.
  // maxIntervalDays: optional cap (e.g. days left until the exam); null = no cap.
  //
  // Repeats on the same day (as FSRS-4.5 treats them): a right answer leaves the memory state
  // and schedule unchanged, so stability can only grow across real days; a wrong answer still
  // counts and lowers stability (FSRS-5 short-term formula).
  function next(state, grade, now, maxIntervalDays) {
    var g = clamp(Math.round(Number(grade)) || GOOD, AGAIN, EASY);
    var nowMs = toMs(now);
    var st = state || {};
    var reps = st.reps || 0;
    var lapses = st.lapses || 0;
    var known = reps > 0 && typeof st.stability === 'number' && st.stability > 0 && typeof st.difficulty === 'number';
    var d, s;

    if (!known) {
      d = initDifficulty(g);
      s = initStability(g);
    } else {
      var hasLast = !!st.lastReview; // without one, treat this as the first counted review of the day
      var last = hasLast ? toMs(st.lastReview) : nowMs;
      var elapsed = Math.max(0, (nowMs - last) / DAY_MS);
      if (hasLast && sameDay(last, nowMs) && g !== AGAIN) {
        var keptDue = st.due ? toMs(st.due) : dueFrom(last, st.stability, null, nowMs);
        return {
          difficulty: st.difficulty,
          stability: st.stability,
          reps: reps + 1,
          lapses: lapses,
          due: new Date(maxIntervalDays !== undefined && maxIntervalDays !== null && isFinite(maxIntervalDays)
            ? Math.min(keptDue, nowMs + Math.max(1, Math.floor(maxIntervalDays)) * DAY_MS) : keptDue).toISOString(),
          lastReview: new Date(last).toISOString(),
          counted: false
        };
      }
      if (hasLast && sameDay(last, nowMs)) {
        s = shortTermStability(st.stability, g);
      } else {
        var r = retrievability(elapsed, st.stability);
        s = g === AGAIN ? forgetStability(st.difficulty, st.stability, r) : recallStability(st.difficulty, st.stability, r, g);
      }
      d = nextDifficulty(st.difficulty, g);
      if (g === AGAIN) lapses++;
    }
    s = Math.max(s, MIN_STABILITY);

    return {
      difficulty: d,
      stability: s,
      reps: reps + 1,
      lapses: lapses,
      due: new Date(dueFrom(nowMs, s, maxIntervalDays, nowMs)).toISOString(),
      lastReview: new Date(nowMs).toISOString(),
      counted: true
    };
  }

  SET.fsrs = {
    WEIGHTS: W,
    DESIRED_RETENTION: DESIRED_RETENTION,
    AGAIN: AGAIN, HARD: HARD, GOOD: GOOD, EASY: EASY,
    retrievability: retrievability,
    interval: interval,
    initStability: initStability,
    initDifficulty: initDifficulty,
    nextDifficulty: nextDifficulty,
    sameDay: sameDay,
    next: next
  };
})();
