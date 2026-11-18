/**
 * Spreadsheet menu and one-off setup helpers (run from the editor or the menu).
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('TPL sync')
    .addItem('Rebuild history view', 'menuRebuildHistory')
    .addItem('Set up sheets', 'setupSheets')
    .addToUi();
}

/** Refreshes "history", e.g. after editing manual columns. */
function menuRebuildHistory() {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var n = rebuildHistory_(getSpreadsheet_());
    SpreadsheetApp.getActive().toast('History rebuilt: ' + n + ' rows', 'TPL sync');
  } finally {
    lock.releaseLock();
  }
}

/** Creates all sheets and header rows. Safe to run more than once. */
function setupSheets() {
  var ss = getSpreadsheet_();
  [LAYOUT.loans, LAYOUT.bibs, LAYOUT.bibAuthors, LAYOUT.bibSeries, LAYOUT.syncLog]
    .forEach(function (layout) { ensureSheet_(ss, layout); });
  rebuildHistory_(ss);
}

/**
 * Creates SHARED_SECRET if it does not exist and prints it to the execution log,
 * so it can be copied into the extension's options page.
 */
function createSharedSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SHARED_SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SHARED_SECRET', secret);
  }
  console.log('SHARED_SECRET: ' + secret);
}
