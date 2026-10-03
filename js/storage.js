/* storage.js — localStorage wrapper, schema versioning, backup export/import */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var prefix = 'set:v1:';
  var SCHEMA_VERSION = 1;
  var SESSION_CAP = 200;
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
  // Only version 1 exists so far; future versions add steps here.
  function migrate(index) {
    if (!index || typeof index !== 'object') index = { version: SCHEMA_VERSION, banks: [] };
    if (!Array.isArray(index.banks)) index.banks = [];
    if (!index.version) index.version = SCHEMA_VERSION;
    // if (index.version < 2) { ...upgrade...; index.version = 2; }
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

  var DEFAULT_SETTINGS = { theme: 'dark', focus: 2, shuffleOptions: true };

  function getSettings() {
    var s = get('settings', {}) || {};
    var out = {
      theme: ['system', 'light', 'dark'].indexOf(s.theme) >= 0 ? s.theme : DEFAULT_SETTINGS.theme,
      focus: typeof s.focus === 'number' && s.focus >= 0 && s.focus <= 4 ? Math.floor(s.focus) : DEFAULT_SETTINGS.focus,
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
      questionCount: bank.questions.length
    });
    return saveIndex(index);
  }

  // mode: "replace" wipes everything first; "merge" adds missing banks and,
  // for a bank that exists in both, keeps the copy with the newer updatedAt.
  function importBackup(data, mode) {
    var err = checkBackup(data);
    if (err) return { ok: false, error: err };
    var result = { ok: true, added: 0, updated: 0, skipped: 0 };
    if (mode === 'replace') {
      deleteAll();
      if (data.settings) saveSettings(data.settings);
    }
    for (var i = 0; i < data.banks.length; i++) {
      var item = data.banks[i];
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
    deleteAll: deleteAll
  };
})();
