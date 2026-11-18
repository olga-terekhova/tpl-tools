// test_upload.js -- Node tests for upload.js and background.js (no browser).
// Usage: node tests/test_upload.js
// background.js runs in a vm sandbox with fake chrome.* and fetch.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const U = require(path.join(ROOT, 'upload.js'));

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    process.exitCode = 1;
  }
}

const GOOD_URL = 'https://script.google.com/macros/s/AKfycbx_abc-123/exec';
const SNAP = {
  schemaVersion: 1, source: 'tpl', mode: 'recent', fetchedAt: '2026-11-18T20:00:00.000Z',
  pagesRequested: 1, pagesFetched: 1, totalPages: 20, count: 998, valid: true, warnings: [],
  loans: [{ loanId: '-123', bibId: 'S1', checkedOut: '2026-10-01', returned: '2026-10-20' }],
  bibs: [{ bibId: 'S1', title: '1984', authors: ['Orwell, George'] }],
};
const SUMMARY = {
  mode: 'recent', loansReceived: 1, loansInserted: 1, loansUpdated: 0,
  bibsReceived: 1, bibsInserted: 0, bibsUpdated: 0, authorListsChanged: 0, seriesListsChanged: 0, historyRows: 998,
};

// ---- fake extension environment for background.js ----------------------

function makeWorker({ settings, fetchImpl }) {
  const store = { settings };
  const listeners = { message: [], installed: [] };
  const calls = { fetch: [], openOptions: 0 };
  const chrome = {
    runtime: {
      id: 'ext-id',
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      openOptionsPage: async () => { calls.openOptions++; },
    },
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k]));
          return out;
        },
        set: async (obj) => Object.assign(store, JSON.parse(JSON.stringify(obj))),
      },
    },
  };
  const sandbox = {
    chrome, console, Promise, JSON, Object, String, Date, AbortSignal,
    fetch: async (url, opts) => { calls.fetch.push({ url, opts }); return fetchImpl(url, opts); },
  };
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

  const send = (msg, senderId = 'ext-id') => new Promise((resolve) => {
    // JSON copy: like Chrome messaging, and avoids cross-realm prototypes in deepStrictEqual
    const done = (r) => resolve(r === undefined ? undefined : JSON.parse(JSON.stringify(r)));
    const keepOpen = listeners.message[0](msg, { id: senderId }, done);
    if (!keepOpen) resolve(undefined);
  });
  return { send, store, calls, listeners };
}

const answer = (status, body) => async () => ({ status, text: async () => body });

// ---- upload.js ------------------------------------------------------------

(async () => {
  await test('checkSettings accepts /exec URLs, incl. Workspace', () => {
    assert.deepStrictEqual(U.checkSettings({ url: GOOD_URL, secret: 's' }), []);
    assert.deepStrictEqual(U.checkSettings({ url: 'https://script.google.com/a/macros/example.com/s/AKfy_1/exec', secret: 's' }), []);
  });

  await test('checkSettings rejects missing, /dev and foreign URLs, missing secret', () => {
    assert.strictEqual(U.checkSettings({}).length, 2);
    assert.match(U.checkSettings({ url: 'https://script.google.com/macros/s/X/dev', secret: 's' })[0], /\/dev/);
    assert.strictEqual(U.checkSettings({ url: 'https://evil.example.com/macros/s/X/exec', secret: 's' }).length, 1);
    assert.strictEqual(U.checkSettings({ url: GOOD_URL + '?x=1', secret: 's' }).length, 1);
  });

  await test('buildBody adds secret without changing the snapshot object', () => {
    const body = JSON.parse(U.buildBody(SNAP, 'sek'));
    assert.strictEqual(body.secret, 'sek');
    assert.strictEqual(body.loans[0].loanId, '-123');
    assert.strictEqual(SNAP.secret, undefined);
  });

  await test('interpretResponse: ok, error, non-200, HTML, junk', () => {
    assert.deepStrictEqual(U.interpretResponse(200, JSON.stringify({ ok: true, summary: SUMMARY })), { ok: true, summary: SUMMARY });
    assert.deepStrictEqual(U.interpretResponse(200, '{"ok":false,"error":"Unauthorized"}'), { ok: false, error: 'Unauthorized' });
    assert.match(U.interpretResponse(404, 'x').error, /HTTP 404/);
    assert.match(U.interpretResponse(200, '<html><title>Sign in - Google Accounts</title></html>').error, /Sign in - Google Accounts.*Anyone/);
    assert.match(U.interpretResponse(200, '{"foo":1}').error, /did not return JSON/);
  });

  await test('interpretHealth checks service and schemaVersion', () => {
    assert.deepStrictEqual(U.interpretHealth(200, '{"ok":true,"service":"tpl-history-sync","schemaVersion":1}'), { ok: true });
    assert.match(U.interpretHealth(200, '{"ok":true,"service":"other","schemaVersion":1}').error, /not with the TPL/);
    assert.match(U.interpretHealth(200, '{"ok":true,"service":"tpl-history-sync","schemaVersion":2}').error, /schemaVersion 2/);
  });

  await test('formatSummary / formatLastSync', () => {
    assert.strictEqual(U.formatSummary(SUMMARY), 'loans 1 new, 0 changed; books 0 new, 0 changed (1 loans received)');
    assert.strictEqual(U.formatLastSync(null), 'No sync yet.');
    assert.match(U.formatLastSync({ at: '2026-11-18T20:00:00.000Z', mode: 'full', summary: SUMMARY }), /^Last sync \d{4}-\d\d-\d\d \d\d:\d\d \(full\): loans 1 new/);
  });

  // ---- background.js --------------------------------------------------------

  const configured = { url: GOOD_URL, secret: 'sek', alwaysDownload: false };

  await test('GET_STATE when not configured', async () => {
    const w = makeWorker({ settings: undefined, fetchImpl: answer(200, '') });
    const st = await w.send({ type: 'GET_STATE' });
    assert.deepStrictEqual(st, { ok: true, configured: false, alwaysDownload: false, lastSync: null });
  });

  await test('UPLOAD success: POST shape, secret in body, lastSync stored', async () => {
    const w = makeWorker({ settings: configured, fetchImpl: answer(200, JSON.stringify({ ok: true, summary: SUMMARY })) });
    const r = await w.send({ type: 'UPLOAD', payload: SNAP });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.summary, SUMMARY);
    assert.strictEqual(w.calls.fetch.length, 1);
    const { url, opts } = w.calls.fetch[0];
    assert.strictEqual(url, GOOD_URL);
    assert.strictEqual(opts.method, 'POST');
    assert.match(opts.headers['Content-Type'], /^text\/plain/);
    assert.strictEqual(opts.credentials, 'omit');
    assert.strictEqual(opts.redirect, 'follow');
    assert.strictEqual(JSON.parse(opts.body).secret, 'sek');
    assert.strictEqual(w.store.lastSync.mode, 'recent');
    assert.deepStrictEqual(w.store.lastSync.summary, SUMMARY);
    const st = await w.send({ type: 'GET_STATE' });
    assert.strictEqual(st.configured, true);
    assert.strictEqual(st.lastSync.fetchedAt, SNAP.fetchedAt);
  });

  await test('UPLOAD web app error: passed through, no retry, lastSync untouched', async () => {
    const w = makeWorker({ settings: configured, fetchImpl: answer(200, '{"ok":false,"error":"Busy: another sync is still running"}') });
    const r = await w.send({ type: 'UPLOAD', payload: SNAP });
    assert.deepStrictEqual(r, { ok: false, error: 'Busy: another sync is still running' });
    assert.strictEqual(w.calls.fetch.length, 1);
    assert.strictEqual(w.store.lastSync, undefined);
  });

  await test('UPLOAD refuses invalid snapshot without fetching', async () => {
    const w = makeWorker({ settings: configured, fetchImpl: answer(200, '') });
    const r = await w.send({ type: 'UPLOAD', payload: Object.assign({}, SNAP, { valid: false }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(w.calls.fetch.length, 0);
  });

  await test('UPLOAD when not configured: needsSetup, no fetch', async () => {
    const w = makeWorker({ settings: { url: '', secret: '' }, fetchImpl: answer(200, '') });
    const r = await w.send({ type: 'UPLOAD', payload: SNAP });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsSetup, true);
    assert.strictEqual(w.calls.fetch.length, 0);
  });

  await test('UPLOAD network error and timeout', async () => {
    const w1 = makeWorker({ settings: configured, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    assert.match((await w1.send({ type: 'UPLOAD', payload: SNAP })).error, /^Network error: Failed to fetch/);
    const w2 = makeWorker({
      settings: configured,
      fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
    });
    assert.match((await w2.send({ type: 'UPLOAD', payload: SNAP })).error, /No answer after 120 s.*sync_log/);
  });

  await test('ignores unknown types and foreign senders; OPEN_OPTIONS works', async () => {
    const w = makeWorker({ settings: configured, fetchImpl: answer(200, '') });
    assert.strictEqual(await w.send({ type: 'NOPE' }), undefined);
    assert.strictEqual(await w.send({ type: 'GET_STATE' }, 'other-ext'), undefined);
    assert.deepStrictEqual(await w.send({ type: 'OPEN_OPTIONS' }), { ok: true });
    assert.strictEqual(w.calls.openOptions, 1);
  });

  await test('onInstalled opens Options only when not configured', async () => {
    const a = makeWorker({ settings: undefined, fetchImpl: answer(200, '') });
    await a.listeners.installed[0]({ reason: 'install' });
    assert.strictEqual(a.calls.openOptions, 1);
    const b = makeWorker({ settings: configured, fetchImpl: answer(200, '') });
    await b.listeners.installed[0]({ reason: 'install' });
    await b.listeners.installed[0]({ reason: 'update' });
    assert.strictEqual(b.calls.openOptions, 0);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
