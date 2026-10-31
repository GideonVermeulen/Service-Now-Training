/* practice.js — practice mode (template behaviour + weighting) */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;

  var state = null; // { session, bank, qmap, progress }
  var GUESSED = 1;                 // a right answer rated Guessed is scheduled as Again
  var MAX_REDOS = 3;               // redo rounds after the first attempt
  var REDO_DELAY_MS = 5 * 60000;   // wait before a redo round, so it isn't straight from short-term memory
  var timerHandle = null, keyHandler = null;

  /* ---------- pure session logic (unit tested) ---------- */

  function createSession(bank, ids, progress, opts) {
    var masteredBefore = {};
    ids.forEach(function (id) { masteredBefore[id] = W.status(W.get(progress, id)) === 'mastered'; });
    return {
      type: 'practice',
      id: SET.storage.newId(),
      bankId: bank.id,
      startedAt: new Date().toISOString(),
      focus: typeof opts.focus === 'number' ? opts.focus : null,
      topics: opts.topics && opts.topics.length ? opts.topics.slice() : null,
      plan: !!opts.plan,
      counted: opts.counted !== false,
      size: ids.length,
      notice: opts.notice || null,
      round: 1,
      queue: ids.slice(),
      index: 0,
      phase: 'question',
      selected: [],
      order: null,
      roundAnswers: {},
      firstResults: {},
      solved: {},
      guessed: {},
      redoReadyAt: null,
      history: [],
      testIds: [],
      masteredBefore: masteredBefore,
      summarySaved: false
    };
  }

  // The exam-date cap for one question, worked out at answer time from the bank's current exam date,
  // so a date changed mid-session is respected. (Sessions saved by older versions may still carry a
  // maxIntervalDays field; it is ignored.)
  function examCap(bankId, id, when) {
    var entry = SET.storage.getEntry(bankId);
    return W.examCap(entry && entry.examDate, id, when);
  }

  // Applies one counted answer to progress and adds it to the review log.
  // mode: 'p' (practice) or 'e' (exam).
  function recordAnswer(bankId, progress, id, grade, when, mode) {
    progress[id] = W.record(W.get(progress, id), grade, when, examCap(bankId, id, when));
    SET.storage.logReview(bankId, id, when, grade, mode);
  }

  // Records an answer. Only round 1 of a counted session updates progress (retry rounds, and sessions
  // started with counted: false, are not counted or logged).
  // A wrong answer is recorded straight away as Again; a right one waits for applyRating.
  function applyAnswer(session, progress, q, selected, when) {
    var correct = W.isCorrect(selected, q.answer);
    session.roundAnswers[q.id] = { selected: selected.slice(), correct: correct };
    if (correct) session.solved[q.id] = true;
    if (session.round === 1) {
      session.firstResults[q.id] = correct;
      if (!correct && counted(session)) recordAnswer(session.bankId, progress, q.id, 1, when, 'p');
    }
    return correct;
  }

  // True when a just-answered question still needs a Guessed / Hard / Good / Easy rating.
  function needsRating(session, q) {
    var a = session.roundAnswers[q.id];
    return counted(session) && session.round === 1 && !!a && a.correct;
  }

  // True when a right answer that isn't rated (redo rounds, uncounted sessions) still needs a
  // Guessed / Knew it check, so a guess keeps coming back in the redo rounds.
  function needsGuessCheck(session, q) {
    var a = session.roundAnswers[q.id];
    return !needsRating(session, q) && !!a && a.correct;
  }

  // Sessions saved before the counted flag existed are counted.
  function counted(session) { return session.counted !== false; }

  function isGuessed(session, id) { return !!(session.guessed && session.guessed[id]); }

  // Answered right without a guess: needs no redo.
  function isDone(session, id) { return !!session.solved[id] && !isGuessed(session, id); }

  // grade: 1 = Guessed (right, but scheduled as Again; still counts as right in the score),
  // 2 = Hard, 3 = Good, 4 = Easy.
  function applyRating(session, progress, q, grade, when) {
    if (!needsRating(session, q)) return;
    if (grade === GUESSED) markGuess(session, q, true);
    recordAnswer(session.bankId, progress, q.id, grade, when, 'p');
  }

  // Never touches progress: only decides whether the question comes back in the next redo round.
  function markGuess(session, q, guessed) {
    session.guessed = session.guessed || {};
    if (guessed) session.guessed[q.id] = true;
    else delete session.guessed[q.id];
  }

  // Questions still wrong or guessed, for the next redo round.
  function toRedo(session) {
    return session.testIds.filter(function (id) { return !isDone(session, id); });
  }

  // True while another redo round may start (up to MAX_REDOS after the first attempt).
  function canRedo(session) { return session.round <= MAX_REDOS && toRedo(session).length > 0; }

  function finishRound(session, now) {
    var answered = session.queue.filter(function (id) { return session.roundAnswers[id]; });
    if (session.round === 1) session.testIds = answered.slice();
    if (answered.length) {
      session.history.push({
        round: session.round,
        answered: answered.length,
        correct: answered.filter(function (id) { return session.roundAnswers[id].correct; }).length,
        solvedTotal: session.testIds.filter(function (id) { return isDone(session, id); }).length
      });
    }
    session.queue = answered;
    session.phase = 'results';
    session.selected = [];
    session.order = null;
    session.redoReadyAt = (typeof now === 'number' ? now : Date.now()) + REDO_DELAY_MS;
  }

  function startRetry(session, rng) {
    var unsolved = toRedo(session);
    session.round++;
    session.queue = W.shuffle(unsolved, rng);
    session.index = 0;
    session.roundAnswers = {};
    session.phase = 'question';
    session.selected = [];
    session.order = null;
  }

  function firstAttemptCorrect(session) {
    return session.testIds.filter(function (id) { return session.firstResults[id]; }).length;
  }

  /* ---------- starting ---------- */

  // Questions in the chosen topics (null or [] = all). Untopiced questions are "Unlabeled".
  function topicPool(questions, topics) {
    if (!topics || !topics.length) return questions;
    return questions.filter(function (q) { return topics.indexOf(q.topic || 'Unlabeled') >= 0; });
  }

  // opts: { size, focus, topics } for a weighted test, { ids } for a fixed list, or
  // { plan: { due: true, newCount } } for today's session (everything due plus newCount new questions).
  // counted: false (with ids) for a retake that leaves progress, the review log and stats alone.
  function start(bankId, opts) {
    var bank = SET.storage.getBank(bankId);
    if (!bank) return;
    SET.ui.ensureNoActive(function () {
      var progress = SET.storage.getProgress(bankId);
      var ids, notice = null, focus = null, topics = null;
      if (opts.ids) {
        ids = W.shuffle(opts.ids);
      } else if (opts.plan) {
        ids = W.selectPractice(bank.questions, progress, 0, null, null, { plan: opts.plan }).ids;
      } else {
        focus = typeof opts.focus === 'number' ? opts.focus : SET.storage.getSettings().focus;
        topics = opts.topics && opts.topics.length ? opts.topics : null;
        var pool = topicPool(bank.questions, topics);
        if (topics && !pool.length) { topics = null; pool = bank.questions; } // topics renamed or removed since
        var pick = W.selectPractice(pool, progress, opts.size, focus);
        ids = pick.ids;
        notice = pick.notice;
      }
      if (!ids.length) return;
      var session = createSession(bank, ids, progress, { focus: focus, notice: notice, topics: topics, plan: !!opts.plan, counted: opts.counted });
      SET.storage.setActive(session);
      SET.ui.go('#/bank/' + encodeURIComponent(bankId) + '/practice', true);
    });
  }

  /* ---------- rendering ---------- */

  function save() { SET.storage.setActive(state.session); }

  // Re-reads stored progress, applies one change, saves. Another tab (or the editor) may have saved
  // progress since this page loaded; writing back an old in-memory copy would undo their answers.
  function updateProgress(change) {
    state.progress = SET.storage.getProgress(state.bank.id);
    change(state.progress);
    SET.storage.saveProgress(state.bank.id, state.progress, true);
  }

  function render(main, bankId) {
    var bank = SET.storage.getBank(bankId);
    if (!bank) { SET.ui.go('#/'); return; }
    var session = SET.storage.getActive();
    if (!session || session.bankId !== bankId || session.type !== 'practice') {
      SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
      return;
    }
    var qmap = SET.bank.byId(bank);
    // The bank may have been updated since the session was saved.
    var exists = function (id) { return !!qmap[id]; };
    var current = session.queue[session.index];
    var before = session.queue.slice(0, session.index).filter(exists).length;
    session.queue = session.queue.filter(exists);
    session.testIds = session.testIds.filter(exists);
    if (session.phase !== 'results') {
      if (current && exists(current)) session.index = session.queue.indexOf(current);
      else {
        session.index = before;
        if (session.phase !== 'question') { session.phase = 'question'; session.selected = []; session.order = null; }
      }
    }
    if (session.phase !== 'results' && session.index >= session.queue.length) {
      if (session.round === 1 && !Object.keys(session.roundAnswers).some(exists)) {
        SET.storage.clearActive();
        SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
        return;
      }
      finishRound(session);
    }
    state = { session: session, bank: bank, qmap: qmap, progress: SET.storage.getProgress(bankId), main: main };
    SET.ui.onLeave(stopListening);
    draw();
  }

  // Stops the redo countdown and the rating keys (on every redraw and when leaving the page).
  function stopListening() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  }

  // Number keys for the buttons on screen: keys[n] runs for key n. Ignored while typing or in a dialog.
  function listenKeys(keys) {
    keyHandler = function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      if (e.target && e.target.closest && e.target.closest('input, textarea, select, dialog')) return;
      var fn = keys[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    document.addEventListener('keydown', keyHandler);
  }

  function draw() {
    var s = state.session;
    stopListening();
    SET.ui.clear(state.main);
    if (s.phase === 'results') drawResults();
    else drawQuestion();
  }

  function drawQuestion() {
    var ui = SET.ui, el = ui.el;
    var s = state.session;
    var q = state.qmap[s.queue[s.index]];
    var settings = SET.storage.getSettings();
    if (!s.order || s.order.length !== q.options.length) {
      s.order = W.optionOrder(q.options.length, settings.shuffleOptions || s.round > 1); // redo: always shuffled
      s.selected = [];
      save();
    }
    var need = q.answer.length;
    var rating = s.phase === 'rate';
    var checking = s.phase === 'check';
    var locked = s.phase === 'feedback' || rating || checking;
    var isLast = s.index === s.queue.length - 1;
    var given = s.roundAnswers[q.id];
    var selected = locked && given ? given.selected : s.selected;

    var submitBtn, nextBtn;
    var options = ui.optionList(q, s.order, {
      selected: selected,
      reveal: locked,
      onPick: function (orig) {
        if (s.phase !== 'question') return;
        var i = s.selected.indexOf(orig);
        if (need === 1) s.selected = [orig];
        else if (i >= 0) s.selected.splice(i, 1);
        else if (s.selected.length < need) s.selected.push(orig);
        options.update(s.selected);
        submitBtn.disabled = s.selected.length !== need;
        save();
      }
    });

    var feedback = el('div', { class: 'feedback', 'aria-live': 'polite', role: 'status' });
    var after = el('div', { class: 'after' });

    if (locked && given) {
      var letters = W.toDisplay(s.order, q.answer).map(SET.bank.letter).join(', ');
      feedback.classList.add(given.correct ? 'is-correct' : 'is-wrong');
      feedback.appendChild(el('span', { class: 'feedback__icon', 'aria-hidden': 'true' }, given.correct ? '✓' : '✕'));
      feedback.appendChild(el('span', null, given.correct ? 'Correct!' : 'Incorrect — the answer is ' + letters));
      if (q.explanation) after.appendChild(ui.explanation(q.explanation));
      if (q.unverified) after.appendChild(ui.unverifiedNote({ bankId: state.bank.id, q: q }));
      after.appendChild(el('p', { class: 'small' }, el('button', { class: 'link', type: 'button', onclick: function () {
        SET.editor.open(state.bank.id, q.id).then(function (done) {
          if (!done) return;
          state.bank = SET.storage.getBank(state.bank.id);
          state.qmap = SET.bank.byId(state.bank);
          state.progress = SET.storage.getProgress(state.bank.id); // the editor may have reset or removed this question
          if (done === 'deleted' && !dropCurrent(q.id)) return;
          if (done === 'reset') askAgain(q.id);
          draw();
        });
      } }, 'Spotted a mistake? Edit this question')));
    }

    submitBtn = el('button', {
      class: 'btn btn-primary', type: 'button', disabled: selected.length !== need,
      onclick: function () { submit(q); }
    }, 'Submit answer');
    nextBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: next },
      isLast ? 'See results' : 'Next question');

    // A right first-round answer is rated instead of a plain Next; the rating drives the review schedule.
    // A right answer in a redo round (or an uncounted session) only asks whether it was a guess.
    // Number keys pick the buttons; nothing has focus by default, so Enter can't rate by habit.
    var rateRow = null, keys = {};
    var choiceBtn = function (key, label, sub, hint, onclick) {
      keys[key] = onclick;
      return el('button', { class: 'btn', type: 'button', title: hint + ' (key ' + key + ')', 'aria-keyshortcuts': key, onclick: onclick },
        label, sub ? el('span', { class: 'btn__sub num' }, sub) : null);
    };
    if (rating) {
      var when = new Date().toISOString();
      var rateBtn = function (grade, label, hint) {
        return choiceBtn(String(grade), label, nextReviewLabel(q.id, grade, when), hint, function () { rate(q, grade); });
      };
      rateRow = el('div', { class: 'actions actions--wrap rate-row', role: 'group', tabindex: '-1', 'aria-label': 'How did you get it right? Keys 1 to 4.' },
        el('span', { class: 'muted small' }, 'How did you get it right?'),
        rateBtn(GUESSED, 'Guessed', 'Right, but a guess: comes back tomorrow and in the redo round'),
        rateBtn(2, 'Hard', 'Got there, but it was a struggle'),
        rateBtn(3, 'Good', 'Recalled it with some thought'),
        rateBtn(4, 'Easy', 'Knew it instantly'));
    } else if (checking) {
      rateRow = el('div', { class: 'actions actions--wrap rate-row', role: 'group', tabindex: '-1', 'aria-label': 'Did you guess? Keys 1 and 2.' },
        el('span', { class: 'muted small' }, 'Did you guess?'),
        choiceBtn('1', 'Guessed', null, 'Comes back in the next redo round', function () { check(q, true); }),
        choiceBtn('2', 'Knew it', null, 'Done with this question for this test', function () { check(q, false); }));
    }

    var roundLabel = (s.round === 1 ? 'First attempt' : 'Redo round ' + (s.round - 1) + ' of ' + MAX_REDOS) + (counted(s) ? '' : ' · not counted');
    var done = s.index + (locked ? 1 : 0);

    state.main.appendChild(el('section', { class: 'screen screen--session' },
      el('div', { class: 'session-head' },
        el('div', { class: 'session-head__info' },
          el('p', { class: 'eyebrow' }, state.bank.title),
          el('h1', { class: 'session-title', tabindex: '-1' },
            el('span', { class: 'num' }, 'Question ' + (s.index + 1) + ' of ' + s.queue.length)),
          el('span', { class: 'pill' + (s.round > 1 ? ' pill--accent' : '') }, roundLabel)
        ),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: endEarly }, 'End test')
      ),
      ui.progressBar(done, s.queue.length, 'Progress through this round'),
      s.notice && s.round === 1 && s.index === 0 ? ui.callout(s.notice, 'info') : null,
      el('article', { class: 'card question-card' },
        need > 1 ? el('p', { class: 'choose' }, '(Choose ' + need + ')') : null,
        el('h2', { class: 'q-text' }, q.question),
        options.node,
        feedback,
        after,
        rateRow || el('div', { class: 'actions' }, locked ? nextBtn : submitBtn)
      )
    ));
    if (rateRow) { listenKeys(keys); rateRow.focus(); }
    else if (locked) nextBtn.focus();
  }

  // When the question would come back with this grade, e.g. "1d" or "~3w". From 3 days the date is
  // fuzzed, so it can land a day or so either side.
  function nextReviewLabel(id, grade, when) {
    var p = W.record(W.get(state.progress, id), grade, when, examCap(state.bank.id, id, when));
    var days = Math.max(1, W.calendarDays(when, p.due));
    var text = days < 14 ? days + 'd' : days < 60 ? Math.round(days / 7) + 'w' : days < 365 ? Math.round(days / 30) + 'mo' : Math.round(days / 365 * 10) / 10 + 'y';
    return (days >= 3 ? '~' : '') + text;
  }

  function submit(q) {
    var s = state.session;
    if (s.phase !== 'question' || s.selected.length !== q.answer.length) return;
    var when = new Date().toISOString();
    if (s.round === 1 && counted(s)) updateProgress(function (progress) { applyAnswer(s, progress, q, s.selected, when); });
    else applyAnswer(s, state.progress, q, s.selected, when);
    s.phase = needsRating(s, q) ? 'rate' : needsGuessCheck(s, q) ? 'check' : 'feedback';
    save();
    draw();
  }

  // The question on screen was deleted: drop it from the test and carry on with the next one.
  // Returns false when nothing is left and the user was sent back to the bank.
  function dropCurrent(id) {
    var s = state.session;
    s.queue = s.queue.filter(function (x) { return x !== id; });
    s.testIds = s.testIds.filter(function (x) { return x !== id; });
    delete s.roundAnswers[id];
    delete s.firstResults[id];
    delete s.solved[id];
    if (s.guessed) delete s.guessed[id];
    s.selected = [];
    s.order = null;
    if (!s.queue.length && !s.testIds.length && s.round === 1 && !Object.keys(s.roundAnswers).length) {
      SET.storage.clearActive();
      SET.ui.go('#/bank/' + encodeURIComponent(s.bankId));
      return false;
    }
    if (s.index >= s.queue.length) completeRound();
    else s.phase = 'question';
    save();
    return true;
  }

  // The answer to the question on screen was corrected: forget this round's answer and ask it again.
  function askAgain(id) {
    var s = state.session;
    delete s.roundAnswers[id];
    delete s.firstResults[id];
    delete s.solved[id];
    if (s.guessed) delete s.guessed[id];
    s.phase = 'question';
    s.selected = [];
    s.order = null;
    save();
  }

  function rate(q, grade) {
    var s = state.session;
    if (s.phase !== 'rate') return;
    var when = new Date().toISOString();
    updateProgress(function (progress) { applyRating(s, progress, q, grade, when); });
    next();
  }

  function check(q, guessed) {
    var s = state.session;
    if (s.phase !== 'check') return;
    markGuess(s, q, guessed);
    next();
  }

  function next() {
    var s = state.session;
    s.index++;
    s.selected = [];
    s.order = null;
    if (s.index >= s.queue.length) completeRound();
    else s.phase = 'question';
    save();
    draw();
    SET.ui.focusHeading();
  }

  function completeRound() {
    var s = state.session;
    finishRound(s);
    if (s.round === 1 && counted(s) && !s.summarySaved && s.testIds.length) {
      var correct = firstAttemptCorrect(s);
      var summary = {
        id: s.id, mode: 'practice', startedAt: s.startedAt, endedAt: new Date().toISOString(),
        size: s.testIds.length, firstAttemptCorrect: correct,
        scorePercent: W.pct(correct, s.testIds.length)
      };
      if (s.focus !== null) summary.focus = s.focus;
      SET.storage.addSession(s.bankId, summary);
      s.summarySaved = true;
    }
  }

  function endEarly() {
    var s = state.session;
    SET.ui.confirm('End this test?', 'Only the questions you have answered will count.', 'End test').then(function (ok) {
      if (!ok) return;
      if (s.phase === 'rate') { // answered right but not rated yet: count it as Good
        var when = new Date().toISOString();
        updateProgress(function (progress) { applyRating(s, progress, state.qmap[s.queue[s.index]], 3, when); });
      }
      if (s.phase === 'check') markGuess(s, state.qmap[s.queue[s.index]], true); // not confirmed: keep it for the next redo
      var answeredAny = Object.keys(s.roundAnswers).length > 0;
      if (s.round === 1 && !answeredAny) {
        SET.storage.clearActive();
        SET.ui.go('#/bank/' + encodeURIComponent(s.bankId));
        return;
      }
      completeRound();
      save();
      draw();
      SET.ui.focusHeading();
    });
  }

  // The wait before the next redo round (skippable: the Redo button works any time), or why there
  // is none left. Questions still wrong or guessed come back tomorrow through the normal schedule.
  function redoPanel(unsolved, guessedCount) {
    var ui = SET.ui, el = ui.el, s = state.session;
    if (!unsolved) return null;
    if (!canRedo(s)) {
      return ui.callout(el('p', null, ui.plural(unsolved, 'question') + ' still wrong or guessed after ' + MAX_REDOS +
        ' redo rounds. ' + (counted(s) ? 'They come back tomorrow.' : 'Practise them again later.')), 'info');
    }
    var what = guessedCount ? 'wrong or guessed' : 'wrong';
    var text = el('p', { class: 'num' });
    var update = function () {
      var left = typeof s.redoReadyAt === 'number' ? s.redoReadyAt - Date.now() : 0;
      if (left > 0) {
        text.textContent = 'Redo the ' + ui.plural(unsolved, 'question') + ' you got ' + what + ' in ' + ui.clock(Math.ceil(left / 1000)) +
          '. A short break helps it stick; you can leave this page and come back, or start now.';
        return;
      }
      text.textContent = 'Ready: redo the ' + ui.plural(unsolved, 'question') + ' you got ' + what + '.';
      if (timerHandle) { clearInterval(timerHandle); timerHandle = null; ui.announce('Your redo round is ready.'); }
    };
    update();
    if (typeof s.redoReadyAt === 'number' && s.redoReadyAt > Date.now()) timerHandle = setInterval(update, 1000);
    return ui.callout(text, 'info');
  }

  function drawResults() {
    var ui = SET.ui, el = ui.el;
    var s = state.session, bank = state.bank, progress = state.progress;
    var total = s.testIds.length;
    var solved = s.testIds.filter(function (id) { return isDone(s, id); }).length;
    var unsolved = total - solved;
    var guessedCount = s.testIds.filter(function (id) { return s.solved[id] && isGuessed(s, id); }).length;
    var firstCorrect = firstAttemptCorrect(s);
    var firstPct = W.pct(firstCorrect, total);

    var counts = W.counts(bank.questions, progress);
    var overallSolved = counts.learning + counts.mastered;
    var masteredGain = s.testIds.filter(function (id) {
      return !s.masteredBefore[id] && W.status(W.get(progress, id)) === 'mastered';
    }).length;
    var stillWeak = s.testIds.filter(function (id) { return W.status(W.get(progress, id)) === 'weak'; }).length;

    var heading = unsolved === 0 ? 'All questions answered correctly'
      : unsolved === guessedCount && s.round === 1 ? 'All right, ' + ui.plural(guessedCount, 'guess', 'guesses') + ' to redo'
      : s.round === 1 ? 'Test complete' : 'Redo round ' + (s.round - 1) + ' complete';

    var history = s.history.map(function (h) {
      return h.round === 1
        ? 'Attempt 1: ' + W.pct(h.correct, h.answered) + '%'
        : 'Redo ' + (h.round - 1) + ': ' + W.pct(h.solvedTotal, total) + '% overall';
    }).join(' · ');

    var missed = s.queue.filter(function (id) { return s.roundAnswers[id] && (!s.roundAnswers[id].correct || isGuessed(s, id)); });
    var missedList = null;
    if (missed.length) {
      missedList = el('details', { class: 'card disclosure' },
        el('summary', null, 'Questions missed or guessed this round (' + missed.length + ')'),
        el('ol', { class: 'review-list' }, missed.map(function (id) {
          var q = state.qmap[id], a = s.roundAnswers[id];
          return ui.reviewItem(q, a.selected, { status: a.correct ? 'correct' : 'wrong', verify: { bankId: bank.id, q: q } });
        }))
      );
    }

    var bankHash = '#/bank/' + encodeURIComponent(bank.id);
    state.main.appendChild(el('section', { class: 'screen' },
      el('p', { class: 'eyebrow' }, bank.title),
      el('h1', { tabindex: '-1' }, heading),
      el('div', { class: 'card result-hero' },
        ui.scoreRing(firstPct, firstPct >= 70 ? 'ok' : firstPct >= 50 ? 'warn' : 'bad', 'first try'),
        el('div', { class: 'result-hero__body' },
          el('p', { class: 'result-hero__label' }, 'First-attempt score: ' + firstCorrect + ' of ' + total + ' correct'),
          el('dl', { class: 'facts' },
            ui.fact('This test', solved + ' / ' + total),
            ui.fact('Overall progress', overallSolved + ' / ' + counts.total + ' (' + W.pct(overallSolved, counts.total) + '%)'),
            ui.fact('Mastered this test', '+' + masteredGain),
            ui.fact('Still weak', String(stillWeak))
          ),
          history ? el('p', { class: 'muted small num' }, history) : null,
          counted(s) ? null : el('p', { class: 'muted small' }, 'Exam retake: not counted towards your scores or review schedule.')
        )
      ),
      missedList,
      redoPanel(unsolved, guessedCount),
      el('div', { class: 'actions actions--wrap' },
        canRedo(s) ? el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          startRetry(s); save(); draw(); ui.focusHeading();
        } }, 'Redo ' + unsolved + (guessedCount ? ' wrong & guessed' : ' incorrect')) : null,
        el('button', { class: 'btn' + (canRedo(s) ? '' : ' btn-primary'), type: 'button', onclick: function () {
          var size = Math.min(s.size || total, bank.questions.length);
          SET.storage.clearActive();
          start(bank.id, { size: size, focus: s.focus !== null ? s.focus : SET.storage.getSettings().focus, topics: s.topics });
        } }, 'New test'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          SET.storage.clearActive();
          ui.go(bankHash);
        } }, 'Back to bank')
      )
    ));
  }

  SET.practice = {
    createSession: createSession,
    applyAnswer: applyAnswer,
    GUESSED: GUESSED,
    MAX_REDOS: MAX_REDOS,
    REDO_DELAY_MS: REDO_DELAY_MS,
    needsRating: needsRating,
    needsGuessCheck: needsGuessCheck,
    applyRating: applyRating,
    markGuess: markGuess,
    isDone: isDone,
    toRedo: toRedo,
    canRedo: canRedo,
    examCap: examCap,
    topicPool: topicPool,
    finishRound: finishRound,
    startRetry: startRetry,
    firstAttemptCorrect: firstAttemptCorrect,
    start: start,
    render: render
  };
})();
