/* storage.js — localStorage wrapper, schema versioning, backup export/import */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var prefix = 'set:v1:';
  var SCHEMA_VERSION = 2; // 2: FSRS progress records (older records are converted when read)
  var SESSION_CAP = 200;
  var REVIEW_CAP = 30; // exam sessions that keep their full answer review
  var QUOTA_MSG = 'Storage full — export a backup and delete unused banks.';
  var UNAVAILABLE_MSG = 'Browser storage is unavailable, so nothing will be saved. Allow site data for this page, or use a normal (not private) window.';
  var BACKUP_FORMAT = 'set-backup';

  var listeners = [];
  var lastProblem = null;

  function report(msg) {
    lastProblem = msg;
    listeners.forEach(function (fn) { try { fn(msg); } catch (e) { /* ignore */ } });
  }

  function isQuota(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }

  function get(key, fallback) {
    var raw = null;
    try { raw = window.localStorage.getItem(prefix + key); }
    catch (e) { report(UNAVAILABLE_MSG); }
    if (raw === null || raw === undefined) return fallback === undefined ? null : fallback;
    try { return JSON.parse(raw); }
    catch (e) { return fallback === undefined ? null : fallback; }
  }

  function set(key, value) {
    try {
      window.localStorage.setItem(prefix + key, JSON.stringify(value));
      return true;
    } catch (e) {
      report(isQuota(e) ? QUOTA_MSG : UNAVAILABLE_MSG);
      return false;
    }
  }

  function remove(key) {
    try { window.localStorage.removeItem(prefix + key); return true; }
    catch (e) { report(UNAVAILABLE_MSG); return false; }
  }

  function keys() {
    var out = [];
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
      }
    } catch (e) { report(UNAVAILABLE_MSG); }
    return out;
  }

  function newId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) { /* not a secure context — fall through */ }
    var s = '';
    for (var i = 0; i < 4; i++) s += Math.floor((1 + Math.random()) * 0x100000000).toString(16).slice(1);
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20, 32);
  }

  function nowIso() { return new Date().toISOString(); }

  /* ---------- index + migration ---------- */

  // Upgrades an index (and the data it points to) from older schema versions.
  // Version 1 → 2 needs no rewrite here: old progress records are converted when read (weighting.js).
  // The bump makes older copies of the app refuse newer backups instead of misreading them.
  function migrate(index) {
    if (!index || typeof index !== 'object') index = { version: SCHEMA_VERSION, banks: [] };
    if (!Array.isArray(index.banks)) index.banks = [];
    if (!index.version) index.version = SCHEMA_VERSION;
    if (index.version < 2) index.version = 2;
    return index;
  }

  function getIndex() { return migrate(get('index')); }

  function saveIndex(index) {
    index.version = SCHEMA_VERSION;
    return set('index', index);
  }

  function getEntry(bankId) {
    var list = getIndex().banks;
    for (var i = 0; i < list.length; i++) if (list[i].id === bankId) return list[i];
    return null;
  }

  // Sets fields on a bank's index entry (updatedAt, lastStudied, examDate as "YYYY-MM-DD" or null, ...).
  function touch(bankId, fields) {
    var index = getIndex();
    for (var i = 0; i < index.banks.length; i++) {
      if (index.banks[i].id === bankId) {
        Object.keys(fields).forEach(function (k) { index.banks[i][k] = fields[k]; });
        return saveIndex(index);
      }
    }
    return false;
  }

  /* ---------- banks ---------- */

  function getBank(bankId) { return get('bank:' + bankId); }

  // Saves a normalised bank. Creates the index entry if it is new.
  function saveBank(bank) {
    var now = nowIso();
    if (!set('bank:' + bank.id, bank)) return false;
    var index = getIndex();
    var entry = null;
    for (var i = 0; i < index.banks.length; i++) if (index.banks[i].id === bank.id) entry = index.banks[i];
    if (!entry) {
      entry = { id: bank.id, createdAt: now, lastStudied: null };
      index.banks.push(entry);
    }
    entry.title = bank.title;
    entry.questionCount = bank.questions.length;
    entry.updatedAt = now;
    return saveIndex(index);
  }

  function deleteBank(bankId) {
    remove('bank:' + bankId);
    remove('progress:' + bankId);
    remove('sessions:' + bankId);
    var active = getActive();
    if (active && active.bankId === bankId) clearActive();
    var index = getIndex();
    index.banks = index.banks.filter(function (b) { return b.id !== bankId; });
    return saveIndex(index);
  }

  /* ---------- progress + sessions ---------- */

  function getProgress(bankId) {
    var p = get('progress:' + bankId, {});
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  }

  function saveProgress(bankId, progress, studied) {
    if (!set('progress:' + bankId, progress)) return false;
    var fields = { updatedAt: nowIso() };
    if (studied) fields.lastStudied = fields.updatedAt;
    return touch(bankId, fields);
  }

  function getSessions(bankId) {
    var s = get('sessions:' + bankId, []);
    return Array.isArray(s) ? s : [];
  }

  function addSession(bankId, summary) {
    var list = getSessions(bankId);
    list.push(summary);
    if (list.length > SESSION_CAP) list = list.slice(-SESSION_CAP);
    var withReview = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].review && ++withReview > REVIEW_CAP) delete list[i].review;
    }
    if (!set('sessions:' + bankId, list)) return false;
    return touch(bankId, { updatedAt: nowIso(), lastStudied: nowIso() });
  }

  function clearStudy(bankId) {
    remove('progress:' + bankId);
    remove('sessions:' + bankId);
    var active = getActive();
    if (active && active.bankId === bankId) clearActive();
    return touch(bankId, { updatedAt: nowIso(), lastStudied: null });
  }

  /* ---------- active session ---------- */

  function getActive() {
    var a = get('active');
    return a && typeof a === 'object' && a.bankId ? a : null;
  }
  function setActive(session) { return set('active', session); }
  function clearActive() { return remove('active'); }

  /* ---------- settings ---------- */

  var DEFAULT_SETTINGS = { theme: 'system', focus: 2, shuffleOptions: true };

  function getSettings() {
    var s = get('settings', {}) || {};
    var out = {
      theme: ['system', 'light', 'dark'].indexOf(s.theme) >= 0 ? s.theme : DEFAULT_SETTINGS.theme,
      focus: typeof s.focus === 'number' && s.focus >= 0 && s.focus <= 5 ? Math.floor(s.focus) : DEFAULT_SETTINGS.focus,
      shuffleOptions: typeof s.shuffleOptions === 'boolean' ? s.shuffleOptions : DEFAULT_SETTINGS.shuffleOptions
    };
    return out;
  }

  function saveSettings(patch) {
    var s = getSettings();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    set('settings', s);
    return s;
  }

  /* ---------- backup ---------- */

  function exportBackup() {
    var data = {
      format: BACKUP_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: nowIso(),
      settings: getSettings(),
      banks: []
    };
    getIndex().banks.forEach(function (entry) {
      var bank = getBank(entry.id);
      if (!bank) return;
      data.banks.push({
        entry: entry,
        bank: bank,
        progress: getProgress(entry.id),
        sessions: getSessions(entry.id)
      });
    });
    return data;
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function count(v) { return isNum(v) && v >= 0 ? Math.floor(v) : 0; }
  function dateOrNull(v) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null; }

  // A progress record from a backup with every value checked. null when its core is unusable,
  // so that question simply starts as New. Handles both the current and the pre-FSRS shape.
  function cleanRecord(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var out = { seen: count(p.seen), correct: count(p.correct), streak: count(p.streak) };
    out.correct = Math.min(out.correct, out.seen);
    if (p.reps === undefined) { // pre-FSRS record, converted when read
      if (!out.seen) return null;
      out.lastSeen = dateOrNull(p.lastSeen);
      out.lastCorrect = typeof p.lastCorrect === 'boolean' ? p.lastCorrect : null;
      return out;
    }
    if (!isNum(p.reps) || p.reps < 1) return null;
    if (!isNum(p.stability) || p.stability <= 0 || !isNum(p.difficulty) || p.difficulty < 1 || p.difficulty > 10) return null;
    out.reps = Math.floor(p.reps);
    out.lapses = count(p.lapses);
    out.stability = p.stability;
    out.difficulty = p.difficulty;
    out.due = dateOrNull(p.due);
    out.lastReview = dateOrNull(p.lastReview);
    out.lastAnswered = dateOrNull(p.lastAnswered);
    out.lastGrade = [1, 2, 3, 4].indexOf(p.lastGrade) >= 0 ? p.lastGrade : null;
    if (p.daySeen !== undefined) {
      out.daySeen = count(p.daySeen);
      out.dayCorrect = Math.min(count(p.dayCorrect), out.daySeen);
    }
    return out;
  }

  // A session summary from a backup with every value checked; null when it can't be shown.
  function cleanSession(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if ((s.mode !== 'practice' && s.mode !== 'exam') || !isNum(s.scorePercent) || s.scorePercent < 0 || s.scorePercent > 100 ||
      !isNum(s.size) || s.size < 1 || !dateOrNull(s.endedAt)) return null;
    var out = {
      id: typeof s.id === 'string' ? s.id : newId(), mode: s.mode,
      startedAt: dateOrNull(s.startedAt) || s.endedAt, endedAt: s.endedAt,
      size: Math.floor(s.size), firstAttemptCorrect: Math.min(count(s.firstAttemptCorrect), Math.floor(s.size)),
      scorePercent: s.scorePercent
    };
    if (isNum(s.focus)) out.focus = s.focus;
    if (s.mode === 'exam') {
      out.passed = !!s.passed;
      if (isNum(s.passMarkPercent)) out.passMarkPercent = s.passMarkPercent;
      if (isNum(s.timeUsedSec)) out.timeUsedSec = Math.max(0, s.timeUsedSec);
      if (isNum(s.answered)) out.answered = Math.min(count(s.answered), out.size);
      if (isNum(s.predicted) && s.predicted >= 0 && s.predicted <= 100) out.predicted = s.predicted;
      var rv = s.review;
      if (rv && Array.isArray(rv.items)) {
        var items = rv.items.filter(function (i) { return i && typeof i.id === 'string'; }).map(function (i) {
          return { id: i.id, selected: Array.isArray(i.selected) ? i.selected.filter(isNum) : [], correct: i.correct === true, flagged: i.flagged === true };
        });
        var byTopic = Array.isArray(rv.byTopic) ? rv.byTopic.filter(function (t) {
          return t && typeof t.topic === 'string' && isNum(t.correct) && isNum(t.total) && isNum(t.scorePercent);
        }).map(function (t) {
          return { topic: t.topic, correct: t.correct, total: t.total, scorePercent: t.scorePercent, weight: isNum(t.weight) ? t.weight : null };
        }) : null;
        out.review = { items: items, byTopic: byTopic && byTopic.length ? byTopic : null };
      }
    }
    return out;
  }

  // Rebuilds one backup item from trusted parts: the bank goes through the same checks as an upload
  // (bank.js normalise), progress keeps only record objects, sessions only objects.
  // Returns { ok, item } or { ok: false, title, error }.
  function cleanBackupItem(item, n) {
    var title = item && item.bank && typeof item.bank.title === 'string' && item.bank.title.trim() ? item.bank.title.trim() : 'Bank ' + n;
    if (!item || !item.entry || typeof item.entry.id !== 'string' || !item.entry.id.trim() || !item.bank) {
      return { ok: false, title: title, error: 'it is incomplete' };
    }
    var res = SET.bank && SET.bank.normalise ? SET.bank.normalise(item.bank, title) : { ok: false, errors: ['the app could not check it'] };
    if (!res.ok) return { ok: false, title: title, error: res.errors[0] || 'it is damaged' };
    var bank = res.bank;
    if (typeof item.bank.editedAt === 'string') bank.editedAt = item.bank.editedAt;
    var progress = {};
    var rawProgress = item.progress && typeof item.progress === 'object' && !Array.isArray(item.progress) ? item.progress : {};
    var known = SET.bank.byId(bank);
    Object.keys(rawProgress).forEach(function (id) {
      var p = known[id] ? cleanRecord(rawProgress[id]) : null; // only questions that exist in this bank
      if (p) progress[id] = p;
    });
    var entry = item.entry;
    var isDate = function (v) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null; };
    return { ok: true, item: {
      entry: {
        id: entry.id.trim(), title: bank.title,
        createdAt: isDate(entry.createdAt), updatedAt: isDate(entry.updatedAt), lastStudied: isDate(entry.lastStudied),
        examDate: typeof entry.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.examDate) ? entry.examDate : null,
        examDatePrompted: !!entry.examDatePrompted
      },
      bank: bank,
      progress: progress,
      sessions: Array.isArray(item.sessions) ? item.sessions.map(cleanSession).filter(Boolean) : []
    } };
  }

  // Returns an error string, or null if the backup looks usable.
  function checkBackup(data) {
    if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT || !Array.isArray(data.banks)) {
      return 'This file is not a backup from this app.';
    }
    if (typeof data.version === 'number' && data.version > SCHEMA_VERSION) {
      return 'This backup comes from a newer version of the app.';
    }
    for (var i = 0; i < data.banks.length; i++) {
      var item = data.banks[i];
      if (!item || !item.entry || !item.entry.id || !item.bank || !Array.isArray(item.bank.questions)) {
        return 'Bank ' + (i + 1) + ' in the backup is damaged.';
      }
    }
    return null;
  }

  function writeBackupItem(item) {
    var id = item.entry.id;
    var bank = item.bank;
    bank.id = id;
    var ok = set('bank:' + id, bank) &&
      set('progress:' + id, item.progress && typeof item.progress === 'object' ? item.progress : {}) &&
      set('sessions:' + id, Array.isArray(item.sessions) ? item.sessions.slice(-SESSION_CAP) : []);
    if (!ok) return false;
    var index = getIndex();
    index.banks = index.banks.filter(function (b) { return b.id !== id; });
    index.banks.push({
      id: id,
      title: bank.title || item.entry.title || 'Untitled bank',
      createdAt: item.entry.createdAt || nowIso(),
      updatedAt: item.entry.updatedAt || nowIso(),
      lastStudied: item.entry.lastStudied || null,
      examDate: item.entry.examDate || null,
      examDatePrompted: !!item.entry.examDatePrompted,
      questionCount: bank.questions.length
    });
    return saveIndex(index);
  }

  // mode: "replace" wipes everything first; "merge" adds missing banks and,
  // for a bank that exists in both, keeps the copy with the newer updatedAt.
  // Damaged banks are skipped and listed in result.rejected ([{ title, error }]). Everything is
  // checked before "replace" deletes anything, so a damaged backup can't wipe your data.
  function importBackup(data, mode) {
    var err = checkBackup(data);
    if (err) return { ok: false, error: err };
    var result = { ok: true, added: 0, updated: 0, skipped: 0, rejected: [] };
    var items = [];
    data.banks.forEach(function (raw, i) {
      var c = cleanBackupItem(raw, i + 1);
      if (c.ok) items.push(c.item); else result.rejected.push({ title: c.title, error: c.error });
    });
    if (data.banks.length && !items.length) {
      return { ok: false, error: 'None of the banks in this backup could be read, so nothing was changed. First problem: "' +
        result.rejected[0].title + '": ' + result.rejected[0].error };
    }
    if (mode === 'replace') {
      deleteAll();
      if (data.settings && typeof data.settings === 'object') saveSettings(data.settings);
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var existing = getEntry(item.entry.id);
      if (existing) {
        var theirs = Date.parse(item.entry.updatedAt) || 0;
        var ours = Date.parse(existing.updatedAt) || 0;
        if (theirs <= ours) { result.skipped++; continue; }
      }
      if (!writeBackupItem(item)) return { ok: false, error: QUOTA_MSG };
      if (existing) result.updated++; else result.added++;
    }
    return result;
  }

  function deleteAll() {
    keys().forEach(function (k) { remove(k); });
  }

  // Probe once so a blocked storage shows its banner immediately.
  function probe() {
    try {
      var k = prefix + '__probe';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      report(isQuota(e) ? QUOTA_MSG : UNAVAILABLE_MSG);
      return false;
    }
  }

  SET.storage = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    QUOTA_MSG: QUOTA_MSG,
    onProblem: function (fn) { listeners.push(fn); if (lastProblem) fn(lastProblem); },
    setPrefix: function (p) { prefix = p; },
    probe: probe,
    newId: newId,
    migrate: migrate,
    getIndex: getIndex,
    getEntry: getEntry,
    touch: touch,
    getBank: getBank,
    saveBank: saveBank,
    deleteBank: deleteBank,
    getProgress: getProgress,
    saveProgress: saveProgress,
    getSessions: getSessions,
    addSession: addSession,
    clearStudy: clearStudy,
    getActive: getActive,
    setActive: setActive,
    clearActive: clearActive,
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportBackup: exportBackup,
    checkBackup: checkBackup,
    importBackup: importBackup,
    cleanBackupItem: cleanBackupItem,
    cleanRecord: cleanRecord,
    cleanSession: cleanSession,
    deleteAll: deleteAll
  };
})();
