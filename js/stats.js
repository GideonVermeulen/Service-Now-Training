/* stats.js — stats dashboard (inline SVG chart, no libraries) */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;

  var CHART_SESSIONS = 30;

  function accuracy(p) { return p && p.seen ? p.correct / p.seen : null; }
  function accText(p) { return p && p.seen ? W.pct(p.correct, p.seen) + '% (' + p.correct + '/' + p.seen + ')' : '—'; }

  function render(main, bankId) {
    var ui = SET.ui, el = ui.el;
    var bank = SET.storage.getBank(bankId);
    if (!bank) { ui.go('#/'); return; }
    var progress = SET.storage.getProgress(bankId);
    var sessions = SET.storage.getSessions(bankId);
    var counts = W.counts(bank.questions, progress);

    var seen = 0, seenQ = 0, correct = 0;
    bank.questions.forEach(function (q) {
      var p = W.get(progress, q.id);
      if (p.seen) { seenQ++; seen += p.seen; correct += p.correct; }
    });

    var bankHash = '#/bank/' + encodeURIComponent(bankId);
    var hasTopics = bank.questions.some(function (q) { return q.topic; });
    var active = SET.storage.getActive();
    var examLive = !!(active && active.type === 'exam' && active.bankId === bankId);

    main.appendChild(el('section', { class: 'screen screen--wide' },
      el('a', { class: 'back-link', href: bankHash }, '← ' + bank.title),
      el('h1', { tabindex: '-1' }, 'Stats'),
      examLive ? ui.callout('Answers are hidden while your exam on this bank is in progress.', 'info') : null,
      el('div', { class: 'tiles' },
        ui.tile('Mastery', W.pct(counts.mastered, counts.total) + '%', counts.mastered + ' of ' + counts.total + ' mastered'),
        ui.tile('Questions seen', seenQ + ' / ' + counts.total, W.pct(seenQ, counts.total) + '% coverage'),
        ui.tile('Overall accuracy', seen ? W.pct(correct, seen) + '%' : '—', correct + ' correct of ' + seen + ' attempts'),
        ui.tile('Sessions completed', String(sessions.length), sessions.length ? 'Last: ' + ui.date(sessions[sessions.length - 1].endedAt) : 'None yet')
      ),
      el('section', { class: 'card' },
        el('h2', null, 'Status'),
        ui.statusBar(counts)
      ),
      el('section', { class: 'card' },
        el('h2', null, 'Score trend'),
        trendChart(sessions, bank)
      ),
      el('div', { class: 'grid-2' },
        weakest(bank, progress),
        hasTopics ? byTopic(bank, progress) : history(sessions, bankId, examLive)
      ),
      hasTopics ? history(sessions, bankId, examLive) : null,
      questionTable(bank, progress, hasTopics, examLive),
      el('section', { class: 'card card--danger' },
        el('h2', null, 'Reset progress'),
        el('p', { class: 'muted' }, 'Clears progress and session history for this bank. The questions are kept.'),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn-danger', type: 'button', onclick: function () {
            ui.typedConfirm('Reset progress?', 'This permanently clears all progress and sessions for this bank. Type the bank title to confirm.',
              bank.title, 'Reset progress').then(function (ok) {
              if (!ok) return;
              SET.storage.clearStudy(bankId);
              ui.toast('Progress reset.');
              ui.rerender();
            });
          } }, 'Reset progress…')
        )
      )
    ));
  }

  /* ---------- trend chart ---------- */

  function trendChart(allSessions, bank) {
    var ui = SET.ui, el = ui.el, svg = ui.svg;
    var sessions = allSessions.slice(-CHART_SESSIONS);
    if (sessions.length < 2) {
      return el('p', { class: 'empty-chart muted' }, sessions.length === 0
        ? 'No sessions yet. Finish a practice test or an exam to start your trend.'
        : 'One session so far (' + sessions[0].scorePercent + '%). Finish another to see a trend.');
    }

    var Wd = 640, Ht = 260, L = 44, R = 16, T = 16, B = 40;
    var plotW = Wd - L - R, plotH = Ht - T - B;
    var n = sessions.length;
    var x = function (i) { return L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
    var y = function (v) { return T + plotH - (v / 100) * plotH; };

    var root = svg('svg', { viewBox: '0 0 ' + Wd + ' ' + Ht, class: 'chart', role: 'img', 'aria-labelledby': 'chart-title' });
    root.appendChild(svg('title', { id: 'chart-title' }, 'Score per session, last ' + n + ' sessions'));

    [0, 25, 50, 75, 100].forEach(function (v) {
      root.appendChild(svg('line', { x1: L, x2: Wd - R, y1: y(v), y2: y(v), class: 'chart__grid' }));
      root.appendChild(svg('text', { x: L - 8, y: y(v) + 4, class: 'chart__tick', 'text-anchor': 'end' }, String(v)));
    });
    root.appendChild(svg('line', { x1: L, x2: L, y1: T, y2: T + plotH, class: 'chart__axis' }));
    root.appendChild(svg('line', { x1: L, x2: Wd - R, y1: T + plotH, y2: T + plotH, class: 'chart__axis' }));
    root.appendChild(svg('text', { x: L + plotW / 2, y: Ht - 6, class: 'chart__label', 'text-anchor': 'middle' }, 'Session (oldest → newest)'));
    root.appendChild(svg('text', { x: 12, y: T + plotH / 2, class: 'chart__label', 'text-anchor': 'middle',
      transform: 'rotate(-90 12 ' + (T + plotH / 2) + ')' }, 'Score %'));

    var exams = sessions.filter(function (s) { return s.mode === 'exam'; });
    if (exams.length) {
      var last = exams[exams.length - 1];
      var mark = typeof last.passMarkPercent === 'number' ? last.passMarkPercent : bank.exam.passMarkPercent;
      root.appendChild(svg('line', { x1: L, x2: Wd - R, y1: y(mark), y2: y(mark), class: 'chart__pass' }));
      root.appendChild(svg('text', { x: Wd - R - 4, y: y(mark) - 6, class: 'chart__pass-label', 'text-anchor': 'end' }, 'Pass mark ' + mark + '%'));
    }

    ['practice', 'exam'].forEach(function (mode) {
      var pts = [];
      sessions.forEach(function (s, i) { if (s.mode === mode) pts.push(x(i) + ',' + y(s.scorePercent)); });
      if (pts.length > 1) root.appendChild(svg('polyline', { points: pts.join(' '), class: 'chart__line chart__line--' + mode }));
    });

    var wrap = el('div', { class: 'chart-wrap' });
    var tip = el('div', { class: 'chart-tip', role: 'status', hidden: true });

    sessions.forEach(function (s, i) {
      var cx = x(i), cy = y(s.scorePercent);
      var label = ui.date(s.endedAt) + ' · ' + (s.mode === 'exam' ? 'Exam' : 'Practice') + ' · ' + s.scorePercent + '%' +
        (s.mode === 'exam' && typeof s.passed === 'boolean' ? (s.passed ? ' (pass)' : ' (fail)') : '');
      var g = svg('g', { class: 'chart__pt chart__pt--' + s.mode, tabindex: '0', role: 'img', 'aria-label': label });
      g.appendChild(svg('circle', { cx: cx, cy: cy, r: 14, class: 'chart__hit' }));
      if (s.mode === 'exam') g.appendChild(svg('rect', { x: cx - 5.5, y: cy - 5.5, width: 11, height: 11, transform: 'rotate(45 ' + cx + ' ' + cy + ')' }));
      else g.appendChild(svg('circle', { cx: cx, cy: cy, r: 5 }));
      var show = function () {
        tip.textContent = label;
        tip.hidden = false;
        tip.style.left = (cx / Wd * 100) + '%';
        tip.style.top = (cy / Ht * 100) + '%';
      };
      var hide = function () { tip.hidden = true; };
      g.addEventListener('mouseenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('mouseleave', hide);
      g.addEventListener('blur', hide);
      root.appendChild(g);
    });

    wrap.appendChild(root);
    wrap.appendChild(tip);
    return el('div', null,
      el('div', { class: 'legend small' },
        el('span', null, el('i', { class: 'legend__dot' }), 'Practice'),
        el('span', null, el('i', { class: 'legend__diamond' }), 'Exam'),
        exams.length ? el('span', null, el('i', { class: 'legend__dash' }), 'Pass mark') : null
      ),
      wrap
    );
  }

  /* ---------- lists ---------- */

  // Questions you get wrong most, by accuracy smoothed towards 50% so one miss doesn't outrank five.
  // Uses first answers of each day, so same-day repeats can't hide a weak question.
  // Only questions answered wrong at least once. Ties: more misses, then wrong last time.
  function weakestRows(bank, progress) {
    return bank.questions.map(function (q) {
      var p = W.get(progress, q.id);
      var d = W.daily(p), seen = d.seen, correct = d.correct;
      return { q: q, p: p, misses: seen - correct, score: (correct + 1) / (seen + 2) };
    }).filter(function (r) { return r.misses > 0; }).sort(function (a, b) {
      return a.score - b.score || b.misses - a.misses || (b.p.lastGrade === 1) - (a.p.lastGrade === 1);
    }).slice(0, 10);
  }

  function weakest(bank, progress) {
    var ui = SET.ui, el = ui.el;
    var rows = weakestRows(bank, progress);
    return el('section', { class: 'card' },
      el('h2', null, 'Weakest 10'),
      el('p', { class: 'muted small' }, 'The questions you get wrong most often.'),
      rows.length ? el('ol', { class: 'weak-list' }, rows.map(function (r) {
        return el('li', null,
          el('p', { class: 'clamp-2' }, r.q.question),
          el('div', { class: 'weak-list__meta' }, ui.chip(W.status(r.p)), el('span', { class: 'muted small num' }, accText(r.p)))
        );
      })) : el('p', { class: 'muted' }, 'Nothing yet — questions show here once you’ve answered them wrong.')
    );
  }

  function byTopic(bank, progress) {
    var el = SET.ui.el;
    var topics = Object.create(null); // keyed by topic: no built-in names
    bank.questions.forEach(function (q) {
      var t = q.topic || 'Unlabeled';
      var row = topics[t] || (topics[t] = { n: 0, mastered: 0, seen: 0, correct: 0 });
      var p = W.get(progress, q.id);
      row.n++;
      if (W.status(p) === 'mastered') row.mastered++;
      row.seen += p.seen || 0;
      row.correct += p.correct || 0;
    });
    var names = Object.keys(topics).sort();
    return el('section', { class: 'card' },
      el('h2', null, 'By topic'),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Topic'), el('th', { scope: 'col', class: 'num' }, 'Questions'),
            el('th', { scope: 'col', class: 'num' }, 'Mastery'), el('th', { scope: 'col', class: 'num' }, 'Accuracy'))),
          el('tbody', null, names.map(function (t) {
            var r = topics[t];
            return el('tr', null, el('td', null, t), el('td', { class: 'num' }, String(r.n)),
              el('td', { class: 'num' }, W.pct(r.mastered, r.n) + '%'),
              el('td', { class: 'num' }, r.seen ? W.pct(r.correct, r.seen) + '%' : '—'));
          }))
        )
      )
    );
  }

  function history(sessions, bankId, examLive) {
    var ui = SET.ui, el = ui.el;
    var list = sessions.slice().reverse();
    return el('section', { class: 'card' },
      el('h2', null, 'Session history'),
      list.length ? el('div', { class: 'table-wrap table-wrap--scroll' },
        el('table', { class: 'table' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Date'), el('th', { scope: 'col' }, 'Mode'),
            el('th', { scope: 'col', class: 'num' }, 'Size'), el('th', { scope: 'col', class: 'num' }, 'Score'), el('th', { scope: 'col' }, 'Result'),
            el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Review')))),
          el('tbody', null, list.map(function (s) {
            return el('tr', null,
              el('td', { class: 'num' }, ui.date(s.endedAt)),
              el('td', null, s.mode === 'exam' ? 'Exam' : 'Practice'),
              el('td', { class: 'num' }, String(s.size)),
              el('td', { class: 'num' }, s.scorePercent + '%'),
              el('td', null, s.mode === 'exam'
                ? el('span', { class: 'result-tag ' + (s.passed ? 'is-pass' : 'is-fail') }, s.passed ? '✓ Pass' : '✕ Fail')
                : el('span', { class: 'muted' }, '—')),
              el('td', null, s.mode === 'exam' && s.review && !examLive
                ? el('a', { class: 'link', href: '#/bank/' + encodeURIComponent(bankId) + '/result/' + encodeURIComponent(s.id),
                  'aria-label': 'View exam results from ' + ui.date(s.endedAt) }, 'View')
                : null));
          }))
        )
      ) : el('p', { class: 'muted' }, 'No sessions yet.')
    );
  }

  /* ---------- all-questions table ---------- */

  function questionTable(bank, progress, hasTopics, examLive) {
    var ui = SET.ui, el = ui.el;
    var rows = bank.questions.map(function (q, i) {
      var p = W.get(progress, q.id);
      return { n: i + 1, q: q, p: p, status: W.status(p), acc: accuracy(p) };
    });
    var view = { filter: 'all', search: '', sort: 'n', dir: 1, open: {} };
    var statusOrder = { 'new': 0, weak: 1, learning: 2, mastered: 3 };

    var cols = [
      { key: 'n', label: '#', cls: 'num', val: function (r) { return r.n; } },
      { key: 'question', label: 'Question', val: function (r) { return r.q.question.toLowerCase(); } }
    ];
    if (hasTopics) cols.push({ key: 'topic', label: 'Topic', cls: 'col-opt', val: function (r) { return (r.q.topic || 'Unlabeled').toLowerCase(); } });
    cols.push(
      { key: 'status', label: 'Status', val: function (r) { return statusOrder[r.status]; } },
      { key: 'seen', label: 'Seen', cls: 'num col-opt', val: function (r) { return r.p.seen || 0; } },
      { key: 'acc', label: 'Accuracy', cls: 'num', val: function (r) { return r.acc === null ? -1 : r.acc; } },
      { key: 'streak', label: 'Streak', cls: 'num col-opt', val: function (r) { return r.p.streak || 0; } }
    );

    var thead = el('thead');
    var tbody = el('tbody');
    var countLine = el('p', { class: 'muted small', 'aria-live': 'polite' });

    function drawHead() {
      ui.clear(thead);
      thead.appendChild(el('tr', null, cols.map(function (c) {
        var sorted = view.sort === c.key;
        return el('th', { scope: 'col', class: c.cls || null, 'aria-sort': sorted ? (view.dir > 0 ? 'ascending' : 'descending') : 'none' },
          el('button', { type: 'button', class: 'th-sort', onclick: function () {
            if (view.sort === c.key) view.dir = -view.dir; else { view.sort = c.key; view.dir = 1; }
            drawHead(); drawBody();
          } }, c.label, el('span', { class: 'th-sort__arrow', 'aria-hidden': 'true' }, sorted ? (view.dir > 0 ? '▲' : '▼') : '↕')));
      })));
    }

    function drawBody() {
      ui.clear(tbody);
      var term = view.search.trim().toLowerCase();
      var col = cols.filter(function (c) { return c.key === view.sort; })[0];
      var list = rows.filter(function (r) {
        if (view.filter !== 'all' && r.status !== view.filter) return false;
        if (!term) return true;
        return r.q.question.toLowerCase().indexOf(term) >= 0 ||
          (r.q.topic || 'Unlabeled').toLowerCase().indexOf(term) >= 0 ||
          r.q.options.some(function (o) { return o.toLowerCase().indexOf(term) >= 0; });
      });
      list.sort(function (a, b) {
        var x = col.val(a), y = col.val(b);
        return (x < y ? -1 : x > y ? 1 : a.n - b.n) * view.dir;
      });
      countLine.textContent = 'Showing ' + list.length + ' of ' + rows.length + ' questions.';
      if (!list.length) {
        tbody.appendChild(el('tr', null, el('td', { colspan: cols.length, class: 'muted empty-row' }, 'No questions match.')));
        return;
      }
      list.forEach(function (r) {
        var open = !!view.open[r.q.id];
        var toggle = function () { view.open[r.q.id] = !view.open[r.q.id]; drawBody(); };
        var cells = cols.map(function (c) {
          if (c.key === 'question') {
            return el('td', { class: 'td-question' },
              el('button', { type: 'button', class: 'row-toggle', 'aria-expanded': open ? 'true' : 'false',
                onclick: function (e) { e.stopPropagation(); toggle(); } },
                el('span', { class: 'clamp-2' }, r.q.question)));
          }
          if (c.key === 'status') return el('td', null, ui.chip(r.status));
          if (c.key === 'topic') return el('td', { class: c.cls + (r.q.topic ? '' : ' muted') }, r.q.topic || 'Unlabeled');
          if (c.key === 'acc') return el('td', { class: c.cls }, r.acc === null ? '—' : W.pct(r.p.correct, r.p.seen) + '%');
          return el('td', { class: c.cls }, String(c.val(r)));
        });
        tbody.appendChild(el('tr', { class: 'row-click' + (open ? ' is-open' : ''), onclick: toggle }, cells));
        if (open && examLive) {
          tbody.appendChild(el('tr', { class: 'row-detail' },
            el('td', { colspan: cols.length, class: 'muted' }, 'The answer is hidden until you finish your exam.')));
        } else if (open) {
          tbody.appendChild(el('tr', { class: 'row-detail' },
            el('td', { colspan: cols.length },
              el('ol', { class: 'answer-key' }, r.q.options.map(function (o, i) {
                var ok = r.q.answer.indexOf(i) >= 0;
                return el('li', { class: ok ? 'is-correct' : '' },
                  el('span', { class: 'answer-key__letter' }, SET.bank.letter(i)),
                  el('span', null, o),
                  ok ? el('span', { class: 'answer-key__mark' }, '✓ Correct answer') : null);
              })),
              r.q.explanation ? ui.explanation(r.q.explanation) : null,
              r.q.unverified ? ui.unverifiedNote({ bankId: bank.id, q: r.q }) : null,
              el('div', { class: 'actions actions--tight' },
                el('button', { class: 'btn btn-sm', type: 'button', onclick: function () {
                  SET.editor.open(bank.id, r.q.id).then(function (saved) { if (saved) ui.rerender(); });
                } }, 'Edit question')))));
        }
      });
    }

    var filter = ui.segmented('Filter by status', [
      { value: 'all', label: 'All' }, { value: 'new', label: 'New' }, { value: 'weak', label: 'Weak' },
      { value: 'learning', label: 'Learning' }, { value: 'mastered', label: 'Mastered' }
    ], 'all', function (v) { view.filter = v; drawBody(); });

    var search = el('input', { type: 'search', class: 'input', placeholder: 'Search questions…', 'aria-label': 'Search questions',
      oninput: function () { view.search = search.value; drawBody(); } });

    drawHead();
    drawBody();

    return el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', null, 'All questions'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: function () {
          SET.editor.open(bank.id, null).then(function (done) { if (done) ui.rerender(); });
        } }, '+ Add question')),
      el('div', { class: 'toolbar' }, filter, search),
      countLine,
      el('div', { class: 'table-wrap table-wrap--scroll' }, el('table', { class: 'table table--questions' }, thead, tbody))
    );
  }

  SET.stats = { render: render, weakestRows: weakestRows };
})();
