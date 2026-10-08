/* bank.js — parse, normalise and validate bank JSON (new + legacy format) */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var LETTERS = 'ABCDEFGHIJ';
  var MIN_OPTIONS = 2;
  var MAX_OPTIONS = 10;
  var DEFAULT_EXAM = { questionCount: 60, timeLimitMinutes: 90, passMarkPercent: 70 };
  var KNOWN_TOP = ['title', 'description', 'exam', 'questions'];
  var KNOWN_Q = ['id', 'question', 'options', 'answer', 'explanation', 'topic', 'unverified'];
  var LEGACY = { q: 'question', o: 'options', a: 'answer', u: 'unverified' };

  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // A lookup table with no built-in properties, so keys like "constructor" or "__proto__" are just keys.
  function table() { return Object.create(null); }

  // Names every JavaScript object already has (toString, constructor, __proto__...). As a topic or id
  // they would collide with built-in behaviour, so uploads and the editor reject them.
  function reservedName(s) { return s === '__proto__' || s === 'prototype' || s in Object.prototype; }

  // FNV-1a 32-bit over the UTF-8 bytes of the string, as 8 hex digits.
  function fnv1a(str) {
    var bytes = unescape(encodeURIComponent(str));
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function normText(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  // Options compare case-sensitively (incident.major_incident and Incident.Major_Incident are
  // different answers); only spacing is ignored.
  function optionText(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function fallbackId(questionText) { return 'h-' + fnv1a(normText(questionText)); }

  function baseName(fileName) {
    var name = String(fileName || '').split(/[\\/]/).pop();
    return name.replace(/\.[^.]*$/, '').trim();
  }

  function letter(i) { return LETTERS.charAt(i); }

  function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

  function parseAnswer(raw, n, where, errors) {
    if (raw === undefined || raw === null) { errors.push(where + ': answer is missing.'); return null; }
    var list = Array.isArray(raw) ? raw : [raw];
    if (!list.length) { errors.push(where + ': answer is empty.'); return null; }
    var out = [];
    var ok = true;
    list.forEach(function (a) {
      var idx;
      if (typeof a === 'number') {
        if (!isFinite(a) || Math.floor(a) !== a) {
          errors.push(where + ': answer ' + a + ' is not a whole number.'); ok = false; return;
        }
        if (a < 0 || a >= n) {
          errors.push(where + ': answer index ' + a + ' is out of range (' + n + ' options).'); ok = false; return;
        }
        idx = a;
      } else if (typeof a === 'string') {
        var s = a.trim().toUpperCase();
        if (s.length !== 1 || LETTERS.indexOf(s) < 0) {
          errors.push(where + ': answer "' + a + '" is not a letter (A–J) or an index.'); ok = false; return;
        }
        idx = LETTERS.indexOf(s);
        if (idx >= n) {
          errors.push(where + ': answer letter ' + s + ' is out of range (' + n + ' options).'); ok = false; return;
        }
      } else {
        errors.push(where + ': answer must be a number, a letter, or a list of them.'); ok = false; return;
      }
      if (out.indexOf(idx) < 0) out.push(idx);
    });
    if (!ok) return null;
    return out.sort(function (x, y) { return x - y; });
  }

  function readExam(raw, warnings) {
    var exam = {
      questionCount: DEFAULT_EXAM.questionCount,
      timeLimitMinutes: DEFAULT_EXAM.timeLimitMinutes,
      passMarkPercent: DEFAULT_EXAM.passMarkPercent
    };
    if (raw === undefined || raw === null) return exam;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('"exam" is not an object, so the default exam settings are used.');
      return exam;
    }
    var rules = {
      questionCount: function (v) { return Math.floor(v) === v && v >= 1; },
      timeLimitMinutes: function (v) { return v >= 0 && v <= 1440; },
      passMarkPercent: function (v) { return v >= 0 && v <= 100; }
    };
    Object.keys(raw).forEach(function (k) {
      if (k === 'topicWeights') { readTopicWeights(raw[k], exam, warnings); return; }
      if (!has(rules, k)) { warnings.push('Unknown exam setting "' + k + '" was ignored.'); return; }
      var v = raw[k];
      if (typeof v === 'number' && isFinite(v) && rules[k](v)) exam[k] = v;
      else warnings.push('Exam setting "' + k + '" is not valid, so the default (' + DEFAULT_EXAM[k] + ') is used.');
    });
    return exam;
  }

  // exam.topicWeights: { topic: percent }. Problems are warnings; the result is normalised to sum to 100.
  function readTopicWeights(raw, exam, warnings) {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('"exam.topicWeights" is not an object, so each topic\'s share of the bank is used.');
      return;
    }
    var out = table(), sum = 0;
    Object.keys(raw).forEach(function (t) {
      var v = raw[t];
      if (reservedName(t)) {
        warnings.push('"exam.topicWeights" uses the reserved name "' + t + '", so it was ignored.');
        return;
      }
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) {
        warnings.push('"exam.topicWeights" value for "' + t + '" must be a number from 0 to 100, so it was ignored.');
        return;
      }
      out[t] = v;
      sum += v;
    });
    if (!sum) {
      warnings.push('"exam.topicWeights" has no usable values, so each topic\'s share of the bank is used.');
      return;
    }
    if (Math.abs(sum - 100) > 1) {
      warnings.push('"exam.topicWeights" values sum to ' + Math.round(sum * 100) / 100 + ', not 100 — normalised automatically.');
    }
    // Already 100 (to rounding): kept as given, so a bank written out and read back is unchanged.
    if (Math.abs(sum - 100) > 1e-6) Object.keys(out).forEach(function (t) { out[t] = out[t] * 100 / sum; });
    exam.topicWeights = out;
  }

  // Validates and normalises parsed JSON. Returns { ok, bank, errors, warnings }.
  // labels: optional name for each question in messages (e.g. 'Row 14' for a spreadsheet row);
  // by default 'Question 5'.
  function normalise(data, fileName, labels) {
    var label = function (pos) { return labels && labels[pos - 1] ? labels[pos - 1] : 'Question ' + pos; };
    var errors = [];
    var warnings = [];
    var top, items;

    if (Array.isArray(data)) { top = {}; items = data; }
    else if (data && typeof data === 'object') { top = data; items = data.questions; }
    else {
      errors.push('The file must contain a JSON object with a "questions" list, or a list of questions.');
      return { ok: false, bank: null, errors: errors, warnings: warnings };
    }

    Object.keys(top).forEach(function (k) {
      if (KNOWN_TOP.indexOf(k) < 0) warnings.push('Unknown field "' + k + '" was ignored.');
    });

    if (!Array.isArray(items) || !items.length) {
      errors.push('The bank needs a non-empty "questions" list.');
      return { ok: false, bank: null, errors: errors, warnings: warnings };
    }

    var title = typeof top.title === 'string' ? top.title.trim() : '';
    if (!title) {
      if (has(top, 'title')) warnings.push('"title" is empty or not text, so the file name is used.');
      title = baseName(fileName) || 'Untitled bank';
    }
    var description = '';
    if (typeof top.description === 'string') description = top.description.trim();
    else if (has(top, 'description') && top.description !== null) warnings.push('"description" is not text and was ignored.');

    var exam = readExam(top.exam, warnings);

    var questions = [];
    var idSeen = table();   // id -> position
    var textSeen = table(); // normalised text -> position
    var unknownQ = table(); // field -> count

    items.forEach(function (item, i) {
      var pos = i + 1;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(label(pos) + ': must be an object.');
        return;
      }
      var q = {};
      Object.keys(item).forEach(function (k) {
        var key = has(LEGACY, k) && !has(item, LEGACY[k]) ? LEGACY[k] : k;
        if (KNOWN_Q.indexOf(key) < 0) unknownQ[k] = (unknownQ[k] || 0) + 1;
        else q[key] = item[k];
      });

      var id = null;
      if (has(q, 'id') && q.id !== null) {
        if (typeof q.id === 'number' && isFinite(q.id)) id = String(q.id);
        else if (typeof q.id === 'string' && q.id.trim()) id = q.id.trim();
        else errors.push(label(pos) + ': id must be non-empty text.');
        if (id && reservedName(id)) { errors.push(label(pos) + ': id "' + id + '" is a reserved name. Use a different id.'); id = null; }
      }
      var where = label(pos) + (id ? ' (id ' + id + ')' : '');

      var text = typeof q.question === 'string' ? q.question.trim() : '';
      if (!text) errors.push(where + ': question text is missing.');

      var options = null;
      if (!Array.isArray(q.options)) {
        errors.push(where + ': options must be a list of ' + MIN_OPTIONS + '–' + MAX_OPTIONS + ' answers.');
      } else if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
        errors.push(where + ': has ' + q.options.length + ' options (needs ' + MIN_OPTIONS + '–' + MAX_OPTIONS + ').');
      } else {
        var optOk = true;
        options = q.options.map(function (o, oi) {
          if (typeof o === 'number' && isFinite(o)) o = String(o);
          if (typeof o !== 'string' || !o.trim()) {
            errors.push(where + ': option ' + letter(oi) + ' is empty or not text.');
            optOk = false;
            return '';
          }
          return o.trim();
        });
        if (!optOk) options = null;
        else {
          var seenOpt = table();
          options.forEach(function (o, oi) {
            var key = optionText(o);
            if (has(seenOpt, key)) warnings.push(where + ': options ' + letter(seenOpt[key]) + ' and ' + letter(oi) + ' have the same text.');
            else seenOpt[key] = oi;
          });
        }
      }

      var answer = options ? parseAnswer(q.answer, options.length, where, errors) : null;

      var out = { id: id, question: text, options: options || [], answer: answer || [] };
      ['explanation', 'topic'].forEach(function (k) {
        if (!has(q, k) || q[k] === null) return;
        if (typeof q[k] !== 'string') { errors.push(where + ': ' + k + ' must be text.'); return; }
        if (q[k].trim()) out[k] = q[k].trim();
      });
      if (out.topic && reservedName(out.topic)) {
        errors.push(where + ': topic "' + out.topic + '" is a reserved name. Use a different topic name.');
      }
      if (has(q, 'unverified') && q.unverified !== null) {
        if (typeof q.unverified !== 'boolean') errors.push(where + ': unverified must be true or false.');
        else if (q.unverified) out.unverified = true;
      }

      if (text) {
        var tkey = normText(text);
        if (has(textSeen, tkey)) warnings.push(where + ': same question text as ' + lowerFirst(label(textSeen[tkey])) + '.');
        else textSeen[tkey] = pos;
      }

      if (id) {
        if (has(idSeen, id)) errors.push(where + ': id is already used by ' + lowerFirst(label(idSeen[id])) + '.');
        else idSeen[id] = pos;
      }
      out._pos = pos;
      questions.push(out);
    });

    // Fallback ids are assigned after explicit ids so they can't steal one.
    questions.forEach(function (q) {
      if (q.id || !q.question) return;
      var base = fallbackId(q.question);
      var candidate = base;
      for (var n = 2; has(idSeen, candidate); n++) candidate = base + '-' + n;
      q.id = candidate;
      idSeen[candidate] = q._pos;
    });
    questions.forEach(function (q) { delete q._pos; });

    Object.keys(unknownQ).forEach(function (k) {
      warnings.push('Unknown question field "' + k + '" was ignored (' + unknownQ[k] + (unknownQ[k] === 1 ? ' question).' : ' questions).'));
    });

    if (errors.length) return { ok: false, bank: null, errors: errors, warnings: warnings };

    var anyTopic = questions.some(function (q) { return q.topic; });
    if (exam.topicWeights) {
      var topicSeen = {};
      questions.forEach(function (q) { topicSeen[q.topic || 'Unlabeled'] = true; });
      Object.keys(exam.topicWeights).forEach(function (t) {
        if (!has(topicSeen, t)) warnings.push('"exam.topicWeights" names topic "' + t + '", but no question has that topic.');
      });
    } else if (!(top.exam && typeof top.exam === 'object' && has(top.exam, 'topicWeights'))) {
      // Missing weights are fine, but say what mock exams will do instead. (Unusable weights already warned above.)
      warnings.push(anyTopic
        ? 'No "exam.topicWeights" in this bank, so mock exams follow the bank\'s own topic mix, not the real exam\'s blueprint.'
        : 'No topics or "exam.topicWeights" in this bank, so mock exams draw questions at random and Practice has no topic filter.');
    }

    return {
      ok: true,
      errors: errors,
      warnings: warnings,
      bank: { title: title, description: description, exam: exam, questions: questions }
    };
  }

  /* ---------- CSV (spreadsheet) format ---------- */

  // Settings rows: "#key,value[,value]". Keys are case-insensitive.
  var CSV_SETTINGS = { title: 'title', description: 'description', questioncount: 'questionCount',
    timelimitminutes: 'timeLimitMinutes', passmarkpercent: 'passMarkPercent', weight: 'weight' };
  var CSV_TRUE = ['yes', 'true', '1', 'y'], CSV_FALSE = ['', 'no', 'false', '0', 'n'];

  // Header cell → column key: 'id', 'question', 'answer', 'explanation', 'topic', 'unverified',
  // 'opt:<index>' for option columns (A… or "option a"…), or null when unknown.
  function csvColumn(name) {
    var n = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
    var aliases = { id: 'id', question: 'question', 'question text': 'question', answer: 'answer', correct: 'answer',
      'correct answer': 'answer', explanation: 'explanation', topic: 'topic', domain: 'topic', unverified: 'unverified' };
    if (has(aliases, n)) return aliases[n];
    var m = /^(?:option )?([a-z])$/.exec(n);
    return m ? 'opt:' + (m[1].charCodeAt(0) - 97) : null;
  }

  // A settings value as a number when it looks like one (a decimal comma is fine), else the text,
  // so readExam can warn about it.
  function csvNumber(v) {
    var s = String(v).trim();
    return /^-?\d+([.,]\d+)?$/.test(s) ? Number(s.replace(',', '.')) : s;
  }

  // Spreadsheet rows (csv.parseCsv) → the same object a JSON bank file holds, plus a "Row N" label
  // for each question. Problems that can only happen in a spreadsheet are reported here; everything
  // else is left to normalise. Returns { data, labels, errors, warnings }.
  function csvToData(rows) {
    var errors = [], warnings = [], labels = [], items = [];
    var top = {}, exam = {}, weights = table(), hasWeights = false, header = null, cols = null;
    var unprotect = SET.csv.unprotect;

    rows.forEach(function (r) {
      var cells = r.cells.map(function (c) { return unprotect(c); });
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop(); // trailing empty cells
      if (!cells.length) return; // blank row
      var first = cells[0].trim();
      if (first.charAt(0) === '#') {
        var key = first.slice(1).trim().toLowerCase();
        var vals = cells.slice(1);
        if (!has(CSV_SETTINGS, key)) { warnings.push('Row ' + r.row + ': unknown setting "' + first + '" was ignored.'); return; }
        var k = CSV_SETTINGS[key];
        if (k === 'weight') {
          if (vals.length < 2) { warnings.push('Row ' + r.row + ': #weight needs a topic and a number, so it was ignored.'); return; }
          weights[vals.slice(0, -1).join(',').trim()] = csvNumber(vals[vals.length - 1]);
          hasWeights = true;
        } else if (k === 'title' || k === 'description') top[k] = vals.join(','); // an unquoted comma split the text: put it back
        else exam[k] = csvNumber(vals.join(''));
        return;
      }
      if (!header) {
        header = r;
        cols = cells.map(csvColumn);
        var seen = table();
        cells.forEach(function (name, i) {
          var c = cols[i];
          if (!c) {
            if (name.trim()) warnings.push('Column "' + name.trim() + '" was ignored (not a known column).');
            return;
          }
          if (/^opt:/.test(c) && Number(c.slice(4)) >= MAX_OPTIONS) {
            errors.push('Row ' + r.row + ': column "' + name.trim() + '" is one option too many. A question can have up to ' + MAX_OPTIONS + ' options (A–J).');
            cols[i] = null;
            return;
          }
          if (has(seen, c)) { errors.push('Row ' + r.row + ': column "' + name.trim() + '" appears twice.'); cols[i] = null; return; }
          seen[c] = true;
        });
        if (!has(seen, 'question')) errors.push('Row ' + r.row + ': the header row has no "question" column.');
        if (!has(seen, 'answer')) errors.push('Row ' + r.row + ': the header row has no "answer" column.');
        if (!has(seen, 'opt:0')) errors.push('Row ' + r.row + ': the header row has no option columns (A, B, C…).');
        if (!has(seen, 'id')) warnings.push('There is no "id" column, so ids were made from the question text. Add an id column so editing a question keeps your progress.');
        return;
      }

      var where = 'Row ' + r.row;
      var opts = [], item = {}, rowOk = true;
      cols.forEach(function (c, i) {
        if (!c) return;
        var v = i < cells.length ? cells[i] : '';
        if (/^opt:/.test(c)) opts[Number(c.slice(4))] = v;
        else if (c === 'id') { if (v.trim()) item.id = v; }
        else if (c === 'answer') {
          var parts = v.split(/[\s;,]+/).filter(Boolean);
          var numeric = parts.filter(function (x) { return /^\d+$/.test(x); });
          if (numeric.length) { errors.push(where + ': answer "' + v.trim() + '" must be letters (A–J), for example B or A;D. Numbers aren\'t used in spreadsheets.'); rowOk = false; }
          else if (parts.length) item.answer = parts.length === 1 ? parts[0] : parts;
        } else if (c === 'unverified') {
          var u = v.trim().toLowerCase();
          if (CSV_TRUE.indexOf(u) >= 0) item.unverified = true;
          else if (CSV_FALSE.indexOf(u) < 0) item.unverified = v.trim(); // normalise reports it
        } else if (v.trim()) item[c] = v;
      });
      // Options: from A up to the last filled column, with no gaps, so the answer letters match the columns.
      var last = -1;
      for (var o = 0; o < opts.length; o++) if (opts[o] !== undefined && opts[o].trim()) last = o;
      for (var g = 0; g < last; g++) {
        if (opts[g] === undefined || !opts[g].trim()) {
          errors.push(where + ': option ' + letter(g) + ' is empty but a later option is filled. The answer letters must match the columns, so fill the gap or move the options up.');
          rowOk = false;
          break;
        }
      }
      item.options = opts.slice(0, last + 1);
      if (!rowOk) return;
      items.push(item);
      labels.push(where);
    });

    if (!header) errors.push('No header row found. The first row that isn\'t blank or a # setting must name the columns: id, question, A, B, C, D, answer…');
    if (hasWeights) exam.topicWeights = weights;
    if (Object.keys(exam).length) top.exam = exam;
    top.questions = items;
    return { data: top, labels: labels, errors: errors, warnings: warnings };
  }

  function parseCsvBank(text, fileName) {
    var parsed = SET.csv.parseCsv(text);
    if (parsed.error) return { ok: false, bank: null, warnings: [], errors: [parsed.error] };
    var c = csvToData(parsed.rows);
    if (!c.data.questions.length && !c.errors.length) c.errors.push('The spreadsheet has no question rows under the header.');
    var res = c.data.questions.length ? normalise(c.data, fileName, c.labels) : { ok: false, bank: null, errors: [], warnings: [] };
    var errors = c.errors.concat(res.errors);
    var warnings = c.warnings.concat(res.warnings.map(function (w) { return w.replace(/"exam\.topicWeights"/g, '#weight rows'); }));
    if (errors.length) return { ok: false, bank: null, errors: errors, warnings: warnings };
    return { ok: true, bank: res.bank, errors: [], warnings: warnings };
  }

  // The bank as spreadsheet text (settings rows, header, one row per question) for Excel.
  function bankToCsv(bank) {
    var p = SET.csv.protect;
    var rows = [['#title', p(bank.title)]];
    if (bank.description) rows.push(['#description', p(bank.description)]);
    rows.push(['#questionCount', String(bank.exam.questionCount)],
      ['#timeLimitMinutes', String(bank.exam.timeLimitMinutes)],
      ['#passMarkPercent', String(bank.exam.passMarkPercent)]);
    if (bank.exam.topicWeights) {
      Object.keys(bank.exam.topicWeights).forEach(function (t) { rows.push(['#weight', p(t), String(bank.exam.topicWeights[t])]); });
    }
    var width = bank.questions.reduce(function (m, q) { return Math.max(m, q.options.length); }, MIN_OPTIONS);
    var head = ['id', 'question'];
    for (var i = 0; i < width; i++) head.push(letter(i));
    rows.push(head.concat(['answer', 'explanation', 'topic', 'unverified']));
    bank.questions.forEach(function (q) {
      var row = [p(q.id), p(q.question)];
      for (var j = 0; j < width; j++) row.push(p(q.options[j] || ''));
      row.push(q.answer.map(letter).join(';'), p(q.explanation || ''), p(q.topic || ''), q.unverified ? 'yes' : '');
      rows.push(row);
    });
    return SET.csv.toCsv(rows);
  }

  // True for a spreadsheet: a .csv name, or (with no telling extension) text that doesn't start like JSON.
  function looksLikeCsv(text, fileName) {
    var name = String(fileName || '').toLowerCase();
    if (/\.csv$/.test(name)) return true;
    if (/\.json$/.test(name)) return false;
    var first = String(text).replace(/^﻿/, '').replace(/^\s+/, '').charAt(0);
    return first !== '{' && first !== '[' && first !== '';
  }

  // Parses file text (JSON or CSV). Never throws.
  function parse(text, fileName) {
    text = String(text);
    if (text.length > SET.csv.MAX_BYTES) return { ok: false, bank: null, warnings: [], errors: [SET.csv.TOO_LARGE] };
    if (looksLikeCsv(text, fileName)) return parseCsvBank(text, fileName);
    var data;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      return { ok: false, bank: null, warnings: [], errors: ['The file is not valid JSON: ' + e.message] };
    }
    return normalise(data, fileName);
  }

  function summaryText(bank, warningCount) {
    var unverified = bank.questions.filter(function (q) { return q.unverified; }).length;
    var n = bank.questions.length;
    return "Bank '" + bank.title + "', " + n + (n === 1 ? ' question, ' : ' questions, ') +
      unverified + ' unverified, ' + warningCount + (warningCount === 1 ? ' warning' : ' warnings');
  }

  // True when a question's right answer is now different text, so old progress no longer applies.
  // Reordering options, adding a distractor or fixing a typo is not a change; making a former
  // wrong option the answer (even at the same letter) is.
  function answerChanged(before, after) {
    function texts(q, right) {
      return q.options.filter(function (o, i) { return (q.answer.indexOf(i) >= 0) === right; }).map(normText).sort();
    }
    var oldRight = texts(before, true), newRight = texts(after, true), oldWrong = texts(before, false);
    if (JSON.stringify(oldRight) === JSON.stringify(newRight)) return false;
    var sameLetters = JSON.stringify(before.answer.slice().sort()) === JSON.stringify(after.answer.slice().sort());
    return !sameLetters || newRight.some(function (t) { return oldWrong.indexOf(t) >= 0; });
  }

  /* ---------- clean-up of duplicates ---------- */

  // Question wordings (normalised) you've confirmed are different questions: bank.keepDuplicates.
  function keptDuplicates(bank) {
    var out = table();
    (Array.isArray(bank.keepDuplicates) ? bank.keepDuplicates : []).forEach(function (k) { if (typeof k === 'string') out[k] = true; });
    return out;
  }

  // Every group of questions with the same wording, for review. exact: all copies are identical
  // (Clean up could remove them without asking). Wordings in bank.keepDuplicates are skipped.
  // Returns [{ key (normalised wording), ids, exact }] in bank order.
  function duplicateGroups(bank) {
    var keepAll = keptDuplicates(bank), byText = table(), keys = [];
    bank.questions.forEach(function (q) {
      var k = normText(q.question);
      if (!byText[k]) { byText[k] = []; keys.push(k); }
      byText[k].push(q);
    });
    return keys.filter(function (k) { return byText[k].length > 1 && !keepAll[k]; }).map(function (k) {
      var contents = table(), n = 0;
      byText[k].forEach(function (q) { var c = contentKey(q); if (!contents[c]) { contents[c] = true; n++; } });
      return { key: k, ids: byText[k].map(function (q) { return q.id; }), exact: n === 1 };
    });
  }

  // A question's content, ignoring case, spacing, option order and which letter the answer has.
  function contentKey(q) {
    var right = [], wrong = [];
    q.options.forEach(function (o, i) { (q.answer.indexOf(i) >= 0 ? right : wrong).push(optionText(o)); });
    return JSON.stringify([normText(q.question), right.sort(), wrong.sort()]);
  }

  // Fixes what can be fixed without guessing. Returns a new bank plus what changed:
  //   identical questions (same wording, options and right answer): one copy is kept, the one with
  //     the most progress (else the first), and gains a missing explanation or topic from the others;
  //   an option listed twice in a question: the second copy is removed and answer letters move up.
  // Left alone and listed in `manual`: same wording with different options or answers, and a
  // repeated option that would leave fewer than 2 options or where both copies are marked right.
  // Returns { bank, removedIds, fixedIds, manual: [text] }.
  function cleanDuplicates(bank, progress) {
    var out = JSON.parse(JSON.stringify(bank));
    var fixedIds = [], manual = [], removed = table();
    var seenCount = function (id) { var p = progress && has(progress, id) ? progress[id] : null; return p && (p.reps || p.seen) || 0; };

    out.questions.forEach(function (q) {
      var first = table(), drop = [], ok = true;
      q.options.forEach(function (o, i) {
        var k = optionText(o);
        if (!has(first, k)) { first[k] = i; return; }
        if (q.answer.indexOf(i) >= 0 && q.answer.indexOf(first[k]) >= 0) ok = false; // both copies marked right
        drop.push(i);
      });
      if (!drop.length) return;
      if (!ok || q.options.length - drop.length < MIN_OPTIONS) {
        manual.push('Question ' + q.id + ': the repeated option "' + q.options[drop[0]] + '" needs a manual fix' +
          (!ok ? ' (both copies are marked correct).' : ' (removing it would leave too few options).'));
        return;
      }
      var newIndex = [], kept = [];
      q.options.forEach(function (o, i) {
        if (drop.indexOf(i) >= 0) { newIndex[i] = newIndex[first[optionText(o)]]; return; }
        newIndex[i] = kept.length;
        kept.push(o);
      });
      var answer = [];
      q.answer.forEach(function (a) { if (answer.indexOf(newIndex[a]) < 0) answer.push(newIndex[a]); });
      q.options = kept;
      q.answer = answer.sort(function (x, y) { return x - y; });
      fixedIds.push(q.id);
    });

    var byText = table();
    var keepAll = keptDuplicates(out);
    out.questions.forEach(function (q) { var k = normText(q.question); (byText[k] = byText[k] || []).push(q); });
    Object.keys(byText).forEach(function (k) {
      var group = byText[k];
      if (group.length < 2 || keepAll[k]) return; // you chose to keep every question with this wording
      var byContent = table();
      group.forEach(function (q) { var c = contentKey(q); (byContent[c] = byContent[c] || []).push(q); });
      var variants = Object.keys(byContent);
      if (variants.length > 1) {
        manual.push('"' + group[0].question.slice(0, 80) + (group[0].question.length > 80 ? '…' : '') + '" appears ' + group.length +
          ' times with different options or answers (ids ' + group.map(function (q) { return q.id; }).join(', ') + '). Use Review duplicates to choose which to keep.');
      }
      variants.forEach(function (c) {
        var copies = byContent[c];
        if (copies.length < 2) return;
        var keep = copies.reduce(function (best, q) { return seenCount(q.id) > seenCount(best.id) ? q : best; }, copies[0]);
        copies.forEach(function (q) {
          if (q === keep) return;
          if (!keep.explanation && q.explanation) keep.explanation = q.explanation;
          if (!keep.topic && q.topic) keep.topic = q.topic;
          removed[q.id] = true;
        });
      });
    });
    out.questions = out.questions.filter(function (q) { return !removed[q.id]; });
    var removedIds = Object.keys(removed);
    return { bank: out, removedIds: removedIds, fixedIds: fixedIds.filter(function (id) { return !removed[id]; }), manual: manual };
  }

  // Merges progress when a bank's questions are replaced. Progress is dropped for questions
  // whose right answer changed. dropIds lists the questions whose history no longer applies
  // (removed, or answer changed), so their review log entries can go too.
  function mergeUpdate(oldBank, newBank, oldProgress) {
    var oldQs = table();
    (oldBank ? oldBank.questions : []).forEach(function (q) { oldQs[q.id] = q; });
    var newIds = table();
    var progress = {};
    var kept = 0, added = 0, reset = 0, dropIds = [];
    newBank.questions.forEach(function (q) {
      newIds[q.id] = true;
      if (has(oldQs, q.id)) {
        kept++;
        if (answerChanged(oldQs[q.id], q)) {
          dropIds.push(q.id);
          if (oldProgress && has(oldProgress, q.id)) reset++;
        } else if (oldProgress && has(oldProgress, q.id)) progress[q.id] = oldProgress[q.id];
      } else added++;
    });
    var removedIds = Object.keys(oldQs).filter(function (id) { return !has(newIds, id); });
    return { progress: progress, kept: kept, added: added, removed: removedIds.length, reset: reset, dropIds: dropIds.concat(removedIds) };
  }

  function byId(bank) {
    var map = table();
    bank.questions.forEach(function (q) { map[q.id] = q; });
    return map;
  }

  SET.bank = {
    LETTERS: LETTERS,
    DEFAULT_EXAM: DEFAULT_EXAM,
    fnv1a: fnv1a,
    normText: normText,
    fallbackId: fallbackId,
    baseName: baseName,
    letter: letter,
    parse: parse,
    normalise: normalise,
    csvToData: csvToData,
    bankToCsv: bankToCsv,
    looksLikeCsv: looksLikeCsv,
    summaryText: summaryText,
    answerChanged: answerChanged,
    cleanDuplicates: cleanDuplicates,
    duplicateGroups: duplicateGroups,
    reservedName: reservedName,
    table: table,
    mergeUpdate: mergeUpdate,
    byId: byId
  };
})();
