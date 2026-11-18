/**
 * Node test for the GAS project: loads the .gs files into a sandbox with an
 * in-memory fake of SpreadsheetApp and friends, then drives doPost().
 *
 * The fake does not parse strings into dates or numbers (real Sheets does);
 * normCell_ is tested separately with real Date objects.
 *
 * Usage: node tests/test_gas.js [path/to/real-snapshot.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* ---------------- fakes ---------------- */

class FakeRange {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
      throw new Error(`Range out of bounds: ${sheet.name} r${r} c${c} ${nr}x${nc} (grid ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  _each(fn) {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(fn(this.r - 1 + i, this.c - 1 + j, i, j));
      out.push(row);
    }
    return out;
  }
  getValues() { return this._each((i, j) => this.sheet.vals[i][j]); }
  getNumberFormats() { return this._each((i, j) => this.sheet.fmts[i][j]); }
  setValues(v) {
    assert.strictEqual(v.length, this.nr, 'setValues row count');
    v.forEach((row) => assert.strictEqual(row.length, this.nc, 'setValues col count'));
    this._each((i, j, a, b) => { this.sheet.vals[i][j] = v[a][b]; });
    return this;
  }
  setNumberFormats(f) { this._each((i, j, a, b) => { this.sheet.fmts[i][j] = f[a][b]; }); return this; }
  setNumberFormat(f) { this._each((i, j) => { this.sheet.fmts[i][j] = f; }); return this; }
  clearContent() { this._each((i, j) => { this.sheet.vals[i][j] = ''; }); return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name, rows = 5, cols = 4) {
    this.name = name;
    this.maxRows = rows;
    this.maxCols = cols;
    this.vals = Array.from({ length: rows }, () => Array(cols).fill(''));
    this.fmts = Array.from({ length: rows }, () => Array(cols).fill('General'));
  }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    for (let i = this.maxRows - 1; i >= 0; i--) if (this.vals[i].some((v) => v !== '')) return i + 1;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.vals.forEach((r) => r.forEach((v, j) => { if (v !== '') last = Math.max(last, j + 1); }));
    return last;
  }
  insertRowsAfter(after, n) {
    for (let k = 0; k < n; k++) {
      this.vals.splice(after, 0, Array(this.maxCols).fill(''));
      this.fmts.splice(after, 0, Array(this.maxCols).fill('General'));
    }
    this.maxRows += n;
  }
  insertColumnsAfter(after, n) {
    this.vals.forEach((r) => r.splice(after, 0, ...Array(n).fill('')));
    this.fmts.forEach((r) => r.splice(after, 0, ...Array(n).fill('General')));
    this.maxCols += n;
  }
  clear() {
    this.vals = this.vals.map((r) => r.map(() => ''));
    this.fmts = this.fmts.map((r) => r.map(() => 'General'));
  }
  setFrozenRows() {}
  // test helpers
  data() {
    const lr = this.getLastRow(), lc = this.getLastColumn();
    return this.vals.slice(0, lr).map((r) => r.slice(0, lc));
  }
  records() {
    const [h, ...rows] = this.data();
    return rows.map((r) => Object.fromEntries(h.map((k, j) => [k, r[j]])));
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
  getSpreadsheetTimeZone() { return 'UTC'; }
}

function pad(n) { return String(n).padStart(2, '0'); }
const Utilities = {
  formatDate(d, tz, p) {
    assert.ok(tz === 'UTC', 'fake formatDate supports UTC only');
    return p
      .replace('yyyy', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1))
      .replace('dd', pad(d.getUTCDate())).replace('HH', pad(d.getUTCHours()))
      .replace('mm', pad(d.getUTCMinutes())).replace('ss', pad(d.getUTCSeconds()));
  },
  getUuid() { return 'uuid'; }
};

function makeContext(ss, props) {
  const ctx = {
    console,
    Utilities,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } })
    }
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..');
  for (const f of ['Config.gs', 'Etl.gs', 'SheetIO.gs', 'Sync.gs', 'WebApp.gs', 'Menu.gs']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function post(ctx, payload) {
  return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).body);
}

/* ---------------- fixtures ---------------- */

const SECRET = 's3cret';
function bib(id, title, extra = {}) {
  return Object.assign({
    bibId: id, title, subtitle: '', authors: ['Author, A'], format: 'BK', publicationDate: '2004',
    isbns: ['0123456789'], series: [], language: 'eng', contentType: 'FICTION', audiences: ['Adult'],
    callNumber: 'F', subjects: ['S1'], genres: []
  }, extra);
}
function payload(mode, loans, bibs, extra = {}) {
  return Object.assign({
    secret: SECRET, schemaVersion: 1, source: 'tpl', mode, fetchedAt: '2026-11-18T16:00:00.000Z',
    pagesRequested: 1, pagesFetched: 1, totalPages: 1, count: loans.length, valid: true, warnings: [],
    loans, bibs
  }, extra);
}

/* ---------------- tests ---------------- */

const results = [];
function test(name, fn) {
  try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e]); }
}

test('normCell_ turns sheet Dates back into ISO strings', () => {
  const ctx = makeContext(new FakeSpreadsheet(), {});
  assert.strictEqual(ctx.normCell_(new Date(Date.UTC(2026, 1, 28)), ctx.FMT.DATE, 'UTC'), '2026-02-28');
  assert.strictEqual(ctx.normCell_(new Date(Date.UTC(2026, 1, 28, 9, 5, 7)), ctx.FMT.TS, 'UTC'), '2026-02-28 09:05:07');
  assert.strictEqual(ctx.normCell_(42, ctx.FMT.INT, 'UTC'), '42');
  assert.strictEqual(ctx.normCell_('', ctx.FMT.TEXT, 'UTC'), '');
});

test('auth and validation', () => {
  const ss = new FakeSpreadsheet();
  const ctx = makeContext(ss, { SHARED_SECRET: SECRET });
  const p = payload('full', [{ loanId: '1', bibId: 'B1', checkedOut: '2026-01-01', returned: '2026-01-10' }], [bib('B1', 'T')]);
  assert.strictEqual(post(ctx, Object.assign({}, p, { secret: 'nope' })).error, 'Unauthorized');
  let r = post(ctx, Object.assign({}, p, { valid: false }));
  assert.ok(!r.ok && /marked invalid/.test(r.error), r.error);
  r = post(ctx, Object.assign({}, p, { loans: [p.loans[0], p.loans[0]], count: 2 }));
  assert.ok(!r.ok && /duplicate loanId/.test(r.error), r.error);
  r = post(ctx, Object.assign({}, p, { schemaVersion: 2 }));
  assert.ok(!r.ok && /schemaVersion/.test(r.error), r.error);
  const log = ss.getSheetByName('sync_log').records();
  assert.deepStrictEqual(log.map((x) => x.status), ['rejected', 'rejected', 'rejected']);
  assert.ok(!ss.getSheetByName('loans'), 'no data sheets created by rejected payloads');
  r = JSON.parse(ctx.doPost({ postData: { contents: '{oops' } }).body);
  assert.strictEqual(r.error, 'Body is not valid JSON');
});

test('full load, manual columns, recent update, idempotency', () => {
  const ss = new FakeSpreadsheet();
  const ctx = makeContext(ss, { SHARED_SECRET: SECRET });

  const loans1 = [
    // given newest first, like the library
    { loanId: '-200', bibId: 'B2', checkedOut: '2026-02-11', returned: '2026-03-01' },
    { loanId: '300', bibId: 'B3', checkedOut: '2026-02-01', returned: '2026-03-01' },
    { loanId: '100', bibId: 'B1', checkedOut: '2026-01-05', returned: '2026-02-01' },
    { loanId: '-50', bibId: 'B2', checkedOut: '2025-12-16', returned: '2026-01-10' }
  ];
  const bibs1 = [
    bib('B2', 'Project Hail Mary', { authors: ['Weir, Andy'] }),
    bib('B3', '1984', { authors: ['Orwell, George'], publicationDate: '1949' }),
    bib('B1', 'Good Omens', {
      authors: ['Pratchett, Terry', 'Gaiman, Neil'],
      series: [{ name: 'Discworld', volume: '1.' }, { name: 'Extra', volume: '' }]
    })
  ];
  let r = post(ctx, payload('full', loans1, bibs1));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.summary.loansInserted, 4);
  assert.strictEqual(r.summary.bibsInserted, 3);

  // Loans appended oldest first.
  const L = ss.getSheetByName('loans');
  assert.deepStrictEqual(L.records().map((x) => x.loanId), ['-50', '100', '300', '-200']);
  assert.strictEqual(L.fmts[1][0], '@', 'loanId is text');
  assert.strictEqual(L.fmts[1][2], 'yyyy-mm-dd', 'checkedOut is a date column');
  assert.ok(L.records().every((x) => x.insertedAt && x.updatedAt === ''));

  // Bibs appended in order of first loan.
  const B = ss.getSheetByName('bibs');
  assert.deepStrictEqual(B.records().map((x) => x.bibId), ['B2', 'B1', 'B3']);
  const gom = B.records()[1];
  assert.strictEqual(gom.authors, 'Pratchett, Terry | Gaiman, Neil');
  assert.strictEqual(gom.series, 'Discworld #1 | Extra');
  assert.strictEqual(gom.isbns, '0123456789');

  // Child tables.
  assert.deepStrictEqual(ss.getSheetByName('bib_authors').data().slice(1),
    [['B2', 1, 'Weir, Andy'], ['B1', 1, 'Pratchett, Terry'], ['B1', 2, 'Gaiman, Neil'], ['B3', 1, 'Orwell, George']]);
  assert.deepStrictEqual(ss.getSheetByName('bib_series').data().slice(1),
    [['B1', 1, 'Discworld', '1.'], ['B1', 2, 'Extra', '']]);

  // History newest first; ties on returned broken by checkedOut desc.
  const H = ss.getSheetByName('history');
  assert.deepStrictEqual(H.records().map((x) => x.loanId), ['-200', '300', '100', '-50']);
  assert.strictEqual(H.records()[1].title, '1984');

  // User adds manual columns.
  L.insertColumnsAfter(L.maxCols, 2);
  L.vals[0][6] = 'note';
  L.vals[2][6] = 'loved it';            // row of loan 100
  L.fmts[2][6] = '@';
  B.insertColumnsAfter(B.maxCols, 2);
  B.vals[0][16] = 'myRating';
  B.vals[2][16] = 5;                    // row of B1
  B.vals[2][17] = 'stray, no header';   // unnamed but non-empty column

  // Recent sync: one new loan, B1 title + authors changed, B2 unchanged.
  const loans2 = [
    { loanId: '400', bibId: 'B4', checkedOut: '2026-03-05', returned: '2026-04-01' },
    { loanId: '-200', bibId: 'B2', checkedOut: '2026-02-11', returned: '2026-03-01' },
    { loanId: '100', bibId: 'B1', checkedOut: '2026-01-05', returned: '2026-02-01' }
  ];
  const bibs2 = [
    bib('B4', 'New Book', { authors: ['New, Author'] }),
    bib('B2', 'Project Hail Mary', { authors: ['Weir, Andy'] }),
    bib('B1', 'Good Omens (rev.)', {
      authors: ['Pratchett, Terry', 'Gaiman, Neil', 'Editor, Some'],
      series: [{ name: 'Discworld', volume: '1.' }, { name: 'Extra', volume: '' }]
    })
  ];
  r = post(ctx, payload('recent', loans2, bibs2, { count: 5 }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(
    [r.summary.loansInserted, r.summary.loansUpdated, r.summary.bibsInserted, r.summary.bibsUpdated,
      r.summary.authorListsChanged, r.summary.seriesListsChanged],
    [1, 0, 1, 1, 2, 0]);

  // Manual cells stayed on their rows; new loan appended at the bottom.
  const lr = L.records();
  assert.deepStrictEqual(lr.map((x) => x.loanId), ['-50', '100', '300', '-200', '400']);
  assert.strictEqual(lr[1].note, 'loved it');
  assert.strictEqual(lr[4].note, '');
  const br = B.records();
  assert.strictEqual(br[1].title, 'Good Omens (rev.)');
  assert.strictEqual(br[1].myRating, 5);
  assert.ok(br[1].updatedAt !== '' && br[0].updatedAt === '', 'updatedAt only on changed bib');

  // B1 author group replaced in place, B4 appended.
  assert.deepStrictEqual(ss.getSheetByName('bib_authors').data().slice(1).map((x) => x.join('/')), [
    'B2/1/Weir, Andy', 'B1/1/Pratchett, Terry', 'B1/2/Gaiman, Neil', 'B1/3/Editor, Some',
    'B3/1/Orwell, George', 'B4/1/New, Author']);

  // History carries manual columns, aligned with the right loans and bibs.
  const hr = H.records();
  assert.deepStrictEqual(Object.keys(hr[0]).slice(-3), ['loans.note', 'bibs.myRating', 'bibs.colR']);
  assert.deepStrictEqual(hr.map((x) => x.loanId), ['400', '-200', '300', '100', '-50']);
  const h100 = hr.find((x) => x.loanId === '100');
  assert.deepStrictEqual([h100['loans.note'], h100['bibs.myRating'], h100.title], ['loved it', 5, 'Good Omens (rev.)']);
  assert.strictEqual(H.fmts[hr.findIndex((x) => x.loanId === '100') + 1][11], '@', 'manual format copied');

  // Same snapshot again: nothing changes.
  r = post(ctx, payload('recent', loans2, bibs2, { count: 5 }));
  assert.deepStrictEqual(
    [r.summary.loansInserted, r.summary.loansUpdated, r.summary.bibsInserted, r.summary.bibsUpdated,
      r.summary.authorListsChanged, r.summary.seriesListsChanged],
    [0, 0, 0, 0, 0, 0]);

  const log = ss.getSheetByName('sync_log').records();
  assert.deepStrictEqual(log.map((x) => x.status), ['ok', 'ok', 'ok']);
  assert.strictEqual(log[0].fetchedAt, '2026-11-18 16:00:00');
});

test('header mismatch stops the sync and is logged', () => {
  const ss = new FakeSpreadsheet();
  const ctx = makeContext(ss, { SHARED_SECRET: SECRET });
  const p = payload('full', [{ loanId: '1', bibId: 'B1', checkedOut: '2026-01-01', returned: '2026-01-10' }], [bib('B1', 'T')]);
  assert.ok(post(ctx, p).ok);
  const L = ss.getSheetByName('loans');
  L.vals[0][2] = 'myColumn';   // user inserted something inside the managed block
  const r = post(ctx, p);
  assert.ok(!r.ok && /column 3 should be "checkedOut"/.test(r.error), r.error);
  const log = ss.getSheetByName('sync_log').records();
  assert.strictEqual(log[log.length - 1].status, 'error');
});

if (process.argv[2]) {
  test('real snapshot: ' + process.argv[2], () => {
    const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const ss = new FakeSpreadsheet();
    const ctx = makeContext(ss, { SHARED_SECRET: SECRET });
    let r = post(ctx, Object.assign({ secret: SECRET }, snap));
    assert.ok(r.ok, JSON.stringify(r));
    console.log('  first run:', JSON.stringify(r.summary));
    r = post(ctx, Object.assign({ secret: SECRET }, snap));
    assert.strictEqual(r.summary.loansInserted + r.summary.loansUpdated + r.summary.bibsInserted + r.summary.bibsUpdated, 0);
  });
}

for (const [s, n, e] of results) {
  console.log(`${s.padEnd(4)} ${n}`);
  if (e) console.log('     ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n     '));
}
process.exit(results.some((x) => x[0] === 'FAIL') ? 1 : 0);
