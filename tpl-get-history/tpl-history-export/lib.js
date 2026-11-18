// lib.js -- pure helpers (no DOM, no chrome.* APIs) so they can be unit-tested in Node.
// Loaded before content.js; both share the content script's isolated world.

const TPL = {
  GATEWAY: 'https://gateway.bibliocommons.com/v2/libraries/tpl',
  LOCALE: 'en-CA',
  SCHEMA_VERSION: 1,
  PAGE_DELAY_MS: 750,
};

// Find the account ID in the server-rendered state blob.
// Observed structure:
//   auth.currentUserId                 -> user id
//   entities.users[<userId>].accounts  -> [accountId, ...]
//   entities.accounts[<accountId>]     -> { id, borrowingHistoryEnabled, ... }
// Takes the list of JSON strings so it stays DOM-free.
function findAccountId(jsonTexts) {
  for (const text of jsonTexts) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      continue;
    }
    const accounts = obj && obj.entities && obj.entities.accounts;
    if (!accounts || typeof accounts !== 'object') continue;

    // Prefer the accounts linked to the logged-in user
    const userId = obj.auth && obj.auth.currentUserId;
    const user = userId != null && obj.entities.users && obj.entities.users[userId];
    const linkedIds = (user && Array.isArray(user.accounts) ? user.accounts : []).map(String);

    const all = Object.values(accounts).filter((a) => a && a.id != null);
    const linked = all.filter((a) => linkedIds.includes(String(a.id)));
    const pool = linked.length ? linked : all;
    const acct = pool.find((a) => a.borrowingHistoryEnabled) || pool[0];
    if (acct) return String(acct.id);
  }
  return null;
}

// Reduce one gateway page to loans + bibs.
function extractPage(data) {
  const ents = (data && data.entities) || {};
  const hist = (data && data.borrowing && data.borrowing.borrowingHistory) || {};
  const historyById = ents.borrowingHistory || {};

  // Follow results[] so the display order (newest return first) is kept.
  const ids = Array.isArray(hist.results) ? hist.results : Object.keys(historyById);
  const loans = ids
    .map((id) => historyById[id])
    .filter(Boolean)
    .map((h) => ({
      loanId: String(h.id),
      bibId: h.metadataId,
      checkedOut: h.checkedoutDate || null,
      returned: h.returnedDate || null,
    }));

  const bibs = Object.values(ents.bibs || {}).map((bib) => {
    const b = bib.briefInfo || {};
    return {
      bibId: bib.id,
      title: b.title || null,
      subtitle: b.subtitle || null,
      authors: b.authors || [],
      format: b.format || null,
      publicationDate: b.publicationDate || null,
      isbns: b.isbns || [],
      series: b.series || [],
      language: b.primaryLanguage || null,
      contentType: b.contentType || null,
      audiences: b.audiences || [],
      callNumber: b.callNumber || null,
      subjects: b.subjectHeadings || [],
      genres: b.genreForm || [],
    };
  });

  return { loans, bibs, pagination: hist.pagination || null };
}

// Merge extracted pages into one snapshot payload and validate it.
// mode: "full" | "recent"
function buildSnapshot(extractedPages, opts) {
  const loans = [];
  const bibsById = new Map();
  for (const p of extractedPages) {
    loans.push(...p.loans);
    // The same book can appear on several pages (borrowed more than once);
    // keep one record per bibId.
    for (const b of p.bibs) if (!bibsById.has(b.bibId)) bibsById.set(b.bibId, b);
  }

  const first = extractedPages[0] && extractedPages[0].pagination;
  const count = first ? first.count : null;
  const totalPages = first ? first.pages : null;

  const warnings = [];
  const seen = new Set();
  const dupIds = new Set();
  for (const l of loans) {
    if (seen.has(l.loanId)) dupIds.add(l.loanId);
    seen.add(l.loanId);
  }
  if (dupIds.size) warnings.push(`Duplicate loanIds: ${[...dupIds].slice(0, 10).join(', ')}`);

  const missingBibs = loans.filter((l) => !bibsById.has(l.bibId)).map((l) => l.bibId);
  if (missingBibs.length) warnings.push(`Loans without bib record: ${missingBibs.length}`);

  if (opts.mode === 'full' && count != null && loans.length !== count) {
    warnings.push(`Loan count ${loans.length} != reported total ${count}`);
  }

  return {
    schemaVersion: TPL.SCHEMA_VERSION,
    source: 'tpl',
    mode: opts.mode,
    fetchedAt: opts.fetchedAt,
    pagesRequested: opts.pagesRequested,
    pagesFetched: extractedPages.length,
    totalPages,
    count,
    valid: warnings.length === 0,
    warnings,
    loans,
    bibs: [...bibsById.values()],
  };
}

// Expose for Node tests; harmless in the browser.
if (typeof module !== 'undefined') module.exports = { TPL, findAccountId, extractPage, buildSnapshot };
