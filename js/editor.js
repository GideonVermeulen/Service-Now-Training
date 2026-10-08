/* editor.js — edit a question in place, and download a bank back out as JSON */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var MIN_OPTIONS = 2;
  var MAX_OPTIONS = 10;

  // Validates an edited question with the same rules as an upload.
  // Returns { ok, question, errors }.
  function validate(raw) {
    var res = SET.bank.normalise({ title: 'edit', questions: [raw] }, 'edit.json');
    var errors = res.errors.map(function (e) {
      e = e.replace(/^Question 1( \(id [^)]*\))?: /, '');
      return e === 'answer is empty.' ? 'Tick at least one correct answer.' : e.charAt(0).toUpperCase() + e.slice(1);
    });
    return { ok: !errors.length, question: res.ok ? res.bank.questions[0] : null, errors: errors };
  }

  // Replaces one question in a stored bank. Progress is kept unless the correct answer changed.
  // Returns { ok, resetProgress }.
  function saveQuestion(bankId, edited) {
    var S = SET.storage;
    var bank = S.getBank(bankId);
    if (!bank) return { ok: false };
    var i = bank.questions.map(function (q) { return q.id; }).indexOf(edited.id);
    if (i < 0) return { ok: false };
    var reset = SET.bank.answerChanged(bank.questions[i], edited);
    bank.questions[i] = edited;
    bank.editedAt = new Date().toISOString(); // lets a later re-upload warn before replacing in-app edits
    if (!S.saveBank(bank)) return { ok: false };
    if (reset) {
      var progress = S.getProgress(bankId);
      if (progress[edited.id]) { delete progress[edited.id]; S.saveProgress(bankId, progress, false); }
    }
    return { ok: true, resetProgress: reset };
  }

  // Marks a question verified (or unverified) without opening the editor. Returns true when saved.
  function setVerified(bankId, qid, verified) {
    var bank = SET.storage.getBank(bankId);
    var q = bank && SET.bank.byId(bank)[qid];
    if (!q) return false;
    var edited = JSON.parse(JSON.stringify(q));
    if (verified) delete edited.unverified; else edited.unverified = true;
    return saveQuestion(bankId, edited).ok;
  }

  // Next free id that follows the bank's own pattern: tprm-180 → tprm-181, q007 → q008; else q001.
  function newQuestionId(bank) {
    var ids = Object.create(null);
    bank.questions.forEach(function (q) { ids[q.id] = true; });
    var last = bank.questions.length ? bank.questions[bank.questions.length - 1].id : '';
    var m = /^(.*?)(\d+)$/.exec(last);
    var prefix = m ? m[1] : 'q', width = m ? m[2].length : 3, n = 0;
    bank.questions.forEach(function (q) {
      var x = /^(.*?)(\d+)$/.exec(q.id);
      if (x && x[1] === prefix) n = Math.max(n, Number(x[2]));
    });
    var id;
    do { n++; id = prefix + ('0000000000' + n).slice(-Math.max(width, String(n).length)); } while (ids[id]);
    return id;
  }

  function addQuestion(bankId, q) {
    var S = SET.storage;
    var bank = S.getBank(bankId);
    if (!bank) return { ok: false };
    if (SET.bank.byId(bank)[q.id]) return { ok: false };
    bank.questions.push(q);
    bank.editedAt = new Date().toISOString();
    return { ok: S.saveBank(bank) };
  }

  // Removes a question and its progress. A bank must keep at least one question.
  function deleteQuestion(bankId, qid) {
    var S = SET.storage;
    var bank = S.getBank(bankId);
    if (!bank) return { ok: false, error: 'That bank no longer exists.' };
    if (bank.questions.length <= 1) return { ok: false, error: 'A bank needs at least one question. Delete the whole bank from the Library instead.' };
    var kept = bank.questions.filter(function (q) { return q.id !== qid; });
    if (kept.length === bank.questions.length) return { ok: false, error: 'That question no longer exists.' };
    bank.questions = kept;
    bank.editedAt = new Date().toISOString();
    if (!S.saveBank(bank)) return { ok: false, error: S.QUOTA_MSG };
    var progress = S.getProgress(bankId);
    if (progress[qid]) { delete progress[qid]; S.saveProgress(bankId, progress, false); }
    return { ok: true };
  }

  // Opens the editor for question qid, or for a new question when qid is null.
  // Resolves 'saved', 'reset' (saved, and the right answer changed), 'added', 'deleted', or false.
  function open(bankId, qid) {
    var ui = SET.ui, el = ui.el;
    var bank = SET.storage.getBank(bankId);
    if (!bank) return Promise.resolve(false);
    var isNew = !qid;
    var q = isNew ? { id: newQuestionId(bank), question: '', options: ['', '', '', ''], answer: [] } : SET.bank.byId(bank)[qid];
    if (!q) return Promise.resolve(false);

    var rows = q.options.map(function (text, i) { return { text: text, correct: q.answer.indexOf(i) >= 0 }; });
    var qId = ui.nextId('ed-q'), exId = ui.nextId('ed-ex'), topicId = ui.nextId('ed-topic'), listId = ui.nextId('ed-topics');
    var unvId = ui.nextId('ed-unv');

    var qText = el('textarea', { id: qId, class: 'input textarea', rows: 3 });
    qText.value = q.question;
    var explanation = el('textarea', { id: exId, class: 'input textarea', rows: 3 });
    explanation.value = q.explanation || '';
    var topics = Object.create(null);
    bank.questions.forEach(function (x) { if (x.topic) topics[x.topic] = true; });
    var weights = bank.exam && bank.exam.topicWeights;
    var topicNote = el('p', { class: 'hint' });
    // A topic the exam weights don't name is only used to fill gaps in mock exams.
    function checkTopic() {
      var t = topic.value.trim() || 'Unlabeled';
      topicNote.textContent = weights && !Object.prototype.hasOwnProperty.call(weights, t)
        ? '“' + t + '” isn’t in this bank’s exam topic weights, so mock exams only use it to fill gaps. Add it to "exam.topicWeights" in the JSON to give it a share.'
        : '';
      topicNote.hidden = !topicNote.textContent;
    }
    var topic = el('input', { id: topicId, class: 'input', type: 'text', list: listId, value: q.topic || '', autocomplete: 'off',
      oninput: checkTopic });
    var unverified = el('input', { id: unvId, type: 'checkbox', checked: !!q.unverified });
    var errorBox = el('div', { class: 'field-error', role: 'alert' });
    var optionBox = el('ol', { class: 'editor-options' });
    var addBtn = el('button', { class: 'btn btn-sm', type: 'button', onclick: function () {
      if (rows.length >= MAX_OPTIONS) return;
      rows.push({ text: '', correct: false });
      drawOptions();
      var inputs = optionBox.querySelectorAll('input[type=text]');
      inputs[inputs.length - 1].focus();
    } }, '+ Add option');

    function drawOptions() {
      ui.clear(optionBox);
      rows.forEach(function (row, i) {
        var letter = SET.bank.letter(i);
        var textId = ui.nextId('ed-opt');
        optionBox.appendChild(el('li', { class: 'editor-option' },
          el('label', { class: 'editor-option__correct', title: 'Correct answer' },
            el('input', { type: 'checkbox', checked: row.correct, 'aria-label': 'Option ' + letter + ' is correct',
              onchange: function (e) { row.correct = e.target.checked; } }),
            el('span', { class: 'option__key', 'aria-hidden': 'true' }, letter)),
          el('input', { id: textId, class: 'input', type: 'text', value: row.text, 'aria-label': 'Option ' + letter + ' text',
            oninput: function (e) { row.text = e.target.value; } }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: rows.length <= MIN_OPTIONS,
            'aria-label': 'Remove option ' + letter, title: 'Remove option',
            onclick: function () { rows.splice(i, 1); drawOptions(); } }, '✕')));
      });
      addBtn.disabled = rows.length >= MAX_OPTIONS;
    }
    drawOptions();
    checkTopic();

    function collect() {
      var raw = { id: q.id, question: qText.value, options: rows.map(function (r) { return r.text; }), answer: [] };
      rows.forEach(function (r, i) { if (r.correct) raw.answer.push(i); });
      if (explanation.value.trim()) raw.explanation = explanation.value;
      if (topic.value.trim()) raw.topic = topic.value;
      if (unverified.checked) raw.unverified = true;
      return raw;
    }

    var initial = JSON.stringify(collect());
    // Esc or a click outside only closes when nothing has changed; Cancel always discards.
    function guard() {
      if (JSON.stringify(collect()) === initial) return true;
      errorBox.textContent = 'You have unsaved changes. Save them, or choose Cancel to discard them.';
      return false;
    }

    var result = null;
    function check() {
      var v = validate(collect());
      ui.clear(errorBox);
      if (!v.ok) {
        errorBox.appendChild(el('ul', { class: 'error-list' }, v.errors.map(function (e) { return el('li', null, e); })));
        return false;
      }
      var saved = isNew ? addQuestion(bankId, v.question) : saveQuestion(bankId, v.question);
      if (!saved.ok) { errorBox.textContent = SET.storage.QUOTA_MSG; return false; }
      result = saved;
      return true;
    }

    var body = el('div', { class: 'editor' },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: qId }, 'Question'), qText),
      el('div', { class: 'field' },
        el('p', { class: 'field__label' }, 'Options — tick the correct answer(s)'),
        optionBox,
        el('div', null, addBtn)),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: exId }, 'Explanation (optional)'), explanation),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: topicId }, 'Topic (optional)'), topic,
        el('datalist', { id: listId }, Object.keys(topics).sort().map(function (t) { return el('option', { value: t }); })),
        topicNote),
      el('label', { class: 'editor-check', for: unvId }, unverified, ' Answer not verified yet'),
      el('p', { class: 'muted small' }, (isNew ? 'New questions get the id ' + q.id + '. '
        : 'Changing which answer is correct resets your progress on this question. ') +
        'To keep changes when you next upload this bank, use Download bank.'),
      errorBox);

    var actions = [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: isNew ? 'Add question' : 'Save question', value: true, kind: 'primary', check: check }
    ];
    if (!isNew) actions.unshift({ label: 'Delete question', value: 'delete', kind: 'danger-ghost' });

    return ui.dialog({
      title: isNew ? 'Add question' : 'Edit question', body: body, wide: true, focusEl: qText, actions: actions, guard: guard
    }).then(function (v) {
      if (v === 'delete') {
        return ui.confirm('Delete this question?', '“' + q.question + '” and your progress on it will be removed from this bank. This can’t be undone.', 'Delete question', true)
          .then(function (ok) {
            if (!ok) return false;
            var del = deleteQuestion(bankId, q.id);
            if (!del.ok) { ui.toast(del.error); return false; }
            ui.toast('Question deleted.');
            return 'deleted';
          });
      }
      if (v !== true || !result) return false;
      if (isNew) { ui.toast('Question added.'); return 'added'; }
      ui.toast(result.resetProgress ? 'Question saved. Its progress was reset because the answer changed.' : 'Question saved.');
      return result.resetProgress ? 'reset' : 'saved';
    });
  }

  // The bank in the upload format, with letter answers, so it can be re-uploaded or shared.
  function toJson(bank) {
    var exam = {
      questionCount: bank.exam.questionCount,
      timeLimitMinutes: bank.exam.timeLimitMinutes,
      passMarkPercent: bank.exam.passMarkPercent
    };
    if (bank.exam.topicWeights) {
      exam.topicWeights = {};
      Object.keys(bank.exam.topicWeights).forEach(function (t) {
        exam.topicWeights[t] = Math.round(bank.exam.topicWeights[t] * 100) / 100;
      });
    }
    var out = { title: bank.title };
    if (bank.description) out.description = bank.description;
    out.exam = exam;
    out.questions = bank.questions.map(function (q) {
      var x = { id: q.id, question: q.question, options: q.options.slice() };
      x.answer = q.answer.length === 1 ? SET.bank.letter(q.answer[0]) : q.answer.map(SET.bank.letter);
      if (q.explanation) x.explanation = q.explanation;
      if (q.topic) x.topic = q.topic;
      if (q.unverified) x.unverified = true;
      return x;
    });
    return out;
  }

  function download(bank) {
    var name = String(bank.title).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'bank';
    SET.ui.downloadJson(name + '.json', toJson(bank));
  }

  SET.editor = {
    validate: validate,
    saveQuestion: saveQuestion,
    setVerified: setVerified,
    newQuestionId: newQuestionId,
    addQuestion: addQuestion,
    deleteQuestion: deleteQuestion,
    toJson: toJson,
    open: open,
    download: download
  };
})();
