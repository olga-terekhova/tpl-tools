/**
 * Sheet I/O: the only file (with Sync.gs) that talks to SpreadsheetApp.
 *
 * Values are written as strings ("2026-02-28", "2026-11-18 11:11:00") and
 * Sheets parses them according to the column's number format, which is set
 * on every written range first. Text columns use "@" so ids, ISBNs and
 * years are never turned into numbers.
 */

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function nowStamp_(tz) {
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
}

/** ISO UTC timestamp from the payload -> local naive timestamp string. */
function isoToStamp_(iso, tz) {
  var d = new Date(iso);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss');
}

/** Normalizes a cell value read from the sheet to the string the ETL compares. */
function normCell_(v, fmt, tz) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (fmt === FMT.DATE) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v);
}

/**
 * Returns the sheet for a layout, creating it and its header row if needed.
 * Throws if the existing header row does not start with the managed columns.
 */
function ensureSheet_(ss, layout) {
  var names = colNames_(layout);
  var sheet = ss.getSheetByName(layout.name) || ss.insertSheet(layout.name);
  ensureSize_(sheet, 1, names.length);

  var header = sheet.getRange(1, 1, 1, names.length).getValues()[0];
  var empty = header.every(function (h) { return h === ''; });
  if (empty && sheet.getLastRow() <= 1) {
    var hr = sheet.getRange(1, 1, 1, names.length);
    hr.setNumberFormat(FMT.TEXT);
    hr.setValues([names]);
    hr.setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  for (var j = 0; j < names.length; j++) {
    if (String(header[j]) !== names[j]) {
      throw new Error('Sheet "' + layout.name + '": column ' + (j + 1) + ' should be "' +
        names[j] + '" but is "' + header[j] + '". Managed columns must stay first and in order.');
    }
  }
  return sheet;
}

function ensureSize_(sheet, rows, cols) {
  var maxR = sheet.getMaxRows();
  if (rows > maxR) sheet.insertRowsAfter(maxR, rows - maxR);
  var maxC = sheet.getMaxColumns();
  if (cols > maxC) sheet.insertColumnsAfter(maxC, cols - maxC);
}

/** Reads the managed block (and optionally the manual columns) of a sheet. */
function readTable_(sheet, layout, tz, withManual) {
  var n = layout.cols.length;
  var lastRow = sheet.getLastRow();
  var t = { norm: [], raw: [], lastRow: Math.max(lastRow, 1), manual: null };
  var count = lastRow - 1;
  if (count <= 0) return t;

  t.raw = sheet.getRange(2, 1, count, n).getValues();
  t.norm = t.raw.map(function (r) {
    return r.map(function (v, j) { return normCell_(v, layout.cols[j].fmt, tz); });
  });

  var lastCol = sheet.getLastColumn();
  if (withManual && lastCol > n) {
    var m = lastCol - n;
    t.manual = {
      headers: sheet.getRange(1, n + 1, 1, m).getValues()[0],
      values: sheet.getRange(2, n + 1, count, m).getValues(),
      formats: sheet.getRange(2, n + 1, count, m).getNumberFormats()
    };
  }
  return t;
}

/** Writes rows into the managed columns starting at startRow. */
function writeRows_(sheet, layout, startRow, rows) {
  if (!rows.length) return;
  var n = layout.cols.length;
  ensureSize_(sheet, startRow + rows.length - 1, n);
  var fmts = colFormats_(layout);
  var range = sheet.getRange(startRow, 1, rows.length, n);
  range.setNumberFormats(rows.map(function () { return fmts; }));
  range.setValues(rows);
}

/** Applies an upsert plan: per-row updates in place, then one appended block. */
function applyUpsert_(sheet, layout, table, plan) {
  plan.updates.forEach(function (u) {
    writeRows_(sheet, layout, u.index + 2, [u.row]);
  });
  writeRows_(sheet, layout, table.lastRow + 1, plan.appends);
}

/** Replaces all data rows of a script-owned table. */
function rewriteTable_(sheet, layout, rows) {
  var n = layout.cols.length;
  var maxR = sheet.getMaxRows();
  if (maxR > 1) sheet.getRange(2, 1, maxR - 1, n).clearContent();
  writeRows_(sheet, layout, 2, rows);
}

/** Rebuilds the generated history sheet from the current loans and bibs sheets. */
function rebuildHistory_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var loansT = readTable_(ensureSheet_(ss, LAYOUT.loans), LAYOUT.loans, tz, true);
  var bibsT = readTable_(ensureSheet_(ss, LAYOUT.bibs), LAYOUT.bibs, tz, true);
  var view = buildHistory_(loansT, bibsT);

  var sheet = ss.getSheetByName(LAYOUT.history.name) || ss.insertSheet(LAYOUT.history.name);
  sheet.clear();
  var width = view.header.length;
  ensureSize_(sheet, view.rows.length + 1, width);

  var hr = sheet.getRange(1, 1, 1, width);
  hr.setNumberFormat(FMT.TEXT);
  hr.setValues([view.header]);
  hr.setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (view.rows.length) {
    var range = sheet.getRange(2, 1, view.rows.length, width);
    range.setNumberFormats(view.formats);
    range.setValues(view.rows);
  }
  return view.rows.length;
}

/** Appends one row to sync_log. Never throws. */
function logSync_(entry) {
  try {
    var ss = getSpreadsheet_();
    var tz = ss.getSpreadsheetTimeZone();
    var sheet = ensureSheet_(ss, LAYOUT.syncLog);
    var row = colNames_(LAYOUT.syncLog).map(function (c) {
      var v = entry[c];
      if (v === undefined || v === null) return '';
      if (c === 'fetchedAt') return isoToStamp_(v, tz);
      if (c === 'receivedAt') return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
      if (c === 'error' || c === 'warnings') return String(v).slice(0, MAX_ERROR_CHARS);
      return v;
    });
    writeRows_(sheet, LAYOUT.syncLog, sheet.getLastRow() + 1, [row]);
  } catch (err) {
    console.error('logSync_ failed: ' + err);
  }
}
