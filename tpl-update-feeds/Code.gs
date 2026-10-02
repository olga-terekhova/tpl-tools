/**
 * Library feed checker (Google Apps Script, bound to the spreadsheet).
 *
 * Reads every row of the "Feeds" tab and inserts books from each BiblioCommons
 * RSS feed whose record ID is not yet on the target tab.
 * The Depth column controls how much of a feed is read:
 *   Full   - every page, for the initial extract
 *   Recent - page 1 only, for routine incremental checks
 *   None   - the feed is skipped (an empty cell is treated the same way)
 * New rows go directly under the author/series heading row, in feed order,
 * filled light magenta 2, with the date found in the third column.
 * The Log cell of each feed row is overwritten with the latest result.
 */

var CONFIG = {
  FEEDS_SHEET: 'Feeds',
  HEADERS: {
    label: 'Label',
    tab: 'Target tab',
    url: 'Feed URL',
    depth: 'Depth',
    log: 'Log'
  },
  TITLE_COL: 1,              // column A on genre tabs
  LINK_COL: 2,               // column B on genre tabs
  DATE_COL: 3,               // column C on genre tabs
  NEW_ROW_COLOR: '#d5a6bd',  // light magenta 2
  DATE_FORMAT: 'yyyy-mm-dd',
  MAX_PAGES: 20,
  PAUSE_MS: 500              // polite pause between page requests
};

var RECORD_ID_RE = /S\d+C\d+/;
var RECORD_ID_RE_ALL = /S\d+C\d+/g;

/** Adds the Library menu when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Library')
    .addItem('Check feeds now', 'checkFeeds')
    .addToUi();
}

/** Entry point for the menu item and for a timed trigger. */
function checkFeeds() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another run is in progress; skipping.');
    return;
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var feedsSheet = ss.getSheetByName(CONFIG.FEEDS_SHEET);
    if (!feedsSheet) throw new Error('Tab "' + CONFIG.FEEDS_SHEET + '" not found.');

    var data = feedsSheet.getDataRange().getValues();
    var cols = findHeaderColumns_(data[0]);

    for (var r = 1; r < data.length; r++) {
      var label = String(data[r][cols.label]).trim();
      var tabName = String(data[r][cols.tab]).trim();
      var url = String(data[r][cols.url]).trim();
      var depth = String(data[r][cols.depth]).trim().toLowerCase();
      if (!label && !tabName && !url && !depth) continue;  // blank row

      var message;
      try {
        if (!label || !tabName || !url) {
          throw new Error('Label, Target tab and Feed URL are all required.');
        }
        if (depth === '' || depth === 'none') {
          message = 'skipped (Depth is ' + (depth === '' ? 'empty' : 'None') + ')';
        } else if (depth !== 'full' && depth !== 'recent') {
          throw new Error('Depth must be Full, Recent or None.');
        } else {
          var maxPages = (depth === 'recent') ? 1 : CONFIG.MAX_PAGES;
          var result = processFeed_(ss, label, tabName, url, maxPages);
          message = result.added + ' new';
          if (depth === 'recent') {
            message += ' (first page only)';
          } else if (result.truncated) {
            message += ' (stopped at ' + CONFIG.MAX_PAGES + ' pages)';
          }
        }
      } catch (e) {
        message = 'ERROR: ' + e.message;
      }
      feedsSheet.getRange(r + 1, cols.log + 1).setValue(timestamp_(ss) + ' - ' + message);
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
}

/** Handles one feed row. Returns {added, truncated}. */
function processFeed_(ss, label, tabName, url, maxPages) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab "' + tabName + '" not found.');

  // Fail fast on a missing heading before calling the network.
  findHeadingRow_(sheet, label);

  var fetched = fetchAllItems_(url, maxPages);

  // Re-read the tab after fetching so rows added by earlier feeds count too.
  var headingRow = findHeadingRow_(sheet, label);
  var existing = collectExistingIds_(sheet);
  var fresh = fetched.items.filter(function (item) {
    return !existing[item.id];
  });

  if (fresh.length) insertRows_(sheet, headingRow, fresh);
  return { added: fresh.length, truncated: fetched.truncated };
}

/** Maps Feeds header names to zero-based column indexes. */
function findHeaderColumns_(headerRow) {
  var names = headerRow.map(function (h) { return String(h).trim(); });
  var cols = {};
  Object.keys(CONFIG.HEADERS).forEach(function (key) {
    var idx = names.indexOf(CONFIG.HEADERS[key]);
    if (idx === -1) {
      throw new Error('Column "' + CONFIG.HEADERS[key] + '" not found on "' + CONFIG.FEEDS_SHEET + '".');
    }
    cols[key] = idx;
  });
  return cols;
}

/** Finds the single heading row: column A equals the label, Link column empty. */
function findHeadingRow_(sheet, label) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) throw new Error('Tab "' + sheet.getName() + '" is empty.');
  var values = sheet.getRange(1, 1, lastRow, CONFIG.LINK_COL).getValues();
  var matches = [];
  for (var i = 0; i < values.length; i++) {
    var a = String(values[i][CONFIG.TITLE_COL - 1]).trim();
    var link = String(values[i][CONFIG.LINK_COL - 1]).trim();
    if (a === label && link === '') matches.push(i + 1);
  }
  if (matches.length === 0) {
    throw new Error('Heading "' + label + '" not found on tab "' + sheet.getName() + '".');
  }
  if (matches.length > 1) {
    throw new Error('Heading "' + label + '" appears ' + matches.length + ' times on tab "' + sheet.getName() + '".');
  }
  return matches[0];
}

/** Collects every record ID found anywhere on the tab (values and formulas). */
function collectExistingIds_(sheet) {
  var ids = {};
  var range = sheet.getDataRange();
  [range.getValues(), range.getFormulas()].forEach(function (grid) {
    grid.forEach(function (row) {
      row.forEach(function (cell) {
        var found = String(cell).match(RECORD_ID_RE_ALL);
        if (found) found.forEach(function (id) { ids[id] = true; });
      });
    });
  });
  return ids;
}

/**
 * Reads up to maxPages pages, stopping early when a page adds no new IDs.
 * Returns {items, truncated}, where truncated means the limit was reached.
 */
function fetchAllItems_(feedUrl, maxPages) {
  var base = feedUrl.replace(/&amp;/g, '&');
  var items = [];
  var seen = {};
  for (var page = 1; page <= maxPages; page++) {
    var added = 0;
    fetchPage_(withPage_(base, page)).forEach(function (item) {
      if (!seen[item.id]) {
        seen[item.id] = true;
        items.push(item);
        added++;
      }
    });
    if (added === 0) return { items: items, truncated: false };
    Utilities.sleep(CONFIG.PAUSE_MS);
  }
  return { items: items, truncated: true };
}

/** Sets or appends the page parameter, leaving the rest of the URL as-is. */
function withPage_(url, page) {
  if (/([?&])page=\d*/.test(url)) {
    return url.replace(/([?&])page=\d*/, '$1page=' + page);
  }
  return url + (url.indexOf('?') === -1 ? '?' : '&') + 'page=' + page;
}

/** Fetches one RSS page and returns [{id, title, link}]. */
function fetchPage_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ' when reading the feed.');

  var root = XmlService.parse(resp.getContentText('UTF-8')).getRootElement();
  var channel = root.getChild('channel');
  if (!channel) throw new Error('Unexpected feed format (no channel element).');

  var result = [];
  channel.getChildren('item').forEach(function (item) {
    var link = childText_(item, 'link') || childText_(item, 'guid');
    var match = link.match(RECORD_ID_RE);
    if (!match) return;  // not a catalogue record; ignore
    var title = childText_(item, 'title');
    var subtitle = childText_(item, 'subtitle');
    result.push({
      id: match[0],
      title: subtitle ? title + ' : ' + subtitle : title,
      link: link
    });
  });
  return result;
}

/** Inserts new rows under the heading, resets inherited formatting, fills them. */
function insertRows_(sheet, headingRow, items) {
  var n = items.length;
  var first = headingRow + 1;
  sheet.insertRowsAfter(headingRow, n);

  // Inserted rows copy the heading row format; clear it across the full width.
  sheet.getRange(first, 1, n, sheet.getMaxColumns()).clearFormat();

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var values = items.map(function (item) { return [item.title, item.link, today]; });

  sheet.getRange(first, 1, n, CONFIG.DATE_COL)
    .setValues(values)
    .setBackground(CONFIG.NEW_ROW_COLOR);
  sheet.getRange(first, CONFIG.DATE_COL, n, 1).setNumberFormat(CONFIG.DATE_FORMAT);
}

/** Returns the trimmed text of a child element, or an empty string. */
function childText_(element, name) {
  var child = element.getChild(name);
  return child ? child.getText().trim() : '';
}

/** Formats the current time in the spreadsheet time zone. */
function timestamp_(ss) {
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}