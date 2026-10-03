/* practice.js — practice mode (template behaviour + weighting) */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;

  var state = null; // { session, bank, qmap, progress }

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
      history: [],
      testIds: [],
      masteredBefore: masteredBefore,
      summarySaved: false
    };
  }

  // Records an answer. Only round 1 updates progress (retry rounds are not counted).
  function applyAnswer(session, progress, q, selected, when) {
    var correct = W.isCorrect(selected, q.answer);
    session.roundAnswers[q.id] = { selected: selected.slice(), correct: correct };
    if (correct) session.solved[q.id] = true;
    if (session.round === 1) {
      session.firstResults[q.id] = correct;
      progress[q.id] = W.record(W.get(progress, q.id), correct, when);
    }
    return correct;
  }

  function finishRound(session) {
    var answered = session.queue.filter(function (id) { return session.roundAnswers[id]; });
    if (session.round === 1) session.testIds = answered.slice();
    if (answered.length) {
      session.history.push({
        round: session.round,
        answered: answered.length,
        correct: answered.filter(function (id) { return session.roundAnswers[id].correct; }).length,
        solvedTotal: session.testIds.filter(function (id) { return session.solved[id]; }).length
      });
    }
    session.queue = answered;
    session.phase = 'results';
    session.selected = [];
    session.order = null;
  }

  function startRetry(session, rng) {
    var unsolved = session.testIds.filter(function (id) { return !session.solved[id]; });
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

  // opts: { size, focus } for a weighted test, or { ids } for a fixed list.
  function start(bankId, opts) {
    var bank = SET.storage.getBank(bankId);
    if (!bank) return;
    SET.ui.ensureNoActive(function () {
      var progress = SET.storage.getProgress(bankId);
      var ids, notice = null, focus = null;
      if (opts.ids) {
        ids = W.shuffle(opts.ids);
      } else {
        focus = typeof opts.focus === 'number' ? opts.focus : SET.storage.getSettings().focus;
        var pick = W.selectPractice(bank.questions, progress, opts.size, focus);
        ids = pick.ids;
        notice = pick.notice;
      }
      if (!ids.length) return;
      var session = createSession(bank, ids, progress, { focus: focus, notice: notice });
      SET.storage.setActive(session);
      SET.ui.go('#/bank/' + encodeURIComponent(bankId) + '/practice', true);
    });
  }

  /* ---------- rendering ---------- */

  function save() { SET.storage.setActive(state.session); }

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
    session.queue = session.queue.filter(exists);
    session.testIds = session.testIds.filter(exists);
    if (session.phase !== 'results' && session.index >= session.queue.length) {
      if (session.round === 1 && !Object.keys(session.roundAnswers).some(exists)) {
        SET.storage.clearActive();
        SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
        return;
      }
      finishRound(session);
    }
    state = { session: session, bank: bank, qmap: qmap, progress: SET.storage.getProgress(bankId), main: main };
    draw();
  }

  function draw() {
    var s = state.session;
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
      s.order = W.optionOrder(q.options.length, settings.shuffleOptions);
      s.selected = [];
      save();
    }
    var need = q.answer.length;
    var locked = s.phase === 'feedback';
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
      if (q.unverified) after.appendChild(ui.unverifiedNote());
    }

    submitBtn = el('button', {
      class: 'btn btn-primary', type: 'button', disabled: selected.length !== need,
      onclick: function () { submit(q); }
    }, 'Submit answer');
    nextBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: next },
      isLast ? 'See results' : 'Next question');

    var roundLabel = s.round === 1 ? 'First attempt' : 'Retry round ' + (s.round - 1);
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
        el('div', { class: 'actions' }, locked ? nextBtn : submitBtn)
      )
    ));
    if (locked) nextBtn.focus();
  }

  function submit(q) {
    var s = state.session;
    if (s.phase !== 'question' || s.selected.length !== q.answer.length) return;
    applyAnswer(s, state.progress, q, s.selected, new Date().toISOString());
    if (s.round === 1) SET.storage.saveProgress(state.bank.id, state.progress, true);
    s.phase = 'feedback';
    save();
    draw();
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
    if (s.round === 1 && !s.summarySaved && s.testIds.length) {
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

  function drawResults() {
    var ui = SET.ui, el = ui.el;
    var s = state.session, bank = state.bank, progress = state.progress;
    var total = s.testIds.length;
    var solved = s.testIds.filter(function (id) { return s.solved[id]; }).length;
    var unsolved = total - solved;
    var firstCorrect = firstAttemptCorrect(s);
    var firstPct = W.pct(firstCorrect, total);

    var counts = W.counts(bank.questions, progress);
    var overallSolved = counts.learning + counts.mastered;
    var masteredGain = s.testIds.filter(function (id) {
      return !s.masteredBefore[id] && W.status(W.get(progress, id)) === 'mastered';
    }).length;
    var stillWeak = s.testIds.filter(function (id) { return W.status(W.get(progress, id)) === 'weak'; }).length;

    var heading = unsolved === 0 ? 'All questions answered correctly'
      : s.round === 1 ? 'Test complete' : 'Retry round ' + (s.round - 1) + ' complete';

    var history = s.history.map(function (h) {
      return h.round === 1
        ? 'Attempt 1: ' + W.pct(h.correct, h.answered) + '%'
        : 'Retry ' + (h.round - 1) + ': ' + W.pct(h.solvedTotal, total) + '% overall';
    }).join(' · ');

    var missed = s.queue.filter(function (id) { return s.roundAnswers[id] && !s.roundAnswers[id].correct; });
    var missedList = null;
    if (missed.length) {
      missedList = el('details', { class: 'card disclosure' },
        el('summary', null, 'Questions missed this round (' + missed.length + ')'),
        el('ol', { class: 'review-list' }, missed.map(function (id) {
          var q = state.qmap[id];
          return ui.reviewItem(q, s.roundAnswers[id].selected, { status: 'wrong' });
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
          history ? el('p', { class: 'muted small num' }, history) : null
        )
      ),
      missedList,
      el('div', { class: 'actions actions--wrap' },
        unsolved ? el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          startRetry(s); save(); draw(); ui.focusHeading();
        } }, 'Retry ' + unsolved + ' incorrect') : null,
        el('button', { class: 'btn' + (unsolved ? '' : ' btn-primary'), type: 'button', onclick: function () {
          var size = Math.min(s.size || total, bank.questions.length);
          SET.storage.clearActive();
          start(bank.id, { size: size, focus: s.focus !== null ? s.focus : SET.storage.getSettings().focus });
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
    finishRound: finishRound,
    startRetry: startRetry,
    firstAttemptCorrect: firstAttemptCorrect,
    start: start,
    render: render
  };
})();
