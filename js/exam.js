/* exam.js — exam simulation mode */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;

  var state = null;      // { session, bank, qmap, main }
  var lastResult = null; // results of the most recent submitted exam (in memory only)
  var timerHandle = null;

  /* ---------- pure logic (unit tested) ---------- */

  function createSession(bank, opts, rng, now) {
    now = now || Date.now();
    var ids = W.selectUniform(bank.questions.map(function (q) { return q.id; }), opts.count, rng);
    var orders = {};
    var qmap = SET.bank.byId(bank);
    ids.forEach(function (id) { orders[id] = W.optionOrder(qmap[id].options.length, opts.shuffle !== false, rng); });
    return {
      type: 'exam',
      id: SET.storage.newId(),
      bankId: bank.id,
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      ids: ids,
      orders: orders,
      answers: {},
      flags: {},
      index: 0,
      timeLimitMinutes: opts.timeLimitMinutes,
      passMarkPercent: opts.passMarkPercent,
      endsAt: opts.timeLimitMinutes > 0 ? now + opts.timeLimitMinutes * 60000 : null,
      warned: 0
    };
  }

  // Scores the exam and applies every answer to progress. Unanswered = wrong (not recorded).
  function grade(session, qmap, progress, now) {
    now = now || Date.now();
    var when = new Date(now).toISOString();
    var items = session.ids.map(function (id) {
      var q = qmap[id];
      var sel = session.answers[id] || [];
      var answered = sel.length > 0;
      var correct = answered && W.isCorrect(sel, q.answer);
      if (answered) progress[id] = W.record(W.get(progress, id), correct, when);
      return { id: id, selected: sel, answered: answered, correct: correct, flagged: !!session.flags[id] };
    });
    var correct = items.filter(function (i) { return i.correct; }).length;
    var end = session.endsAt ? Math.min(now, session.endsAt) : now;
    var scorePercent = W.pct(correct, items.length);
    return {
      bankId: session.bankId,
      items: items,
      correct: correct,
      total: items.length,
      scorePercent: scorePercent,
      passMarkPercent: session.passMarkPercent,
      passed: scorePercent >= session.passMarkPercent,
      timeUsedSec: Math.max(0, Math.round((end - session.startedMs) / 1000)),
      summary: {
        id: session.id, mode: 'exam', startedAt: session.startedAt, endedAt: new Date(now).toISOString(),
        size: items.length, firstAttemptCorrect: correct, scorePercent: scorePercent,
        passed: scorePercent >= session.passMarkPercent,
        timeUsedSec: Math.max(0, Math.round((end - session.startedMs) / 1000)),
        passMarkPercent: session.passMarkPercent
      }
    };
  }

  /* ---------- starting ---------- */

  function start(bankId, opts) {
    var bank = SET.storage.getBank(bankId);
    if (!bank) return;
    SET.ui.ensureNoActive(function () {
      var session = createSession(bank, {
        count: opts.count, timeLimitMinutes: opts.timeLimitMinutes, passMarkPercent: opts.passMarkPercent,
        shuffle: SET.storage.getSettings().shuffleOptions
      });
      lastResult = null;
      SET.storage.setActive(session);
      SET.ui.go('#/bank/' + encodeURIComponent(bankId) + '/exam', true);
    });
  }

  /* ---------- rendering ---------- */

  function save() { SET.storage.setActive(state.session); }

  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  function render(main, bankId) {
    var bank = SET.storage.getBank(bankId);
    if (!bank) { SET.ui.go('#/'); return; }
    var qmap = SET.bank.byId(bank);
    var session = SET.storage.getActive();
    if (session && session.bankId === bankId && session.type === 'exam') {
      session.ids = session.ids.filter(function (id) { return !!qmap[id]; });
      if (!session.ids.length) {
        SET.storage.clearActive();
        SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
        return;
      }
      session.index = Math.min(session.index, session.ids.length - 1);
      state = { session: session, bank: bank, qmap: qmap, main: main };
      SET.ui.onLeave(stopTimer);
      if (session.endsAt && Date.now() >= session.endsAt) {
        finish('Time ran out while you were away, so the exam was submitted automatically.');
        return;
      }
      drawExam();
      startTimer();
      return;
    }
    if (lastResult && lastResult.bankId === bankId) {
      state = { session: null, bank: bank, qmap: qmap, main: main };
      drawResults();
      return;
    }
    SET.ui.go('#/bank/' + encodeURIComponent(bankId), true);
  }

  function startTimer() {
    stopTimer();
    tick();
    timerHandle = setInterval(tick, 250);
  }

  function tick() {
    var s = state && state.session;
    if (!s) { stopTimer(); return; }
    var now = Date.now();
    var label, cls = '';
    if (s.endsAt) {
      var left = Math.max(0, s.endsAt - now);
      label = SET.ui.clock(Math.ceil(left / 1000));
      if (left <= 60000) cls = 'timer--danger';
      else if (left <= 300000) cls = 'timer--warn';
      if (left <= 300000 && s.warned < 1) { s.warned = 1; save(); if (left > 60000) SET.ui.announce('5 minutes remaining.'); }
      if (left <= 60000 && s.warned < 2) { s.warned = 2; save(); SET.ui.announce('1 minute remaining.'); }
      SET.ui.setTimer(label, cls, 'Time remaining');
      if (left <= 0) { finish('Time is up — your exam was submitted automatically.'); }
    } else {
      label = SET.ui.clock(Math.floor((now - s.startedMs) / 1000));
      SET.ui.setTimer(label, '', 'Time elapsed (untimed)');
    }
  }

  function drawExam() {
    var ui = SET.ui, el = ui.el;
    var s = state.session;
    var id = s.ids[s.index];
    var q = state.qmap[id];
    var need = q.answer.length;
    var answeredCount = s.ids.filter(function (x) { return s.answers[x] && s.answers[x].length; }).length;

    SET.ui.clear(state.main);

    var options = ui.optionList(q, s.orders[id], {
      selected: s.answers[id] || [],
      onPick: function (orig) {
        var cur = (s.answers[id] || []).slice();
        var i = cur.indexOf(orig);
        if (need === 1) cur = i >= 0 ? [] : [orig];
        else if (i >= 0) cur.splice(i, 1);
        else if (cur.length < need) cur.push(orig);
        if (cur.length) s.answers[id] = cur; else delete s.answers[id];
        options.update(cur);
        save();
        refreshPalette();
      }
    });

    var flagBtn = el('button', {
      class: 'btn btn-sm btn-flag' + (s.flags[id] ? ' is-on' : ''), type: 'button', 'aria-pressed': s.flags[id] ? 'true' : 'false',
      onclick: function () {
        if (s.flags[id]) delete s.flags[id]; else s.flags[id] = true;
        flagBtn.classList.toggle('is-on', !!s.flags[id]);
        flagBtn.setAttribute('aria-pressed', s.flags[id] ? 'true' : 'false');
        flagBtn.lastChild.textContent = s.flags[id] ? 'Flagged' : 'Flag for review';
        save();
        refreshPalette();
      }
    }, el('span', { 'aria-hidden': 'true', class: 'flag-icon' }, '⚑'), el('span', null, s.flags[id] ? 'Flagged' : 'Flag for review'));

    var palette = el('div', { class: 'palette', role: 'group', 'aria-label': 'Question palette' });
    function refreshPalette() {
      ui.clear(palette);
      s.ids.forEach(function (qid, i) {
        var answered = !!(s.answers[qid] && s.answers[qid].length);
        var flagged = !!s.flags[qid];
        var parts = ['Question ' + (i + 1), answered ? 'answered' : 'unanswered'];
        if (flagged) parts.push('flagged');
        palette.appendChild(el('button', {
          type: 'button',
          class: 'palette__cell' + (answered ? ' is-answered' : '') + (flagged ? ' is-flagged' : '') + (i === s.index ? ' is-current' : ''),
          'aria-label': parts.join(', '),
          'aria-current': i === s.index ? 'true' : null,
          onclick: function () { goTo(i); }
        }, String(i + 1)));
      });
      countLine.textContent = s.ids.filter(function (x) { return s.answers[x] && s.answers[x].length; }).length +
        ' of ' + s.ids.length + ' answered · ' + Object.keys(s.flags).length + ' flagged';
    }
    var countLine = el('p', { class: 'muted small num' });

    state.main.appendChild(el('section', { class: 'screen screen--session' },
      el('div', { class: 'session-head' },
        el('div', { class: 'session-head__info' },
          el('p', { class: 'eyebrow' }, state.bank.title + ' · Exam'),
          el('h1', { class: 'session-title', tabindex: '-1' },
            el('span', { class: 'num' }, 'Question ' + (s.index + 1) + ' of ' + s.ids.length))
        ),
        el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: confirmSubmit }, 'Submit exam')
      ),
      ui.progressBar(answeredCount, s.ids.length, 'Questions answered'),
      el('article', { class: 'card question-card' },
        need > 1 ? el('p', { class: 'choose' }, '(Choose ' + need + ')') : null,
        el('h2', { class: 'q-text' }, q.question),
        options.node,
        el('div', { class: 'exam-nav' },
          el('button', { class: 'btn', type: 'button', disabled: s.index === 0, onclick: function () { goTo(s.index - 1); } }, '← Previous'),
          flagBtn,
          el('button', { class: 'btn', type: 'button', disabled: s.index === s.ids.length - 1, onclick: function () { goTo(s.index + 1); } }, 'Next →')
        )
      ),
      el('details', { class: 'card disclosure', open: true },
        el('summary', null, 'Question palette'),
        el('div', { class: 'palette-legend small muted' },
          el('span', null, el('i', { class: 'swatch swatch--answered' }), 'Answered'),
          el('span', null, el('i', { class: 'swatch' }), 'Unanswered'),
          el('span', null, el('i', { class: 'swatch swatch--flagged' }), 'Flagged')
        ),
        palette,
        countLine
      )
    ));
    refreshPalette();
  }

  function goTo(i) {
    var s = state.session;
    if (i < 0 || i >= s.ids.length) return;
    s.index = i;
    save();
    drawExam();
    SET.ui.focusHeading();
  }

  function confirmSubmit() {
    var s = state.session;
    var unanswered = s.ids.filter(function (x) { return !(s.answers[x] && s.answers[x].length); }).length;
    var flagged = Object.keys(s.flags).length;
    var lines = [];
    lines.push(unanswered ? unanswered + (unanswered === 1 ? ' question is' : ' questions are') + ' unanswered and will count as wrong.' : 'All questions are answered.');
    if (flagged) lines.push(flagged + (flagged === 1 ? ' question is' : ' questions are') + ' flagged for review.');
    SET.ui.confirm('Submit exam?', lines.join(' '), 'Submit exam').then(function (ok) {
      if (ok && state.session === s) finish(null);
    });
  }

  function finish(notice) {
    stopTimer();
    var s = state.session;
    if (!s) return;
    var progress = SET.storage.getProgress(s.bankId);
    var result = grade(s, state.qmap, progress, Date.now());
    SET.storage.saveProgress(s.bankId, progress, true);
    SET.storage.addSession(s.bankId, result.summary);
    SET.storage.clearActive();
    result.notice = notice;
    result.filter = 'all';
    lastResult = result;
    state.session = null;
    SET.ui.setTimer(null);
    SET.ui.closeDialogs();
    drawResults();
    SET.ui.focusHeading();
  }

  function drawResults() {
    var ui = SET.ui, el = ui.el;
    var r = lastResult;
    var bank = state.bank;
    ui.clear(state.main);

    var wrongIds = r.items.filter(function (i) { return !i.correct; }).map(function (i) { return i.id; })
      .filter(function (id) { return !!state.qmap[id]; });
    var filters = [
      { key: 'all', label: 'All', test: function () { return true; } },
      { key: 'wrong', label: 'Wrong', test: function (i) { return !i.correct; } },
      { key: 'flagged', label: 'Flagged', test: function (i) { return i.flagged; } }
    ];

    var list = el('ol', { class: 'review-list' });
    function fill() {
      ui.clear(list);
      var f = filters.filter(function (x) { return x.key === r.filter; })[0];
      var shown = 0;
      r.items.forEach(function (item, i) {
        var q = state.qmap[item.id];
        if (!q || !f.test(item)) return;
        shown++;
        list.appendChild(ui.reviewItem(q, item.selected, {
          number: i + 1,
          status: item.correct ? 'correct' : item.answered ? 'wrong' : 'unanswered',
          flagged: item.flagged
        }));
      });
      if (!shown) list.appendChild(el('li', { class: 'muted empty-row' }, 'Nothing to show for this filter.'));
    }

    var tabs = ui.segmented('Review filter', filters.map(function (f) {
      var n = r.items.filter(f.test).length;
      return { value: f.key, label: f.label + ' (' + n + ')' };
    }), r.filter, function (v) { r.filter = v; fill(); });

    fill();

    state.main.appendChild(el('section', { class: 'screen' },
      el('p', { class: 'eyebrow' }, bank.title + ' · Exam'),
      el('h1', { tabindex: '-1' }, 'Exam results'),
      r.notice ? ui.callout(r.notice, 'warn') : null,
      el('div', { class: 'card result-hero' },
        ui.scoreRing(r.scorePercent, r.passed ? 'ok' : 'bad', 'score'),
        el('div', { class: 'result-hero__body' },
          el('p', { class: 'verdict ' + (r.passed ? 'is-pass' : 'is-fail') },
            el('span', { 'aria-hidden': 'true' }, r.passed ? '✓ ' : '✕ '),
            r.passed ? 'PASS' : 'FAIL'),
          el('dl', { class: 'facts' },
            ui.fact('Correct', r.correct + ' / ' + r.total),
            ui.fact('Pass mark', r.passMarkPercent + '%'),
            ui.fact('Time used', ui.clock(r.timeUsedSec))
          )
        )
      ),
      el('div', { class: 'actions actions--wrap' },
        wrongIds.length ? el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
          SET.practice.start(bank.id, { ids: wrongIds });
        } }, 'Practise the ones I got wrong (' + wrongIds.length + ')') : null,
        el('a', { class: 'btn' + (wrongIds.length ? '' : ' btn-primary'), href: '#/bank/' + encodeURIComponent(bank.id) }, 'Back to bank')
      ),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, 'Review'), tabs),
        list
      )
    ));
  }

  SET.exam = {
    createSession: createSession,
    grade: grade,
    start: start,
    render: render
  };
})();
