// background.js -- service worker. Transport only: adds the shared secret,
// POSTs the snapshot to the Apps Script web app, and reports the answer.
// It does not transform the payload and does not retry; the user decides.
//
// Messages (from the content script):
//   { type: 'GET_STATE' }          -> { ok, configured, alwaysDownload, lastSync }
//   { type: 'UPLOAD', payload }    -> { ok, summary, lastSync } | { ok: false, error, needsSetup? }
//   { type: 'OPEN_OPTIONS' }       -> { ok }

importScripts('upload.js');

const DEFAULT_SETTINGS = { url: '', secret: '', alwaysDownload: false };

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings);
}

async function getState() {
  const s = await getSettings();
  const { lastSync } = await chrome.storage.local.get('lastSync');
  return {
    ok: true,
    configured: checkSettings(s).length === 0,
    alwaysDownload: !!s.alwaysDownload,
    lastSync: lastSync || null,
  };
}

async function upload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'No snapshot received.' };
  }
  // The content script should not send these; refuse anyway (the web app would too).
  if (payload.valid !== true) {
    return { ok: false, error: 'Snapshot has warnings; not uploaded.' };
  }

  const s = await getSettings();
  const problems = checkSettings(s);
  if (problems.length) {
    return { ok: false, needsSetup: true, error: `Upload not set up: ${problems.join('; ')}. Open Options.` };
  }

  let res;
  let text;
  try {
    // text/plain avoids a CORS preflight; with host permissions the worker is
    // not subject to CORS anyway. Apps Script answers the POST with a 302 to
    // script.googleusercontent.com, which fetch follows as a GET.
    // credentials: 'omit' -- an "Anyone" deployment needs no Google sign-in, and
    // sending Google cookies can trip the multi-account redirect issue.
    res = await fetch(s.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: buildBody(payload, s.secret),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD.TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      return {
        ok: false,
        error: `No answer after ${UPLOAD.TIMEOUT_MS / 1000} s. The sync may still have finished; check sync_log before retrying.`,
      };
    }
    return { ok: false, error: `Network error: ${(e && e.message) || e}` };
  }

  const result = interpretResponse(res.status, text);
  if (result.ok) {
    const lastSync = {
      at: new Date().toISOString(),
      mode: payload.mode,
      fetchedAt: payload.fetchedAt,
      summary: result.summary,
    };
    await chrome.storage.local.set({ lastSync });
    result.lastSync = lastSync;
  }
  return result;
}

const HANDLERS = {
  GET_STATE: () => getState(),
  UPLOAD: (msg) => upload(msg.payload),
  OPEN_OPTIONS: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = HANDLERS[msg && msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async answer
});

// First install: open Options so the URL and secret get set.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  const s = await getSettings();
  if (checkSettings(s).length) chrome.runtime.openOptionsPage();
});
