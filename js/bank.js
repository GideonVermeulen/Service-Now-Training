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

  function fallbackId(questionText) { return 'h-' + fnv1a(normText(questionText)); }

  function baseName(fileName) {
    var name = String(fileName || '').split(/[\\/]/).pop();
    return name.replace(/\.[^.]*$/, '').trim();
  }

  function letter(i) { return LETTERS.charAt(i); }

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
    Object.keys(out).forEach(function (t) { out[t] = out[t] * 100 / sum; });
    exam.topicWeights = out;
  }

  // Validates and normalises parsed JSON. Returns { ok, bank, errors, warnings }.
  function normalise(data, fileName) {
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
        errors.push('Question ' + pos + ': must be an object.');
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
        else errors.push('Question ' + pos + ': id must be non-empty text.');
        if (id && reservedName(id)) { errors.push('Question ' + pos + ': id "' + id + '" is a reserved name. Use a different id.'); id = null; }
      }
      var where = 'Question ' + pos + (id ? ' (id ' + id + ')' : '');

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
            var key = normText(o);
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
        if (has(textSeen, tkey)) warnings.push(where + ': same question text as question ' + textSeen[tkey] + '.');
        else textSeen[tkey] = pos;
      }

      if (id) {
        if (has(idSeen, id)) errors.push(where + ': id is already used by question ' + idSeen[id] + '.');
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

  // Parses file text. Never throws.
  function parse(text, fileName) {
    var data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ''));
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

  // Merges progress when a bank's questions are replaced. Progress is dropped for questions
  // whose right answer changed.
  function mergeUpdate(oldBank, newBank, oldProgress) {
    var oldQs = {};
    (oldBank ? oldBank.questions : []).forEach(function (q) { oldQs[q.id] = q; });
    var newIds = {};
    var progress = {};
    var kept = 0, added = 0, reset = 0;
    newBank.questions.forEach(function (q) {
      newIds[q.id] = true;
      if (has(oldQs, q.id)) {
        kept++;
        if (oldProgress && has(oldProgress, q.id)) {
          if (answerChanged(oldQs[q.id], q)) reset++;
          else progress[q.id] = oldProgress[q.id];
        }
      } else added++;
    });
    var removed = Object.keys(oldQs).filter(function (id) { return !has(newIds, id); }).length;
    return { progress: progress, kept: kept, added: added, removed: removed, reset: reset };
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
    summaryText: summaryText,
    answerChanged: answerChanged,
    reservedName: reservedName,
    table: table,
    mergeUpdate: mergeUpdate,
    byId: byId
  };
})();
