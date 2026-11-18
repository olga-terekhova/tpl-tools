// upload.js -- pure helpers for the upload path (no DOM, no chrome.* APIs) so
// they can be unit-tested in Node. Loaded by background.js (importScripts),
// options.html, and the content script (for display formatting only).

const UPLOAD = {
  SERVICE: 'tpl-history-sync', // doGet() health check "service" value
  SCHEMA_VERSION: 1,
  TIMEOUT_MS: 120000, // POST: a full sync can take tens of seconds in GAS
  HEALTH_TIMEOUT_MS: 20000,
};

// Deployed web app URL. Workspace accounts use /a/macros/<domain>/s/...
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/;

// Returns a list of problems; empty means the settings are usable.
function checkSettings(s) {
  const problems = [];
  const url = (s && s.url) || '';
  if (!url) problems.push('web app URL is missing');
  else if (/\/dev$/.test(url)) problems.push('use the /exec deployment URL, not /dev');
  else if (!EXEC_URL_RE.test(url)) problems.push('web app URL should look like https://script.google.com/macros/s/<id>/exec');
  if (!(s && s.secret)) problems.push('shared secret is missing');
  return problems;
}

// The secret travels in the body: Apps Script web apps cannot read request headers.
function buildBody(payload, secret) {
  return JSON.stringify(Object.assign({}, payload, { secret }));
}

// Parse a web app answer. Apps Script answers HTTP 200 even for errors, so
// "ok" in the body decides. A non-JSON body usually means a Google sign-in or
// error page (wrong access setting, wrong or deleted deployment).
function parseJsonAnswer(status, text) {
  if (status !== 200) {
    return { ok: false, error: `Web app answered HTTP ${status}. Check the URL in Options.` };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && typeof data.ok === 'boolean') return { data };
  } catch (_) {
    // fall through
  }
  const m = /<title>([^<]*)<\/title>/i.exec(text || '');
  const page = m && m[1].trim() ? ` (got a page titled "${m[1].trim()}")` : '';
  return {
    ok: false,
    error: `Web app did not return JSON${page}. Check the URL ends in /exec and the deployment's access is "Anyone".`,
  };
}

function interpretResponse(status, text) {
  const r = parseJsonAnswer(status, text);
  if (!r.data) return r;
  if (r.data.ok) return { ok: true, summary: r.data.summary || {} };
  return { ok: false, error: String(r.data.error || 'Unknown error from web app') };
}

function interpretHealth(status, text) {
  const r = parseJsonAnswer(status, text);
  if (!r.data) return r;
  const d = r.data;
  if (!d.ok || d.service !== UPLOAD.SERVICE) {
    return { ok: false, error: 'URL answers, but not with the TPL history sync web app.' };
  }
  if (d.schemaVersion !== UPLOAD.SCHEMA_VERSION) {
    return { ok: false, error: `Web app expects schemaVersion ${d.schemaVersion}; this extension sends ${UPLOAD.SCHEMA_VERSION}.` };
  }
  return { ok: true };
}

// ---- display ---------------------------------------------------------------

function formatSummary(sum) {
  const n = (v) => (typeof v === 'number' ? v : '?');
  return `loans ${n(sum.loansInserted)} new, ${n(sum.loansUpdated)} changed; ` +
    `books ${n(sum.bibsInserted)} new, ${n(sum.bibsUpdated)} changed ` +
    `(${n(sum.loansReceived)} loans received)`;
}

function formatLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatLastSync(last) {
  if (!last) return 'No sync yet.';
  return `Last sync ${formatLocal(last.at)} (${last.mode}): ${formatSummary(last.summary || {})}.`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    UPLOAD, EXEC_URL_RE, checkSettings, buildBody, interpretResponse, interpretHealth,
    formatSummary, formatLocal, formatLastSync,
  };
}
