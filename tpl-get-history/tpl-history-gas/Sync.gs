/**
 * Sync: runs the ETL for one validated payload.
 *
 * Order: bibs, then child tables, then loans, so a loan never points to a
 * bib that is not in the sheet yet. Every step is an idempotent upsert, so
 * if a run fails half way, sending the same snapshot again completes it.
 */
function runSync_(payload) {
  var ss = getSpreadsheet_();
  var tz = ss.getSpreadsheetTimeZone();
  var now = nowStamp_(tz);

  var loans = prepareLoans_(payload.loans);
  var bibs = prepareBibs_(payload.bibs, loans);
  var bibOrder = bibs.map(function (b) { return str_(b.bibId); });

  // Bibs (SCD 1: overwrite changed attributes in place).
  var bibsSheet = ensureSheet_(ss, LAYOUT.bibs);
  var bibsT = readTable_(bibsSheet, LAYOUT.bibs, tz, false);
  var bibPlan = planUpsert_(LAYOUT.bibs, bibsT, bibs.map(bibRecord_), now);
  applyUpsert_(bibsSheet, LAYOUT.bibs, bibsT, bibPlan);

  // Child tables: replace a bib's rows only when its list changed.
  var authorsChanged = syncChildren_(ss, LAYOUT.bibAuthors, tz, authorRowsByBib_(bibs), bibOrder);
  var seriesChanged = syncChildren_(ss, LAYOUT.bibSeries, tz, seriesRowsByBib_(bibs), bibOrder);

  // Loans (insert new, update changed; never delete).
  var loansSheet = ensureSheet_(ss, LAYOUT.loans);
  var loansT = readTable_(loansSheet, LAYOUT.loans, tz, false);
  var loanPlan = planUpsert_(LAYOUT.loans, loansT, loans, now);
  applyUpsert_(loansSheet, LAYOUT.loans, loansT, loanPlan);

  SpreadsheetApp.flush();
  var historyRows = rebuildHistory_(ss);

  return {
    mode: payload.mode,
    loansReceived: loans.length,
    loansInserted: loanPlan.inserted,
    loansUpdated: loanPlan.updated,
    bibsReceived: bibs.length,
    bibsInserted: bibPlan.inserted,
    bibsUpdated: bibPlan.updated,
    authorListsChanged: authorsChanged,
    seriesListsChanged: seriesChanged,
    historyRows: historyRows
  };
}

function syncChildren_(ss, layout, tz, incomingByBib, bibOrder) {
  var sheet = ensureSheet_(ss, layout);
  var t = readTable_(sheet, layout, tz, false);
  var plan = planChildren_(t, incomingByBib, bibOrder);
  if (plan.changedBibs) rewriteTable_(sheet, layout, plan.rows);
  return plan.changedBibs;
}
