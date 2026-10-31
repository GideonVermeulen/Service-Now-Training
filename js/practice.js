/* practice.js — practice mode (template behaviour + weighting) */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;

  var state = null; // { session, bank, qmap, progress }
  var GUESSED = 1;   // a right answer rated Guessed is scheduled as Again
  // Redo steps for a wrong or guessed question, after each miss: ~1 minute (past short-term memory),
  // then ~10 minutes (effortful recall), then once more at the end of the session. A miss after that
  // stops it for today; the normal schedule brings it back tomorrow.
  var REDO_STEPS_MS = [60000, 10 * 60000, Infinity];
  var MAX_REDOS = REDO_STEPS_MS.length;
  var MIN_GAP = 3;   // other answers between seeing a question and its redo
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
      queue: ids.slice(),   // the questions, each asked once; redos are slotted in between
      index: 0,             // position in queue (the question on screen when current is null)
      current: null,        // id of the redo on screen, or null for a question from queue
      redoAnswer: null,     // { selected, correct } for the redo on screen
      redo: {},             // id -> { tries, readyAt (ms; null = end of session), seenAt, capped }
      endPass: null,        // ids left in a "Do them now" pass over the remaining redos
      answered: 0,          // answers given so far, questions and redos
      phase: 'question',
      selected: [],
      order: null,
      roundAnswers: {},     // first answer to each question: { selected, correct }
      firstResults: {},
      guessed: {},          // right first time but rated Guessed
      testIds: [],
      masteredBefore: masteredBefore,
      summarySaved: false
    };
  }

  // Sessions saved by an older version (redo rounds) are moved onto the redo list: anything answered
  // so far and still wrong or guessed is ready at once.
  function upgradeSession(session, now) {
    if (session.redo) return session;
    session.redo = {};
    session.answered = session.answered || 0;
    session.current = null;
    session.redoAnswer = null;
    session.endPass = null;
    session.guessed = session.guessed || {};
    session.roundAnswers = session.roundAnswers || {};
    session.firstResults = session.firstResults || {};
    session.testIds = session.testIds || [];
    if (session.round > 1) {
      // A retry round kept only its own answers: the first answers are rebuilt from firstResults.
      session.roundAnswers = {};
      session.testIds.forEach(function (id) { session.roundAnswers[id] = { selected: [], correct: !!session.firstResults[id] }; });
      session.queue = session.testIds.slice();
      session.index = session.queue.length;
      session.phase = 'results';
    }
    var solved = session.solved || {};
    Object.keys(session.roundAnswers).forEach(function (id) {
      if (!solved[id] || session.guessed[id]) session.redo[id] = { tries: 0, readyAt: now, seenAt: -MIN_GAP, at: now };
    });
    delete session.round;
    delete session.solved;
    return session;
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

  // Sessions saved before the counted flag existed are counted.
  function counted(session) { return session.counted !== false; }

  // The question on screen: a redo, or the next one from the queue.
  function currentId(session) { return session.current || session.queue[session.index]; }

  // The answer given to the question on screen, if any.
  function given(session) {
    return session.current ? session.redoAnswer : session.roundAnswers[session.queue[session.index]];
  }

  // Records an answer to the question on screen. Only the first answer to a question in a counted
  // session updates progress; redos (and sessions started with counted: false) never do.
  // A wrong answer is recorded straight away as Again and queued for a redo; a right one waits for
  // applyRating (first answer) or markGuess (a redo, or an uncounted session).
  function applyAnswer(session, progress, q, selected, when) {
    var correct = W.isCorrect(selected, q.answer);
    var now = Date.parse(when);
    session.answered = (session.answered || 0) + 1;
    if (session.current) {
      session.redoBefore = session.redo[q.id] ? JSON.parse(JSON.stringify(session.redo[q.id])) : null;
      session.redoAnswer = { selected: selected.slice(), correct: correct };
      if (!correct) missRedo(session, q.id, now);
      return correct;
    }
    session.roundAnswers[q.id] = { selected: selected.slice(), correct: correct };
    session.firstResults[q.id] = correct;
    if (!correct) {
      if (counted(session)) recordAnswer(session.bankId, progress, q.id, 1, when, 'p');
      missRedo(session, q.id, now);
    }
    return correct;
  }

  // True when a just-answered question still needs a Guessed / Hard / Good / Easy rating.
  function needsRating(session, q) {
    var a = given(session);
    return counted(session) && !session.current && !!a && a.correct && q.id === currentId(session);
  }

  // True when a right answer that isn't rated (a redo, or an uncounted session) still needs a
  // Guessed / Knew it check, so a guess keeps coming back.
  function needsGuessCheck(session, q) {
    var a = given(session);
    return !needsRating(session, q) && !!a && a.correct && q.id === currentId(session);
  }

  function isGuessed(session, id) { return !!(session.guessed && session.guessed[id]); }

  // grade: 1 = Guessed (right, but scheduled as Again; still counts as right in the score),
  // 2 = Hard, 3 = Good, 4 = Easy. when: ISO time of the rating.
  function applyRating(session, progress, q, grade, when) {
    if (!needsRating(session, q)) return;
    if (grade === GUESSED) markGuess(session, q, true, Date.parse(when));
    recordAnswer(session.bankId, progress, q.id, grade, when, 'p');
  }

  // The answer to "Did you guess?" (or the Guessed rating). Never touches progress: a guess queues
  // the next redo step, "Knew it" clears the question for this session.
  function markGuess(session, q, guessed, now) {
    if (typeof now !== 'number') now = Date.now();
    if (guessed) {
      if (!session.current) session.guessed[q.id] = true;
      missRedo(session, q.id, now);
    } else {
      delete session.redo[q.id];
    }
  }

  // Queues the next redo step after a miss (wrong or guessed), or stops it for today after the last.
  function missRedo(session, id, now) {
    var r = session.redo[id];
    var tries = r ? r.tries + (session.current === id ? 1 : 0) : 0;
    if (tries >= MAX_REDOS) { session.redo[id] = { tries: tries, readyAt: null, seenAt: session.answered, at: now, capped: true }; return; }
    var wait = REDO_STEPS_MS[tries];
    session.redo[id] = { tries: tries, readyAt: isFinite(wait) ? now + wait : null, seenAt: session.answered, at: now };
  }

  // True when a redo was missed on an earlier day than now: the normal schedule has it from here.
  function expired(session, id, now) {
    var at = session.redo[id].at;
    return !SET.fsrs.sameDay(typeof at === 'number' ? at : Date.parse(session.startedAt), now);
  }

  // Redos still to do (not stopped for today), soonest first; end-of-session ones last.
  function pendingRedos(session) {
    return Object.keys(session.redo || {}).filter(function (id) { return !session.redo[id].capped; }).sort(function (a, b) {
      var x = session.redo[a].readyAt, y = session.redo[b].readyAt;
      return (x === null ? Infinity : x) - (y === null ? Infinity : y);
    });
  }

  // Questions stopped for today after the last redo step.
  function cappedRedos(session) {
    return Object.keys(session.redo || {}).filter(function (id) { return session.redo[id].capped; });
  }

  // The redo to slot in now, or null: ready, and at least MIN_GAP other answers since it was seen.
  function readyRedo(session, now) {
    var ready = pendingRedos(session).filter(function (id) {
      var r = session.redo[id];
      return r.readyAt !== null && r.readyAt <= now && session.answered - r.seenAt >= MIN_GAP;
    });
    return ready.length ? ready[0] : null;
  }

  // Moves on from the question on screen: a ready redo first, then the next question; during a
  // "Do them now" pass, the next redo in the pass. skipIndex: the question on screen was removed
  // from queue, so index already points at the next one. Returns false when the results are reached.
  function advance(session, now, skipIndex) {
    if (!session.current && !skipIndex) session.index++;
    session.current = null;
    session.redoAnswer = null;
    session.selected = [];
    session.order = null;
    if (session.endPass) {
      while (session.endPass.length && !(session.redo[session.endPass[0]] && !session.redo[session.endPass[0]].capped)) session.endPass.shift();
      if (session.endPass.length) { session.current = session.endPass.shift(); session.phase = 'question'; return true; }
      finishRound(session);
      return false;
    }
    var redo = session.index < session.queue.length ? readyRedo(session, now) : null;
    if (redo) { session.current = redo; session.phase = 'question'; return true; }
    if (session.index < session.queue.length) { session.phase = 'question'; return true; }
    finishRound(session);
    return false;
  }

  // "Do them now": goes through every remaining redo once, without waiting.
  function startEndPass(session) {
    var ids = pendingRedos(session);
    if (!ids.length) return false;
    session.endPass = ids.slice(1);
    session.current = ids[0];
    session.redoAnswer = null;
    session.phase = 'question';
    session.selected = [];
    session.order = null;
    return true;
  }

  function finishRound(session) {
    session.testIds = session.queue.filter(function (id) { return session.roundAnswers[id]; });
    session.phase = 'results';
    session.current = null;
    session.redoAnswer = null;
    session.endPass = null;
    session.selected = [];
    session.order = null;
  }

  // Answered right without a guess, or cleared in a redo.
  function isDone(session, id) { return !!session.roundAnswers[id] && !(session.redo && session.redo[id]); }

  function firstAttemptCorrect(session) {
    return session.testIds.filter(function (id) { return session.firstResults[id]; }).length;
  }

  // Redos left today in the active session for a bank (0 when there is none). Redos missed on an
  // earlier day don't count: those questions are due through the normal schedule instead.
  // countedOnly: skip uncounted sessions (an exam retake doesn't hold up the day's goal).
  function redosLeft(session, bankId, countedOnly) {
    if (!session || session.type !== 'practice' || session.bankId !== bankId || !session.redo) return 0;
    if (countedOnly && !counted(session)) return 0;
    var now = Date.now();
    return pendingRedos(session).filter(function (id) { return !expired(session, id, now); }).length;
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
    var now = Date.now();
    upgradeSession(session, now);
    var qmap = SET.bank.byId(bank);
    // The bank may have been updated since the session was saved.
    var exists = function (id) { return !!qmap[id]; };
    // Redos missed on an earlier day are dropped: those questions are due through the normal schedule.
    Object.keys(session.redo).forEach(function (id) { if (!exists(id) || expired(session, id, now)) delete session.redo[id]; });
    if (session.endPass) session.endPass = session.endPass.filter(exists);
    if (session.current && !session.redo[session.current]) {
      session.current = null;
      session.redoAnswer = null;
      session.endPass = null;
      if (session.phase !== 'results') { session.phase = 'question'; session.selected = []; session.order = null; }
    }
    var current = session.queue[session.index];
    var before = session.queue.slice(0, session.index).filter(exists).length;
    session.queue = session.queue.filter(exists);
    session.testIds = session.testIds.filter(exists);
    if (session.phase !== 'results') {
      if (current && exists(current)) session.index = session.queue.indexOf(current);
      else {
        session.index = before;
        if (!session.current && session.phase !== 'question') { session.phase = 'question'; session.selected = []; session.order = null; }
      }
    }
    state = { session: session, bank: bank, qmap: qmap, progress: SET.storage.getProgress(bankId), main: main };
    if (session.phase !== 'results' && !session.current && session.index >= session.queue.length) {
      if (!Object.keys(session.roundAnswers).some(exists)) {
        SET.storage.clearActive();
        SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
        return;
      }
      completeRound();
    }
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
    var q = state.qmap[currentId(s)];
    var settings = SET.storage.getSettings();
    if (!s.order || s.order.length !== q.options.length) {
      s.order = W.optionOrder(q.options.length, settings.shuffleOptions || !!s.current); // redos: always shuffled
      s.selected = [];
      save();
    }
    var need = q.answer.length;
    var rating = s.phase === 'rate';
    var checking = s.phase === 'check';
    var locked = s.phase === 'feedback' || rating || checking;
    var isLast = s.endPass ? !s.endPass.length
      : s.current ? s.index >= s.queue.length : s.index === s.queue.length - 1;
    var ans = given(s);
    var selected = locked && ans ? ans.selected : s.selected;

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

    if (locked && ans) {
      var letters = W.toDisplay(s.order, q.answer).map(SET.bank.letter).join(', ');
      feedback.classList.add(ans.correct ? 'is-correct' : 'is-wrong');
      feedback.appendChild(el('span', { class: 'feedback__icon', 'aria-hidden': 'true' }, ans.correct ? '✓' : '✕'));
      feedback.appendChild(el('span', null, ans.correct ? 'Correct!' : 'Incorrect — the answer is ' + letters));
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

    // A right first answer is rated instead of a plain Next; the rating drives the review schedule.
    // A right redo (or a right answer in an uncounted session) only asks whether it was a guess.
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
        rateBtn(GUESSED, 'Guessed', 'Right, but a guess: comes back in a minute, and tomorrow'),
        rateBtn(2, 'Hard', 'Got there, but it was a struggle'),
        rateBtn(3, 'Good', 'Recalled it with some thought'),
        rateBtn(4, 'Easy', 'Knew it instantly'));
    } else if (checking) {
      rateRow = el('div', { class: 'actions actions--wrap rate-row', role: 'group', tabindex: '-1', 'aria-label': 'Did you guess? Keys 1 and 2.' },
        el('span', { class: 'muted small' }, 'Did you guess?'),
        choiceBtn('1', 'Guessed', null, 'Comes back for another redo', function () { check(q, true); }),
        choiceBtn('2', 'Knew it', null, 'Done with this question for today', function () { check(q, false); }));
    }

    var redo = s.current ? s.redo[s.current] : null;
    var waiting = pendingRedos(s).filter(function (id) { return id !== s.current; }).length;
    var label = (redo ? 'Redo ' + (redo.tries + 1) + ' of ' + MAX_REDOS : 'First attempt') + (counted(s) ? '' : ' · not counted');
    var done = Math.min(s.index, s.queue.length) + (locked && !s.current ? 1 : 0);

    state.main.appendChild(el('section', { class: 'screen screen--session' },
      el('div', { class: 'session-head' },
        el('div', { class: 'session-head__info' },
          el('p', { class: 'eyebrow' }, state.bank.title),
          el('h1', { class: 'session-title', tabindex: '-1' },
            el('span', { class: 'num' }, redo ? 'Redo: a question from earlier' : 'Question ' + (s.index + 1) + ' of ' + s.queue.length)),
          el('span', { class: 'pill' + (redo ? ' pill--accent' : '') }, label),
          waiting ? el('span', { class: 'muted small num' }, ' ' + ui.plural(waiting, 'redo') + ' waiting') : null
        ),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: endEarly }, 'End test')
      ),
      ui.progressBar(done, s.queue.length, 'Progress through the questions'),
      s.notice && !s.current && s.index === 0 ? ui.callout(s.notice, 'info') : null,
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
    if (!s.current && counted(s)) updateProgress(function (progress) { applyAnswer(s, progress, q, s.selected, when); });
    else applyAnswer(s, state.progress, q, s.selected, when);
    s.phase = needsRating(s, q) ? 'rate' : needsGuessCheck(s, q) ? 'check' : 'feedback';
    save();
    draw();
  }

  // The question on screen was deleted: drop it from the test and carry on with the next one.
  // Returns false when nothing is left and the user was sent back to the bank.
  function dropCurrent(id) {
    var s = state.session;
    var pos = s.queue.indexOf(id);
    if (pos >= 0 && pos < s.index) s.index--; // a redo of an earlier question
    s.queue = s.queue.filter(function (x) { return x !== id; });
    s.testIds = s.testIds.filter(function (x) { return x !== id; });
    if (s.endPass) s.endPass = s.endPass.filter(function (x) { return x !== id; });
    delete s.roundAnswers[id];
    delete s.firstResults[id];
    delete s.guessed[id];
    delete s.redo[id];
    if (s.current === id) { s.current = null; s.redoAnswer = null; }
    if (!s.queue.length && !Object.keys(s.roundAnswers).length) {
      SET.storage.clearActive();
      SET.ui.go('#/bank/' + encodeURIComponent(s.bankId));
      return false;
    }
    if (!advance(s, Date.now(), true)) completeRound();
    save();
    return true;
  }

  // The answer to the question on screen was corrected: forget this answer and ask it again.
  function askAgain(id) {
    var s = state.session;
    if (s.current === id) {
      s.redoAnswer = null;
      if (s.redoBefore) s.redo[id] = s.redoBefore;
    } else {
      delete s.roundAnswers[id];
      delete s.firstResults[id];
      delete s.guessed[id];
      delete s.redo[id];
    }
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
    if (!advance(s, Date.now())) completeRound();
    save();
    draw();
    SET.ui.focusHeading();
  }

  // Shows the results and saves the session summary (once, from the first answers only).
  function completeRound() {
    var s = state.session;
    finishRound(s);
    if (counted(s) && !s.summarySaved && s.testIds.length) {
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
      var q = state.qmap[currentId(s)];
      if (s.phase === 'rate') { // answered right but not rated yet: count it as Good
        var when = new Date().toISOString();
        updateProgress(function (progress) { applyRating(s, progress, q, 3, when); });
      }
      if (s.phase === 'check') markGuess(s, q, true); // not confirmed: keep it for another redo
      if (!Object.keys(s.roundAnswers).length) {
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

  // Redos left after the questions: when the next is ready (a short break helps it stick), with
  // "Do them now" to go through them all at once instead of waiting.
  function redoPanel(pending) {
    var ui = SET.ui, el = ui.el, s = state.session;
    var text = el('p', { class: 'num' });
    var nextAt = s.redo[pending[0]].readyAt;
    var update = function () {
      var left = nextAt === null ? 0 : nextAt - Date.now();
      text.textContent = left > 0
        ? ui.plural(pending.length, 'redo') + ' left · next ready in ' + ui.clock(Math.ceil(left / 1000)) +
          '. A short break helps it stick: come back later, or do them now.'
        : ui.plural(pending.length, 'redo') + ' left · ready now.';
      if (left <= 0 && timerHandle) { clearInterval(timerHandle); timerHandle = null; ui.announce('Your redos are ready.'); }
    };
    update();
    if (nextAt !== null && nextAt > Date.now()) timerHandle = setInterval(update, 1000);
    return ui.callout(text, 'info');
  }

  function drawResults() {
    var ui = SET.ui, el = ui.el;
    var s = state.session, bank = state.bank, progress = state.progress;
    var total = s.testIds.length;
    var solved = s.testIds.filter(function (id) { return isDone(s, id); }).length;
    var pending = pendingRedos(s);
    var capped = cappedRedos(s);
    var firstCorrect = firstAttemptCorrect(s);
    var firstPct = W.pct(firstCorrect, total);
    var missedFirst = s.testIds.filter(function (id) { return !s.firstResults[id] || isGuessed(s, id); });

    var counts = W.counts(bank.questions, progress);
    var overallSolved = counts.learning + counts.mastered;
    var masteredGain = s.testIds.filter(function (id) {
      return !s.masteredBefore[id] && W.status(W.get(progress, id)) === 'mastered';
    }).length;
    var stillWeak = s.testIds.filter(function (id) { return W.status(W.get(progress, id)) === 'weak'; }).length;

    var heading = pending.length ? 'Test complete · ' + ui.plural(pending.length, 'redo') + ' left'
      : !missedFirst.length ? 'All questions answered correctly'
      : capped.length ? 'Test complete' : 'All redos cleared';

    var cleared = missedFirst.filter(function (id) { return isDone(s, id); }).length;
    var redoLine = missedFirst.length
      ? 'Redos: ' + cleared + ' cleared' + (pending.length ? ' · ' + pending.length + ' left' : '') +
        (capped.length ? ' · ' + capped.length + ' back tomorrow' : '')
      : null;

    var missedList = null;
    if (missedFirst.length) {
      missedList = el('details', { class: 'card disclosure' },
        el('summary', null, 'Questions missed or guessed (' + missedFirst.length + ')'),
        el('ol', { class: 'review-list' }, missedFirst.map(function (id) {
          var q = state.qmap[id], a = s.roundAnswers[id] || { selected: [], correct: !!s.firstResults[id] };
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
          redoLine ? el('p', { class: 'muted small num' }, redoLine) : null,
          counted(s) ? null : el('p', { class: 'muted small' }, 'Exam retake: not counted towards your scores or review schedule.')
        )
      ),
      missedList,
      pending.length ? redoPanel(pending)
        : capped.length ? ui.callout(ui.plural(capped.length, 'question') + ' still wrong or guessed after ' + MAX_REDOS + ' redos. ' +
          (counted(s) ? 'They come back tomorrow, when recalling them does the most good.' : 'Practise them again later.'), 'info')
        : null,
      el('div', { class: 'actions actions--wrap' },
        pending.length ? el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          startEndPass(s); save(); draw(); ui.focusHeading();
        } }, 'Do them now') : null,
        pending.length ? el('a', { class: 'btn', href: bankHash }, 'Come back later') : null,
        !pending.length && capped.length ? el('button', { class: 'btn', type: 'button', onclick: function () {
          SET.storage.clearActive();
          start(bank.id, { ids: capped, counted: false });
        } }, 'Practise the ones still wrong') : null,
        el('button', { class: 'btn' + (pending.length ? ' btn-ghost' : ' btn-primary'), type: 'button', onclick: function () {
          var size = Math.min(s.size || total, bank.questions.length);
          SET.storage.clearActive();
          start(bank.id, { size: size, focus: s.focus !== null ? s.focus : SET.storage.getSettings().focus, topics: s.topics });
        } }, 'New test'),
        pending.length ? null : el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
          SET.storage.clearActive();
          ui.go(bankHash);
        } }, 'Back to bank')
      )
    ));
  }

  SET.practice = {
    GUESSED: GUESSED,
    REDO_STEPS_MS: REDO_STEPS_MS,
    MAX_REDOS: MAX_REDOS,
    MIN_GAP: MIN_GAP,
    createSession: createSession,
    upgradeSession: upgradeSession,
    applyAnswer: applyAnswer,
    needsRating: needsRating,
    needsGuessCheck: needsGuessCheck,
    applyRating: applyRating,
    markGuess: markGuess,
    currentId: currentId,
    pendingRedos: pendingRedos,
    cappedRedos: cappedRedos,
    readyRedo: readyRedo,
    advance: advance,
    startEndPass: startEndPass,
    finishRound: finishRound,
    isDone: isDone,
    firstAttemptCorrect: firstAttemptCorrect,
    redosLeft: redosLeft,
    examCap: examCap,
    topicPool: topicPool,
    start: start,
    render: render
  };
})();
