/* csv.js — CSV reading and writing (RFC 4180), Excel-friendly. No bank knowledge here; see bank.js. */
(function () {
  'use strict';
  var SET = window.SET = window.SET || {};

  var MAX_BYTES = 10 * 1024 * 1024; // bank files larger than this are refused
  var DELIMITERS = [',', ';', '\t'];
  var TOO_LARGE = 'The file is larger than 10 MB, which is far more than a question bank needs. Check you picked the right file.';
  var OLD_EXCEL = 'Saved in an older Excel format, so it was read as Western European text. Use "CSV UTF-8" next time so every character comes through.';

  // Counts , ; and tab outside quotes on the header line (the first line that isn't blank or a
  // # settings row) and picks the most common. Comma when there's no clear winner.
  function detectDelimiter(text) {
    var i = 0, n = text.length;
    while (i < n) {
      var counts = { ',': 0, ';': 0, '\t': 0 }, inQ = false, start = i;
      for (; i < n; i++) {
        var ch = text.charAt(i);
        if (ch === '"') inQ = !inQ;
        else if (!inQ && (ch === '\n' || ch === '\r')) break;
        else if (!inQ && counts.hasOwnProperty(ch)) counts[ch]++;
      }
      var line = text.slice(start, i);
      if (text.charAt(i) === '\r' && text.charAt(i + 1) === '\n') i++;
      i++;
      var lead = line.replace(/^[\s"]+/, '');
      if (!lead || lead.charAt(0) === '#') continue;
      var best = ',';
      DELIMITERS.forEach(function (d) { if (counts[d] > counts[best]) best = d; });
      return best;
    }
    return ',';
  }

  // Parses CSV text. Handles quoted fields, "" escapes, line breaks inside quotes, CRLF/LF and a BOM.
  // Returns { rows: [{ cells, row (1-based spreadsheet row), line (1-based text line) }], delimiter, error }.
  function parseCsv(text, delimiter) {
    text = String(text).replace(/^﻿/, '');
    var d = delimiter || detectDelimiter(text);
    var rows = [], cells = [], field = '', inQ = false, quoted = false;
    var row = 1, line = 1, rowLine = 1, quoteLine = 0;
    var n = text.length;
    function endField() { cells.push(field); field = ''; quoted = false; }
    function endRow() {
      endField();
      rows.push({ cells: cells, row: row, line: rowLine });
      cells = [];
      row++;
      rowLine = line;
    }
    for (var i = 0; i < n; i++) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false;
        } else if (ch === '\r') {
          if (text.charAt(i + 1) === '\n') i++;
          field += '\n'; line++;
        } else {
          if (ch === '\n') line++;
          field += ch;
        }
      } else if (ch === '"' && field === '' && !quoted) {
        inQ = true; quoted = true; quoteLine = line;
      } else if (ch === d) {
        endField();
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        line++;
        endRow();
      } else {
        field += ch;
      }
    }
    if (inQ) return { rows: rows, delimiter: d, error: 'Row ' + row + ' (line ' + quoteLine + '): a quoted cell is never closed. Check for a missing " character.' };
    if (field !== '' || quoted || cells.length) endRow();
    return { rows: rows, delimiter: d, error: null };
  }

  function quote(cell, d) {
    var s = cell === undefined || cell === null ? '' : String(cell);
    return s.indexOf(d) >= 0 || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Rows (arrays of cells) as CSV text: CRLF line endings and a UTF-8 BOM, so Excel opens accents correctly.
  function toCsv(rows, delimiter) {
    var d = delimiter || ',';
    return '﻿' + rows.map(function (r) { return r.map(function (c) { return quote(c, d); }).join(d); }).join('\r\n') + '\r\n';
  }

  // Spreadsheet formula safety. A cell starting with = + - @ (or tab / CR) would run as a formula in
  // Excel, so exports prefix it with '. Imports remove that ' again (and only then), so a round trip
  // is lossless.
  var FORMULA_START = /^[=+\-@\t\r]/;
  function protect(v) {
    var s = v === undefined || v === null ? '' : String(v);
    return FORMULA_START.test(s) ? "'" + s : s;
  }
  function unprotect(s) { return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s; }

  // Reads a bank file as text. With opts.legacyFallback, text that isn't valid UTF-8 (it decodes
  // with U+FFFD) is read again as windows-1252, as older Excel saves CSV. Resolves { text, warning };
  // rejects with an Error whose message can be shown.
  function readFile(file, opts) {
    opts = opts || {};
    if (file && file.size > MAX_BYTES) return Promise.reject(new Error(TOO_LARGE));
    var read = function (encoding) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result)); };
        r.onerror = function () { reject(r.error || new Error('The file could not be read.')); };
        if (encoding) r.readAsText(file, encoding); else r.readAsText(file);
      });
    };
    return read().then(function (text) {
      if (!opts.legacyFallback || text.indexOf('�') < 0) return { text: text, warning: null };
      return read('windows-1252').then(function (t) { return { text: t, warning: OLD_EXCEL }; });
    });
  }

  SET.csv = {
    MAX_BYTES: MAX_BYTES,
    TOO_LARGE: TOO_LARGE,
    OLD_EXCEL: OLD_EXCEL,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    toCsv: toCsv,
    protect: protect,
    unprotect: unprotect,
    readFile: readFile
  };
})();
