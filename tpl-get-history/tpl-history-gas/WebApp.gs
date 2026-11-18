/**
 * Web app entry points.
 *
 * Deploy as: Execute as "Me", Who has access "Anyone".
 * The shared secret (Script Property SHARED_SECRET) is the only guard, so
 * keep the deployment URL and the secret private.
 *
 * Apps Script web apps always answer HTTP 200; check "ok" in the body.
 */

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'Body is not valid JSON' });
  }

  var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret) return json_({ ok: false, error: 'Server not configured: SHARED_SECRET is missing' });
  if (!payload || payload.secret !== secret) return json_({ ok: false, error: 'Unauthorized' });
  delete payload.secret;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return json_({ ok: false, error: 'Busy: another sync is still running' });
  }

  var receivedAt = new Date();
  var base = {
    receivedAt: receivedAt,
    fetchedAt: payload.fetchedAt,
    mode: payload.mode,
    count: payload.count,
    loansReceived: Array.isArray(payload.loans) ? payload.loans.length : '',
    warnings: Array.isArray(payload.warnings) ? payload.warnings.join('; ') : ''
  };

  try {
    var problems = validatePayload_(payload);
    if (problems.length) {
      logSync_(merge_(base, { status: 'rejected', error: problems.join('; ') }));
      return json_({ ok: false, error: 'Rejected: ' + problems.slice(0, 5).join('; '), problems: problems.length });
    }
    var summary = runSync_(payload);
    logSync_(merge_(base, summary, { status: 'ok' }));
    return json_({ ok: true, summary: summary });
  } catch (err) {
    logSync_(merge_(base, { status: 'error', error: (err && err.stack) || String(err) }));
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

/** Health check: confirms the URL points at this script. Exposes no data. */
function doGet() {
  return json_({ ok: true, service: 'tpl-history-sync', schemaVersion: SCHEMA_VERSION });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function merge_() {
  var out = {};
  for (var i = 0; i < arguments.length; i++) {
    var o = arguments[i];
    for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
  }
  return out;
}
