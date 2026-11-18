// content.js -- injects a thin toolbar on /v2/recentlyreturned pages and runs the export.
// Uses helpers from lib.js (TPL, findAccountId, extractPage, buildSnapshot).

(() => {
  const URL_PREFIX = 'https://tpl.bibliocommons.com/v2/recentlyreturned';
  const RECENT_CHOICES = [1, 2, 3, 5, 10];
  const HOST_ID = 'tpl-history-export-host';

  let abortCtrl = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- data access -------------------------------------------------------

  function getAccountId() {
    const nodes = document.querySelectorAll('script[type="application/json"][data-iso-key]');
    const id = findAccountId([...nodes].map((n) => n.textContent));
    if (!id) throw new Error('Account ID not found on this page. Reload the page while logged in.');
    return id;
  }

  async function fetchHistoryPage(accountId, page, signal) {
    const url = new URL(`${TPL.GATEWAY}/borrowinghistory`);
    url.searchParams.set('accountId', accountId);
    url.searchParams.set('page', String(page));
    url.searchParams.set('locale', TPL.LOCALE);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Not authorized (HTTP ${res.status}). Are you still logged in?`);
      }
      // Retry once on rate limiting / server errors
      if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
        await sleep(3000);
        continue;
      }
      throw new Error(`HTTP ${res.status} on page ${page}`);
    }
  }

  // maxPages: number, or Infinity for full history
  async function runExport(maxPages, onProgress, signal) {
    const accountId = getAccountId();
    const fetchedAt = new Date().toISOString();
    const pages = [];
    let page = 1;
    let totalPages = 1;

    do {
      onProgress(`Fetching page ${page}${totalPages > 1 ? ` of ${Math.min(totalPages, maxPages)}` : ''}...`);
      const extracted = extractPage(await fetchHistoryPage(accountId, page, signal));
      pages.push(extracted);
      if (extracted.pagination && extracted.pagination.pages) totalPages = extracted.pagination.pages;
      page += 1;
      if (page <= Math.min(totalPages, maxPages)) await sleep(TPL.PAGE_DELAY_MS);
    } while (page <= Math.min(totalPages, maxPages));

    return buildSnapshot(pages, {
      mode: maxPages === Infinity ? 'full' : 'recent',
      pagesRequested: maxPages === Infinity ? totalPages : maxPages,
      fetchedAt,
    });
  }

  function downloadJson(obj) {
    const stamp = obj.fetchedAt.replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tpl-history-${obj.mode}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- UI ----------------------------------------------------------------

  function buildBar() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    // Shadow DOM keeps page CSS and ours from interfering with each other
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
               display: flex; gap: 8px; align-items: center; padding: 6px 12px;
               font: 13px/1.3 system-ui, sans-serif; color: #1a1a1a;
               background: #f3f6fa; border-bottom: 1px solid #c8d1dc;
               box-shadow: 0 1px 3px rgba(0,0,0,.08); }
        .title { font-weight: 600; margin-right: 4px; }
        button, select { font: inherit; padding: 2px 8px; }
        .status { margin-left: 8px; color: #444; flex: 1; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap; }
        .status.err { color: #b00020; }
        .status.ok { color: #1b6e2a; }
        .close { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 16px; }
      </style>
      <div class="bar">
        <span class="title">History export</span>
        <button id="all">Export all</button>
        <span>|</span>
        <select id="n">${RECENT_CHOICES.map((n) => `<option value="${n}">${n} page${n > 1 ? 's' : ''} (${n * 50})</option>`).join('')}</select>
        <button id="recent">Export recent</button>
        <button id="cancel" hidden>Cancel</button>
        <span class="status" id="status"></span>
        <button class="close" id="close" title="Hide">x</button>
      </div>`;

    const $ = (id) => root.getElementById(id);
    const setStatus = (text, cls = '') => {
      const s = $('status');
      s.textContent = text;
      s.className = `status ${cls}`;
    };
    const setBusy = (busy) => {
      $('all').disabled = busy;
      $('recent').disabled = busy;
      $('n').disabled = busy;
      $('cancel').hidden = !busy;
    };

    async function start(maxPages) {
      abortCtrl = new AbortController();
      setBusy(true);
      try {
        const snap = await runExport(maxPages, (t) => setStatus(t), abortCtrl.signal);
        downloadJson(snap);
        const summary = `${snap.loans.length} loans, ${snap.bibs.length} books, ${snap.pagesFetched} page(s)`;
        if (snap.valid) setStatus(`Done: ${summary}.`, 'ok');
        else setStatus(`Done with warnings: ${summary}. ${snap.warnings.join('; ')}`, 'err');
      } catch (e) {
        if (e.name === 'AbortError') setStatus('Cancelled.');
        else setStatus(`Error: ${e.message}`, 'err');
      } finally {
        abortCtrl = null;
        setBusy(false);
      }
    }

    $('all').addEventListener('click', () => start(Infinity));
    $('recent').addEventListener('click', () => start(Number($('n').value)));
    $('cancel').addEventListener('click', () => abortCtrl && abortCtrl.abort());
    $('close').addEventListener('click', () => host.remove());
    return host;
  }

  // ---- show/hide by URL (the site may navigate without full page loads) ----

  let lastHref = null;
  function sync() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const existing = document.getElementById(HOST_ID);
    const onTarget = location.href.startsWith(URL_PREFIX);
    if (onTarget && !existing) document.documentElement.appendChild(buildBar());
    if (!onTarget && existing) {
      if (abortCtrl) abortCtrl.abort();
      existing.remove();
    }
  }

  sync();
  setInterval(sync, 1000);
})();
