/* app.js — router, library screen, settings, theme, shared UI helpers */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};
  var W = SET.weighting;
  var S = SET.storage;

  var APP_NAME = 'ServiceNow Exam Training';
  var FORMAT_GUIDE = 'docs/BANK_FORMAT.md';
  var TEMPLATE = 'templates/bank-template.json';
  var SIZES = [10, 25, 50, 'all'];

  var leaveFns = [];
  var openDialogs = [];
  var flash = null;          // one-shot message shown on the next Library render
  var practiceSize = 25;     // remembered for this visit
  var firstRoute = true;
  var uid = 0;

  /* =========================================================
     DOM helpers
     ========================================================= */

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    if (typeof child === 'string' || typeof child === 'number') node.appendChild(document.createTextNode(String(child)));
    else node.appendChild(child);
  }

  // Builds an element. Text is always inserted as text nodes, never parsed as HTML.
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') node[k] = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function svg(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, String(attrs[k])); });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function nextId(p) { uid++; return (p || 'id') + '-' + uid; }

  function date(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* =========================================================
     Feedback: announcer, toast, banner, dialogs
     ========================================================= */

  function announce(text) {
    var a = document.getElementById('announcer');
    if (!a) return;
    a.textContent = '';
    setTimeout(function () { a.textContent = text; }, 50);
  }

  var toastTimer = null;
  function toast(text) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-visible'); t.hidden = true; }, 3200);
  }

  function showBanner(msg) {
    var b = document.getElementById('banner');
    if (!b) return;
    clear(b);
    b.appendChild(el('div', { class: 'banner', role: 'alert' },
      el('span', { class: 'banner__icon', 'aria-hidden': 'true' }, '!'),
      el('span', null, msg),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { clear(b); } }, 'Dismiss')));
  }

  // opts: { title, body (string|node), actions: [{label, value, kind}], input: {label, match}, focus: value }
  function dialog(opts) {
    return new Promise(function (resolve) {
      var titleId = nextId('dlg');
      var opener = document.activeElement;
      var d = el('dialog', { class: 'dialog', 'aria-labelledby': titleId });
      var done = false;
      var input = null;
      var buttons = [];

      function close(value) {
        if (done) return;
        done = true;
        openDialogs = openDialogs.filter(function (x) { return x.d !== d; });
        try { d.close(); } catch (e) { /* already closed */ }
        if (d.parentNode) d.parentNode.removeChild(d);
        if (opener && opener.focus && document.body.contains(opener)) opener.focus();
        resolve(value);
      }

      var actions = el('div', { class: 'dialog__actions' });
      (opts.actions || []).forEach(function (a) {
        var b = el('button', {
          type: 'button',
          class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger-solid' : a.kind === 'ghost' ? 'btn-ghost' : ''),
          onclick: function () { close(a.value); }
        }, a.label);
        b._value = a.value;
        b._needsMatch = !!a.needsMatch;
        buttons.push(b);
        actions.appendChild(b);
      });

      var bodyNode = typeof opts.body === 'string' ? el('p', { class: 'dialog__text' }, opts.body) : opts.body;
      var inputWrap = null;
      if (opts.input) {
        var inputId = nextId('dlg-input');
        input = el('input', { id: inputId, class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false' });
        var check = function () {
          var ok = input.value.trim() === opts.input.match;
          buttons.forEach(function (b) { if (b._needsMatch) b.disabled = !ok; });
        };
        input.addEventListener('input', check);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && input.value.trim() === opts.input.match) {
            e.preventDefault();
            var b = buttons.filter(function (x) { return x._needsMatch; })[0];
            if (b) close(b._value);
          }
        });
        inputWrap = el('div', { class: 'field' }, el('label', { for: inputId, class: 'field__label' }, opts.input.label), input);
        setTimeout(check, 0);
      }

      d.appendChild(el('div', { class: 'dialog__inner' },
        el('h2', { id: titleId, class: 'dialog__title' }, opts.title),
        bodyNode,
        inputWrap,
        actions));
      d.addEventListener('cancel', function (e) { e.preventDefault(); close(null); });
      d.addEventListener('click', function (e) { if (e.target === d) close(null); });
      document.body.appendChild(d);
      openDialogs.push({ d: d, close: close });
      d.showModal();
      if (input) input.focus();
      else {
        var f = buttons.filter(function (b) { return b._value === opts.focus; })[0] || buttons[buttons.length - 1];
        if (f) f.focus();
      }
    });
  }

  function closeDialogs() { openDialogs.slice().forEach(function (x) { x.close(null); }); }

  function confirm(title, body, okLabel, danger) {
    return dialog({
      title: title, body: body,
      actions: [
        { label: 'Cancel', value: false, kind: 'ghost' },
        { label: okLabel || 'OK', value: true, kind: danger ? 'danger' : 'primary' }
      ],
      focus: danger ? false : true
    }).then(function (v) { return v === true; });
  }

  function typedConfirm(title, body, match, okLabel) {
    return dialog({
      title: title, body: body,
      input: { label: 'Type “' + match + '” to confirm', match: match },
      actions: [
        { label: 'Cancel', value: false, kind: 'ghost' },
        { label: okLabel, value: true, kind: 'danger', needsMatch: true }
      ]
    }).then(function (v) { return v === true; });
  }

  /* =========================================================
     Shared components
     ========================================================= */

  function callout(text, tone, extra) {
    return el('div', { class: 'callout callout--' + (tone || 'info'), role: tone === 'error' ? 'alert' : null },
      el('span', { class: 'callout__icon', 'aria-hidden': 'true' }, tone === 'ok' ? '✓' : tone === 'error' ? '✕' : tone === 'warn' ? '!' : 'i'),
      el('div', { class: 'callout__body' }, typeof text === 'string' ? el('p', null, text) : text, extra || null));
  }

  function progressBar(value, max, label) {
    var pct = max ? Math.round((value / max) * 100) : 0;
    var fill = el('div', { class: 'bar__fill' });
    fill.style.width = pct + '%';
    return el('div', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value }, fill);
  }

  function chip(status) {
    return el('span', { class: 'chip chip--' + status }, el('i', { class: 'chip__dot', 'aria-hidden': 'true' }), W.STATUS_LABEL[status]);
  }

  function statusBar(counts) {
    var stack = el('div', { class: 'stack', role: 'img',
      'aria-label': W.STATUSES.map(function (s) { return W.STATUS_LABEL[s] + ' ' + counts[s]; }).join(', ') });
    W.STATUSES.forEach(function (s) {
      if (!counts[s]) return;
      var seg = el('div', { class: 'stack__seg stack__seg--' + s });
      seg.style.flexGrow = counts[s];
      stack.appendChild(seg);
    });
    if (!counts.total) stack.appendChild(el('div', { class: 'stack__seg' }));
    return el('div', { class: 'status-bar' },
      stack,
      el('ul', { class: 'legend legend--status' }, W.STATUSES.map(function (s) {
        return el('li', null, chip(s), el('span', { class: 'num legend__count' }, String(counts[s])));
      })));
  }

  function segmented(label, options, current, onChange) {
    var name = nextId('seg');
    return el('fieldset', { class: 'segmented' },
      el('legend', { class: 'sr-only' }, label),
      options.map(function (o) {
        var id = nextId('seg-opt');
        return el('span', { class: 'segmented__item' },
          el('input', {
            type: 'radio', id: id, name: name, value: String(o.value), checked: String(o.value) === String(current),
            disabled: !!o.disabled,
            onchange: function () { onChange(o.value); }
          }),
          el('label', { for: id, title: o.title || null }, o.label));
      }));
  }

  function focusControl(current, onChange) {
    var hint = el('p', { class: 'hint' }, W.FOCUS[current].hint);
    return el('div', { class: 'focus-control' },
      segmented('Focus', W.FOCUS.map(function (f, i) { return { value: i, label: f.label }; }), current, function (v) {
        v = Number(v);
        hint.textContent = W.FOCUS[v].hint;
        onChange(v);
      }),
      hint);
  }

  function optionList(q, order, opts) {
    var need = q.answer.length;
    var selected = (opts.selected || []).slice();
    var list = el('div', { class: 'options', role: 'group', 'aria-label': need > 1 ? 'Answer options, choose ' + need : 'Answer options, choose one' });
    var buttons = order.map(function (orig, pos) {
      var b = el('button', { type: 'button', class: 'option', onclick: function () { if (!opts.reveal) opts.onPick(orig); } },
        el('span', { class: 'option__key' }, SET.bank.letter(pos)),
        el('span', { class: 'option__text' }, q.options[orig]));
      b._orig = orig;
      list.appendChild(b);
      return b;
    });
    function update(sel) {
      selected = sel.slice();
      buttons.forEach(function (b) {
        var on = selected.indexOf(b._orig) >= 0;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    update(selected);
    if (opts.reveal) {
      list.classList.add('is-locked');
      buttons.forEach(function (b) {
        var isAns = q.answer.indexOf(b._orig) >= 0;
        var picked = selected.indexOf(b._orig) >= 0;
        b.setAttribute('aria-disabled', 'true');
        if (isAns) {
          b.classList.add('is-correct');
          b.appendChild(el('span', { class: 'option__mark' }, picked ? '✓ Correct answer · your pick' : '✓ Correct answer'));
        } else if (picked) {
          b.classList.add('is-wrong');
          b.appendChild(el('span', { class: 'option__mark' }, '✕ Your answer'));
        }
      });
    }
    return { node: list, update: update };
  }

  function explanation(text) {
    return el('div', { class: 'explanation' }, el('p', { class: 'explanation__label' }, 'Explanation'), el('p', null, text));
  }

  function unverifiedNote() {
    return el('p', { class: 'unverified' }, el('span', { 'aria-hidden': 'true' }, '⚠ '), 'This answer has not been verified — double-check it against the official documentation.');
  }

  function answerTexts(q, idxs) {
    if (!idxs || !idxs.length) return el('span', { class: 'muted' }, 'No answer');
    return el('ul', { class: 'answer-texts' }, idxs.slice().sort(function (a, b) { return a - b; }).map(function (i) {
      return el('li', null, q.options[i]);
    }));
  }

  function reviewItem(q, selected, o) {
    var status = o.status;
    var tag = status === 'correct' ? '✓ Correct' : status === 'wrong' ? '✕ Wrong' : '— Unanswered';
    return el('li', { class: 'review-item is-' + status },
      el('div', { class: 'review-item__head' },
        o.number ? el('span', { class: 'review-item__num num' }, 'Q' + o.number) : null,
        el('span', { class: 'result-tag ' + (status === 'correct' ? 'is-pass' : status === 'wrong' ? 'is-fail' : 'is-none') }, tag),
        o.flagged ? el('span', { class: 'result-tag is-flag' }, '⚑ Flagged') : null),
      el('p', { class: 'review-item__q' }, q.question),
      el('dl', { class: 'review-item__answers' },
        el('div', null, el('dt', null, 'Your answer'), el('dd', null, answerTexts(q, selected))),
        el('div', null, el('dt', null, 'Correct answer'), el('dd', { class: 'is-correct' }, answerTexts(q, q.answer)))),
      q.explanation ? explanation(q.explanation) : null,
      q.unverified ? unverifiedNote() : null);
  }

  function scoreRing(pct, tone, caption) {
    var r = 52, c = 2 * Math.PI * r;
    var ring = svg('svg', { viewBox: '0 0 120 120', class: 'ring ring--' + tone, 'aria-hidden': 'true' },
      svg('circle', { cx: 60, cy: 60, r: r, class: 'ring__track' }),
      svg('circle', { cx: 60, cy: 60, r: r, class: 'ring__value', 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - pct / 100), transform: 'rotate(-90 60 60)' }));
    return el('div', { class: 'ring-wrap', role: 'img', 'aria-label': 'Score ' + pct + ' percent' }, ring,
      el('span', { class: 'ring__text num' }, pct + '%', caption ? el('span', { class: 'ring__caption' }, caption) : null));
  }

  function fact(label, value) { return el('div', { class: 'fact' }, el('dt', null, label), el('dd', { class: 'num' }, value)); }

  function tile(label, value, sub) {
    return el('div', { class: 'tile' }, el('p', { class: 'tile__label' }, label), el('p', { class: 'tile__value num' }, value),
      sub ? el('p', { class: 'tile__sub' }, sub) : null);
  }

  function setTimer(label, cls, aria) {
    var t = document.getElementById('timer');
    if (!t) return;
    if (!label) { t.hidden = true; t.className = 'timer'; return; }
    t.hidden = false;
    t.className = 'timer ' + (cls || '');
    t.querySelector('.timer__text').textContent = label;
    t.setAttribute('aria-label', aria + ': ' + label);
  }

  /* =========================================================
     Files
     ========================================================= */

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }

  function pickFile(cb) {
    var input = el('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', tabindex: '-1' });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (input.parentNode) input.parentNode.removeChild(input);
      if (f) cb(f);
    });
    document.body.appendChild(input);
    input.click();
  }

  function downloadJson(name, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name, class: 'sr-only' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.parentNode.removeChild(a); }, 1000);
  }

  function dropzone(label, onFile) {
    var zone = el('div', { class: 'dropzone' },
      el('div', { class: 'dropzone__icon', 'aria-hidden': 'true' }, uploadIcon()),
      el('p', { class: 'dropzone__title' }, label),
      el('p', { class: 'muted small' }, 'Drop a .json file here, or'),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { pickFile(onFile); } }, 'Choose file…'));
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', function (e) { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    return zone;
  }

  function uploadIcon() {
    return svg('svg', { viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      svg('path', { d: 'M12 16V4' }), svg('path', { d: 'M7 9l5-5 5 5' }), svg('path', { d: 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3' }));
  }

  /* =========================================================
     Bank import / update
     ========================================================= */

  function errorFlash(fileName, res) {
    var shown = res.errors.slice(0, 20);
    flash = {
      tone: 'error',
      title: "Couldn't import " + fileName + ' — nothing was changed.',
      list: shown,
      more: res.errors.length - shown.length
    };
  }

  function warningList(res) {
    if (!res.warnings.length) return null;
    return el('details', { class: 'warnings' },
      el('summary', null, plural(res.warnings.length, 'warning') + ' (import continued)'),
      el('ul', null, res.warnings.slice(0, 50).map(function (w) { return el('li', null, w); })));
  }

  function addBank(res) {
    var bank = res.bank;
    bank.id = S.newId();
    if (!S.saveBank(bank)) {
      flash = { tone: 'error', title: S.QUOTA_MSG };
      return;
    }
    flash = { tone: 'ok', title: 'Imported. ' + SET.bank.summaryText(bank, res.warnings.length) + '.', res: res, bankId: bank.id };
  }

  function updateBank(bankId, res) {
    var old = S.getBank(bankId);
    var merged = SET.bank.mergeUpdate(old, res.bank, S.getProgress(bankId));
    var bank = res.bank;
    bank.id = bankId;
    if (!S.saveBank(bank) || !S.saveProgress(bankId, merged.progress, false)) {
      flash = { tone: 'error', title: S.QUOTA_MSG };
      return;
    }
    flash = {
      tone: 'ok',
      title: "Updated '" + bank.title + "': +" + merged.added + ' new, ' + merged.removed + ' removed, ' + merged.kept + ' kept.',
      res: res, bankId: bankId
    };
  }

  function handleBankFile(file, targetId) {
    readText(file).then(function (text) {
      var res = SET.bank.parse(text, file.name);
      if (!res.ok) { errorFlash(file.name, res); rerender(); return; }
      if (targetId) { updateBank(targetId, res); rerender(); return; }
      var title = res.bank.title.toLowerCase();
      var same = S.getIndex().banks.filter(function (b) { return String(b.title).toLowerCase() === title; })[0];
      if (!same) { addBank(res); rerender(); return; }
      dialog({
        title: 'A bank with this title already exists',
        body: el('div', null,
          el('p', { class: 'dialog__text' }, SET.bank.summaryText(res.bank, res.warnings.length) + '.'),
          el('p', { class: 'dialog__text muted' }, 'Updating keeps your progress for questions whose id is unchanged.')),
        actions: [
          { label: 'Cancel', value: null, kind: 'ghost' },
          { label: 'Add as a separate bank', value: 'add' },
          { label: 'Update existing bank (keep progress)', value: 'update', kind: 'primary' }
        ]
      }).then(function (v) {
        if (v === 'update') updateBank(same.id, res);
        else if (v === 'add') addBank(res);
        else return;
        rerender();
      });
    }, function () {
      flash = { tone: 'error', title: "Couldn't read " + file.name + '.' };
      rerender();
    });
  }

  function exportBackup() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    downloadJson('set-backup-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json', S.exportBackup());
    toast('Backup downloaded.');
  }

  function importBackup() {
    pickFile(function (file) {
      readText(file).then(function (text) {
        var data;
        try { data = JSON.parse(String(text).replace(/^﻿/, '')); }
        catch (e) { showFlashNow({ tone: 'error', title: file.name + ' is not valid JSON.' }); return; }
        var err = S.checkBackup(data);
        if (err) { showFlashNow({ tone: 'error', title: err }); return; }
        dialog({
          title: 'Import backup',
          body: el('div', null,
            el('p', { class: 'dialog__text' }, 'Backup from ' + date(data.exportedAt) + ' with ' + plural(data.banks.length, 'bank') + '.'),
            el('ul', { class: 'dialog__list' },
              el('li', null, el('strong', null, 'Merge'), ' adds banks you don’t have. Where a bank exists in both, the more recently updated copy wins.'),
              el('li', null, el('strong', null, 'Replace everything'), ' deletes all current data first.'))),
          actions: [
            { label: 'Cancel', value: null, kind: 'ghost' },
            { label: 'Replace everything', value: 'replace', kind: 'danger' },
            { label: 'Merge', value: 'merge', kind: 'primary' }
          ]
        }).then(function (mode) {
          if (!mode) return;
          var r = S.importBackup(data, mode);
          if (!r.ok) { showFlashNow({ tone: 'error', title: r.error }); return; }
          applyTheme();
          showFlashNow({ tone: 'ok', title: 'Backup imported: ' + r.added + ' added, ' + r.updated + ' updated, ' + r.skipped + ' unchanged.' });
        });
      });
    });
  }

  function showFlashNow(f) {
    flash = f;
    if (currentRoute().name !== 'library') go('#/');
    else rerender();
  }

  function flashNode() {
    if (!flash) return null;
    var f = flash;
    flash = null;
    var extra = [];
    if (f.list) {
      extra.push(el('ul', { class: 'error-list' }, f.list.map(function (e) { return el('li', null, e); })));
      if (f.more > 0) extra.push(el('p', { class: 'small' }, '…and ' + f.more + ' more.'));
    }
    if (f.res) extra.push(warningList(f.res));
    if (f.bankId) extra.push(el('p', null, el('a', { class: 'link', href: '#/bank/' + encodeURIComponent(f.bankId) }, 'Open bank →')));
    return el('div', { class: 'flash', 'aria-live': 'polite' }, callout(el('p', { class: 'callout__title' }, f.title), f.tone, extra));
  }

  /* =========================================================
     Active session helpers
     ========================================================= */

  function describeActive(a) {
    var bank = S.getEntry(a.bankId);
    var title = bank ? "'" + bank.title + "'" : 'a deleted bank';
    if (a.type === 'exam') {
      var answered = Object.keys(a.answers || {}).length;
      return 'Unfinished exam in ' + title + ' — ' + answered + ' of ' + a.ids.length + ' answered.';
    }
    if (a.phase === 'results') return 'Practice results in ' + title + ' (retry rounds available).';
    return 'Unfinished practice test in ' + title + ' — question ' + (a.index + 1) + ' of ' + a.queue.length + '.';
  }

  function ensureNoActive(cb) {
    var a = S.getActive();
    if (!a) { cb(); return; }
    confirm('Discard the unfinished session?', describeActive(a), 'Discard and start', true).then(function (ok) {
      if (!ok) return;
      S.clearActive();
      cb();
    });
  }

  function activeHash(a) { return '#/bank/' + encodeURIComponent(a.bankId) + '/' + (a.type === 'exam' ? 'exam' : 'practice'); }

  function resumeCallout(a) {
    return callout(el('p', null, describeActive(a)), 'info', el('div', { class: 'actions actions--tight' },
      el('a', { class: 'btn btn-primary btn-sm', href: activeHash(a) }, 'Resume'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () {
        confirm('Discard the unfinished session?', describeActive(a), 'Discard', true).then(function (ok) {
          if (ok) { S.clearActive(); rerender(); }
        });
      } }, 'Discard')));
  }

  /* =========================================================
     Screens
     ========================================================= */

  function renderLibrary(main) {
    var index = S.getIndex();
    var banks = index.banks.slice().sort(function (a, b) {
      return (Date.parse(b.lastStudied || b.updatedAt) || 0) - (Date.parse(a.lastStudied || a.updatedAt) || 0);
    });
    var active = S.getActive();
    var onFile = function (f) { handleBankFile(f); };

    if (!banks.length) {
      main.appendChild(el('section', { class: 'screen' },
        el('div', { class: 'hero' },
          el('p', { class: 'eyebrow' }, 'Multiple-choice exam practice'),
          el('h1', { tabindex: '-1' }, 'Learn your question bank until it sticks.'),
          el('p', { class: 'lead' }, 'Upload a question bank as a JSON file. Practice tests show the questions you get wrong more often until you’ve mastered them, and exam mode runs a timed mock test.')),
        flashNode(),
        dropzone('Upload a question bank', onFile),
        el('div', { class: 'help-links' },
          el('a', { class: 'link', href: FORMAT_GUIDE, target: '_blank', rel: 'noopener' }, 'Bank format guide'),
          el('span', { 'aria-hidden': 'true' }, '·'),
          el('a', { class: 'link', href: TEMPLATE, download: 'bank-template.json' }, 'Download template'),
          el('span', { 'aria-hidden': 'true' }, '·'),
          el('button', { class: 'link', type: 'button', onclick: importBackup }, 'Import a backup'))));
      return;
    }

    main.appendChild(el('section', { class: 'screen' },
      el('div', { class: 'page-head' },
        el('div', null, el('p', { class: 'eyebrow' }, 'Library'), el('h1', { tabindex: '-1' }, 'Your banks')),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { pickFile(onFile); } }, '+ Add bank')),
      flashNode(),
      active ? resumeCallout(active) : null,
      el('ul', { class: 'bank-list' }, banks.map(bankCard)),
      dropzone('Add another bank', onFile),
      el('p', { class: 'help-links' },
        el('a', { class: 'link', href: FORMAT_GUIDE, target: '_blank', rel: 'noopener' }, 'Bank format guide'),
        el('span', { 'aria-hidden': 'true' }, '·'),
        el('a', { class: 'link', href: TEMPLATE, download: 'bank-template.json' }, 'Download template')),
      backupCard()));
  }

  function bankCard(entry) {
    var bank = S.getBank(entry.id);
    var count = bank ? bank.questions.length : entry.questionCount;
    var c = bank ? W.counts(bank.questions, S.getProgress(entry.id)) : { mastered: 0, total: count };
    var mastery = W.pct(c.mastered, c.total);
    var hash = '#/bank/' + encodeURIComponent(entry.id);
    return el('li', { class: 'card bank-card' },
      el('div', { class: 'bank-card__main' },
        el('h2', { class: 'bank-card__title' }, el('a', { href: hash }, entry.title)),
        el('p', { class: 'muted small' }, plural(count, 'question') + ' · Last studied ' + (entry.lastStudied ? date(entry.lastStudied) : 'never')),
        el('div', { class: 'mastery' },
          progressBar(c.mastered, c.total || 1, 'Mastery'),
          el('span', { class: 'mastery__label num' }, mastery + '% mastered'))),
      el('div', { class: 'bank-card__actions' },
        el('a', { class: 'btn btn-primary btn-sm', href: hash }, 'Open'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: function () {
          pickFile(function (f) { handleBankFile(f, entry.id); });
        } }, 'Update questions'),
        el('button', { class: 'btn btn-ghost btn-sm btn-danger', type: 'button', onclick: function () {
          confirm('Delete this bank?', "'" + entry.title + "' and all its progress and sessions will be removed from this browser. This can’t be undone.", 'Delete bank', true)
            .then(function (ok) { if (ok) { S.deleteBank(entry.id); toast('Bank deleted.'); rerender(); } });
        } }, 'Delete')));
  }

  function backupCard() {
    return el('section', { class: 'card card--quiet' },
      el('h2', null, 'Backup'),
      el('p', { class: 'muted small' }, 'Your banks and progress live only in this browser. Export a backup to keep them safe or move them to another device.'),
      el('div', { class: 'actions actions--wrap' },
        el('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Export backup'),
        el('button', { class: 'btn', type: 'button', onclick: importBackup }, 'Import backup')));
  }

  function renderBankHome(main, bankId) {
    var bank = S.getBank(bankId);
    if (!bank) { flash = { tone: 'error', title: 'That bank no longer exists.' }; go('#/', true); return; }
    var progress = S.getProgress(bankId);
    var counts = W.counts(bank.questions, progress);
    var n = bank.questions.length;
    var settings = S.getSettings();
    var active = S.getActive();

    // Practice panel
    var sizeChoice = practiceSize === 'all' || practiceSize <= n ? practiceSize : 'all';
    var sizes = segmented('Test size', SIZES.map(function (s) {
      return { value: s, label: s === 'all' ? 'All (' + n + ')' : String(s), disabled: s !== 'all' && s > n };
    }), sizeChoice, function (v) { sizeChoice = v === 'all' ? 'all' : Number(v); practiceSize = sizeChoice; });
    var focus = settings.focus;
    var focusCtl = focusControl(focus, function (v) { focus = v; S.saveSettings({ focus: v }); });

    // Exam panel
    var ex = bank.exam;
    var fCount = numberField('Questions', 'exam-count', Math.min(ex.questionCount, n), 1, n);
    var fTime = numberField('Minutes (0 = untimed)', 'exam-time', ex.timeLimitMinutes, 0, 1440);
    var fPass = numberField('Pass mark (%)', 'exam-pass', ex.passMarkPercent, 0, 100);
    var examError = el('p', { class: 'field-error', role: 'alert' });

    var hash = '#/bank/' + encodeURIComponent(bankId);

    main.appendChild(el('section', { class: 'screen' },
      el('a', { class: 'back-link', href: '#/' }, '← All banks'),
      el('div', { class: 'page-head' },
        el('div', null,
          el('h1', { tabindex: '-1' }, bank.title),
          el('p', { class: 'muted' }, plural(n, 'question') + (counts.total ? ' · ' + W.pct(counts.mastered, n) + '% mastered' : ''))),
        el('a', { class: 'btn', href: hash + '/stats' }, statsIcon(), 'Stats')),
      bank.description ? el('p', { class: 'lead' }, bank.description) : null,
      active && active.bankId === bankId ? resumeCallout(active) : null,
      el('section', { class: 'card' },
        el('h2', { class: 'sr-only' }, 'Status'),
        statusBar(counts)),
      el('div', { class: 'panels' },
        el('section', { class: 'card panel' },
          el('div', { class: 'panel__head' }, el('h2', null, 'Practice'), el('p', { class: 'muted small' }, 'Instant feedback. Weak questions come up more often.')),
          el('div', { class: 'field' }, el('p', { class: 'field__label' }, 'Test size'), sizes),
          el('div', { class: 'field' }, el('p', { class: 'field__label' }, 'Focus'), focusCtl),
          el('div', { class: 'panel__foot' },
            el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () {
              SET.practice.start(bankId, { size: sizeChoice === 'all' ? n : Math.min(sizeChoice, n), focus: focus });
            } }, 'Start practice'))),
        el('section', { class: 'card panel' },
          el('div', { class: 'panel__head' }, el('h2', null, 'Exam'), el('p', { class: 'muted small' }, 'Random questions, timed, no feedback until you submit.')),
          el('div', { class: 'field-row' }, fCount.node, fTime.node, fPass.node),
          examError,
          el('div', { class: 'panel__foot' },
            el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () {
              var c = fCount.read(), t = fTime.read(), p = fPass.read();
              if (c === null || t === null || p === null) { examError.textContent = 'Check the exam settings — each must be a whole number in range.'; return; }
              examError.textContent = '';
              SET.exam.start(bankId, { count: c, timeLimitMinutes: t, passMarkPercent: p });
            } }, 'Start exam'))))));
  }

  function numberField(label, idBase, value, min, max) {
    var id = nextId(idBase);
    var input = el('input', { id: id, class: 'input num', type: 'number', inputmode: 'numeric', min: min, max: max, step: 1, value: String(value) });
    return {
      node: el('div', { class: 'field' }, el('label', { class: 'field__label', for: id }, label), input),
      read: function () {
        var v = Number(input.value);
        if (input.value === '' || !isFinite(v) || Math.floor(v) !== v || v < min || v > max) {
          input.setAttribute('aria-invalid', 'true');
          return null;
        }
        input.removeAttribute('aria-invalid');
        return v;
      }
    };
  }

  function statsIcon() {
    return svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
      svg('path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }));
  }

  function renderSettings(main) {
    var s = S.getSettings();
    var shuffle = el('input', { type: 'checkbox', id: 'set-shuffle', class: 'switch__input', role: 'switch', checked: s.shuffleOptions,
      onchange: function () { S.saveSettings({ shuffleOptions: shuffle.checked }); toast('Saved.'); } });
    main.appendChild(el('section', { class: 'screen' },
      el('a', { class: 'back-link', href: '#/' }, '← All banks'),
      el('h1', { tabindex: '-1' }, 'Settings'),
      el('section', { class: 'card settings-group' },
        el('div', { class: 'setting' },
          el('div', null, el('h2', null, 'Theme'), el('p', { class: 'muted small' }, 'System follows your device setting.')),
          segmented('Theme', [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
            s.theme, function (v) { S.saveSettings({ theme: v }); applyTheme(); })),
        el('div', { class: 'setting setting--stack' },
          el('div', null, el('h2', null, 'Default focus'), el('p', { class: 'muted small' }, 'How strongly practice tests favour your weak questions.')),
          focusControl(s.focus, function (v) { S.saveSettings({ focus: v }); })),
        el('div', { class: 'setting' },
          el('div', null, el('h2', null, el('label', { for: 'set-shuffle' }, 'Shuffle answer options')),
            el('p', { class: 'muted small' }, 'Mixes the option order every time, so you learn the answer rather than its letter.')),
          el('span', { class: 'switch' }, shuffle, el('span', { class: 'switch__track', 'aria-hidden': 'true' })))),
      backupCard(),
      el('section', { class: 'card card--danger' },
        el('h2', null, 'Delete all data'),
        el('p', { class: 'muted small' }, 'Removes every bank, all progress, sessions and settings from this browser.'),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn-danger', type: 'button', onclick: function () {
            typedConfirm('Delete all data?', 'This permanently removes everything this app has stored in this browser.', 'DELETE', 'Delete everything')
              .then(function (ok) {
                if (!ok) return;
                S.deleteAll();
                applyTheme();
                flash = { tone: 'ok', title: 'All data deleted.' };
                go('#/');
              });
          } }, 'Delete all data…'))),
      el('section', { class: 'card card--quiet about' },
        el('h2', null, 'About'),
        el('p', null, 'Everything you upload and all your progress is stored only in this browser on this device. Nothing is sent anywhere. Clearing your browser data deletes it — export a backup regularly.'),
        el('p', { class: 'muted small' }, APP_NAME + ' is an unofficial study tool.'))));
  }

  /* =========================================================
     Theme
     ========================================================= */

  function effectiveTheme() {
    var t = S.getSettings().theme;
    if (t === 'system') {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
      catch (e) { return 'light'; }
    }
    return t;
  }

  function applyTheme() {
    var t = S.getSettings().theme;
    var root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var dark = effectiveTheme() === 'dark';
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      btn.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
      btn.classList.toggle('is-dark', dark);
    }
  }

  function toggleTheme() {
    S.saveSettings({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' });
    applyTheme();
  }

  /* =========================================================
     Router
     ========================================================= */

  function currentRoute() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    if (!parts.length) return { name: 'library' };
    if (parts[0] === 'settings' && parts.length === 1) return { name: 'settings' };
    if (parts[0] === 'bank' && parts[1]) {
      var sub = parts[2];
      if (!sub && parts.length === 2) return { name: 'bank', id: parts[1] };
      if ((sub === 'practice' || sub === 'exam' || sub === 'stats') && parts.length === 3) return { name: sub, id: parts[1] };
    }
    return { name: 'unknown' };
  }

  function go(hash, replace) {
    if (location.hash === hash || (hash === '#/' && !location.hash)) { route(); return; }
    if (replace) location.replace(hash);
    else location.hash = hash;
  }

  function onLeave(fn) { leaveFns.push(fn); }

  function focusHeading() {
    var h = document.querySelector('#main h1');
    if (h) {
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }

  function route() {
    leaveFns.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    leaveFns = [];
    closeDialogs();
    setTimer(null);
    var main = document.getElementById('main');
    clear(main);
    var r = currentRoute();
    var titles = { library: 'Library', settings: 'Settings', bank: null, practice: 'Practice', exam: 'Exam', stats: 'Stats' };
    switch (r.name) {
      case 'library': renderLibrary(main); break;
      case 'settings': renderSettings(main); break;
      case 'bank': renderBankHome(main, r.id); break;
      case 'practice': SET.practice.render(main, r.id); break;
      case 'exam': SET.exam.render(main, r.id); break;
      case 'stats': SET.stats.render(main, r.id); break;
      default: go('#/', true); return;
    }
    var bank = r.id ? S.getEntry(r.id) : null;
    var parts = [titles[r.name], bank ? bank.title : null, APP_NAME].filter(Boolean);
    document.title = parts.join(' · ');
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === r.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!firstRoute) { window.scrollTo(0, 0); focusHeading(); }
    firstRoute = false;
  }

  function rerender() {
    var y = window.scrollY;
    var wasFirst = firstRoute;
    firstRoute = true; // keep focus/scroll where the user is
    route();
    firstRoute = wasFirst;
    window.scrollTo(0, y);
  }

  /* =========================================================
     Boot
     ========================================================= */

  function boot() {
    if (!document.getElementById('main')) return; // e.g. the test page
    S.onProblem(showBanner);
    S.probe();
    applyTheme();
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    } catch (e) { /* old browsers */ }
    // Stop a file dropped outside a drop zone from navigating away.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
    window.addEventListener('hashchange', route);
    route();
  }

  SET.ui = {
    el: el, svg: svg, clear: clear, date: date, clock: clock,
    announce: announce, toast: toast, dialog: dialog, confirm: confirm, typedConfirm: typedConfirm, closeDialogs: closeDialogs,
    callout: callout, progressBar: progressBar, chip: chip, statusBar: statusBar, segmented: segmented,
    focusControl: focusControl, optionList: optionList, explanation: explanation, unverifiedNote: unverifiedNote,
    reviewItem: reviewItem, scoreRing: scoreRing, fact: fact, tile: tile, setTimer: setTimer,
    ensureNoActive: ensureNoActive, go: go, rerender: rerender, onLeave: onLeave, focusHeading: focusHeading
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
