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
 * filled light magenta 2. If the tab has no such heading row yet, it is added
 * at the bottom of the tab, unformatted, when there is something to insert.
 * Each new row gets the title, description, author, link, the date found and
 * the publication date.
 * On target tabs the columns are located by header name (row 1), so their
 * order does not matter: Title, Description, Author, Link, Date found,
 * Publication Date.
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
  TAB_HEADER_ROW: 1,         // header row on target tabs
  TAB_HEADERS: {
    title: 'Title',
    description: 'Description',
    author: 'Author',
    link: 'Link',
    date: 'Date found',
    published: 'Publication Date'
  },
  NEW_ROW_COLOR: '#d5a6bd',  // light magenta 2
  DATE_FORMAT: 'yyyy-mm-dd',
  MAX_PAGES: 20,
  PAUSE_MS: 500              // polite pause between page requests
};

var RECORD_ID_RE = /S\d+C\d+/;
var RECORD_ID_RE_ALL = /S\d+C\d+/g;
var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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
    notify_('Another run is in progress. Wait for it to finish, then try again.');
    return;
  }
  try {
    runFeeds_();
  } catch (e) {
    // Problems with the Feeds tab itself are shown to the user. Without a UI
    // (timed trigger) the error is rethrown so the execution shows as failed.
    if (!notify_('The feed check stopped: ' + e.message)) throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Reads the Feeds tab and processes every configured feed in order. */
function runFeeds_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var feedsSheet = ss.getSheetByName(CONFIG.FEEDS_SHEET);
  if (!feedsSheet) throw new Error('Tab "' + CONFIG.FEEDS_SHEET + '" not found.');
  if (feedsSheet.getLastRow() === 0) {
    var headerNames = Object.keys(CONFIG.HEADERS).map(function (k) { return CONFIG.HEADERS[k]; });
    throw new Error('Tab "' + CONFIG.FEEDS_SHEET + '" is empty. Add a header row (' +
      headerNames.join(', ') + ') and one row per feed.');
  }

  var data = feedsSheet.getDataRange().getValues();
  var cols = findHeaderColumns_(data[0]);

  // Collect the feed rows first, so that all of them can be marked as queued.
  var feeds = [];
  for (var r = 1; r < data.length; r++) {
    var feed = {
      row: r + 1,
      label: String(data[r][cols.label]).trim(),
      tabName: String(data[r][cols.tab]).trim(),
      url: String(data[r][cols.url]).trim(),
      depth: String(data[r][cols.depth]).trim().toLowerCase()
    };
    if (!feed.label && !feed.tabName && !feed.url && !feed.depth) continue;  // blank row
    feeds.push(feed);
  }
  if (feeds.length === 0) {
    throw new Error('Tab "' + CONFIG.FEEDS_SHEET + '" has no feed rows.');
  }

  // Show right away that a run is going on.
  var queued = timestamp_(ss) + ' - queued';
  feeds.forEach(function (f) {
    feedsSheet.getRange(f.row, cols.log + 1).setValue(queued);
  });
  SpreadsheetApp.flush();

  feeds.forEach(function (f) {
    var message;
    try {
      if (!f.label || !f.tabName || !f.url) {
        throw new Error('Label, Target tab and Feed URL are all required.');
      }
      if (f.depth === '' || f.depth === 'none') {
        message = 'skipped (Depth is ' + (f.depth === '' ? 'empty' : 'None') + ')';
      } else if (f.depth !== 'full' && f.depth !== 'recent') {
        throw new Error('Depth must be Full, Recent or None.');
      } else {
        var maxPages = (f.depth === 'recent') ? 1 : CONFIG.MAX_PAGES;
        var result = processFeed_(ss, f.label, f.tabName, f.url, maxPages);
        var notes = [];
        if (result.headingCreated) notes.push('heading created');
        if (f.depth === 'recent') {
          notes.push('first page only');
        } else if (result.truncated) {
          notes.push('stopped at ' + CONFIG.MAX_PAGES + ' pages');
        }
        message = result.added + ' new' + (notes.length ? ' (' + notes.join(', ') + ')' : '');
      }
    } catch (e) {
      message = 'ERROR: ' + e.message;
    }
    feedsSheet.getRange(f.row, cols.log + 1).setValue(timestamp_(ss) + ' - ' + message);
    SpreadsheetApp.flush();
  });
}

/**
 * Shows a message in an alert dialog. Returns false when no UI is available
 * (for example in a timed trigger); the message is always logged as well.
 */
function notify_(message) {
  Logger.log(message);
  try {
    SpreadsheetApp.getUi().alert(message);
    return true;
  } catch (e) {
    return false;
  }
}

/** Handles one feed row. Returns {added, truncated, headingCreated}. */
function processFeed_(ss, label, tabName, url, maxPages) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab "' + tabName + '" not found.');

  // Fail fast on a missing column or a duplicated heading before calling the network.
  var tabCols = findTabColumns_(sheet);
  findHeadingRow_(sheet, label, tabCols);

  var fetched = fetchAllItems_(url, maxPages);

  // Re-read the tab after fetching so rows added by earlier feeds count too.
  var headingRow = findHeadingRow_(sheet, label, tabCols);
  var existing = collectExistingIds_(sheet, tabCols.link);
  var fresh = fetched.items.filter(function (item) {
    return !existing[item.id];
  });

  var headingCreated = false;
  if (fresh.length) {
    if (!headingRow) {
      headingRow = appendHeading_(sheet, label, tabCols);
      headingCreated = true;
    }
    insertRows_(sheet, headingRow, fresh, tabCols);
  }
  return { added: fresh.length, truncated: fetched.truncated, headingCreated: headingCreated };
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

/** Maps target tab header names to one-based column numbers. */
function findTabColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) throw new Error('Tab "' + sheet.getName() + '" is empty.');
  var names = sheet.getRange(CONFIG.TAB_HEADER_ROW, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var cols = {};
  Object.keys(CONFIG.TAB_HEADERS).forEach(function (key) {
    var idx = names.indexOf(CONFIG.TAB_HEADERS[key]);
    if (idx === -1) {
      throw new Error('Column "' + CONFIG.TAB_HEADERS[key] + '" not found in row ' +
        CONFIG.TAB_HEADER_ROW + ' of tab "' + sheet.getName() + '".');
    }
    cols[key] = idx + 1;
  });
  return cols;
}

/**
 * Finds the heading row: Title column equals the label, Link column empty.
 * Returns the row number, or 0 when there is no such row. Throws when there
 * are several.
 */
function findHeadingRow_(sheet, label, tabCols) {
  var firstRow = CONFIG.TAB_HEADER_ROW + 1;
  var count = sheet.getLastRow() - firstRow + 1;
  var matches = [];
  if (count > 0) {
    var titles = sheet.getRange(firstRow, tabCols.title, count, 1).getValues();
    var links = sheet.getRange(firstRow, tabCols.link, count, 1).getValues();
    for (var i = 0; i < count; i++) {
      var title = String(titles[i][0]).trim();
      var link = String(links[i][0]).trim();
      if (title === label && link === '') matches.push(firstRow + i);
    }
  }
  if (matches.length > 1) {
    throw new Error('Heading "' + label + '" appears ' + matches.length + ' times on tab "' + sheet.getName() + '".');
  }
  return matches.length ? matches[0] : 0;
}

/**
 * Adds a heading row below everything already on the tab. Only the Title cell
 * is filled; no formatting is applied. Returns the new row number.
 */
function appendHeading_(sheet, label, tabCols) {
  var row = Math.max(sheet.getLastRow(), CONFIG.TAB_HEADER_ROW) + 1;
  var maxRows = sheet.getMaxRows();
  if (row > maxRows) {
    // Inserted rows copy the format of the row above; reset it so that the
    // heading stays unformatted.
    sheet.insertRowsAfter(maxRows, row - maxRows);
    sheet.getRange(maxRows + 1, 1, row - maxRows, sheet.getMaxColumns()).clearFormat();
  }
  sheet.getRange(row, tabCols.title).setValue(label);
  return row;
}

/**
 * Collects the record IDs found in the Link column (values and formulas, so a
 * HYPERLINK formula counts). Other columns are not scanned.
 */
function collectExistingIds_(sheet, linkCol) {
  var ids = {};
  var firstRow = CONFIG.TAB_HEADER_ROW + 1;
  var count = sheet.getLastRow() - firstRow + 1;
  if (count < 1) return ids;
  var range = sheet.getRange(firstRow, linkCol, count, 1);
  [range.getValues(), range.getFormulas()].forEach(function (grid) {
    grid.forEach(function (row) {
      var found = String(row[0]).match(RECORD_ID_RE_ALL);
      if (found) found.forEach(function (id) { ids[id] = true; });
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

/**
 * Fetches one RSS page and returns
 * [{id, title, description, author, published, link}].
 */
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
      description: childText_(item, 'description'),
      author: creators_(item),
      published: parsePubDate_(childText_(item, 'pubDate')),
      link: link
    });
  });
  return result;
}

/**
 * Joins the text of all creator elements of an item with "; ". The element is
 * matched by its local name, so the namespace prefix (dc:) does not matter.
 */
function creators_(item) {
  return item.getChildren()
    .filter(function (child) { return child.getName() === 'creator'; })
    .map(function (child) { return child.getText().trim(); })
    .filter(function (text) { return text !== ''; })
    .join('; ');
}

/**
 * Extracts the date part of an RFC 822 date such as "Sat, 31 Jan 2026 00:00:00 GMT".
 * The date is taken as written, without time zone conversion.
 * Returns 'yyyy-MM-dd', or '' when the text is not a valid date.
 */
function parsePubDate_(text) {
  var m = String(text).trim().match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s|$)/);
  if (!m) return '';
  var day = parseInt(m[1], 10);
  var month = MONTHS.indexOf(m[2].toLowerCase());
  var year = parseInt(m[3], 10);
  if (month === -1) return '';
  var check = new Date(year, month, day);
  if (check.getFullYear() !== year || check.getMonth() !== month || check.getDate() !== day) return '';
  return m[3] + '-' + pad2_(month + 1) + '-' + pad2_(day);
}

/** Left-pads a number to two digits. */
function pad2_(n) {
  return ('0' + n).slice(-2);
}

/** Inserts new rows under the heading, resets inherited formatting, fills them. */
function insertRows_(sheet, headingRow, items, tabCols) {
  var n = items.length;
  var first = headingRow + 1;
  sheet.insertRowsAfter(headingRow, n);

  // Inserted rows copy the heading row format; clear it across the full width.
  sheet.getRange(first, 1, n, sheet.getMaxColumns()).clearFormat();

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Midnight in the spreadsheet time zone, so the date shown is the date parsed.
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var published = items.map(function (item) {
    return item.published ? Utilities.parseDate(item.published, tz, 'yyyy-MM-dd') : '';
  });

  // Plain text format keeps a description starting with "=" from becoming a formula.
  sheet.getRange(first, tabCols.description, n, 1).setNumberFormat('@');

  writeColumn_(sheet, first, tabCols.title, items.map(function (i) { return i.title; }));
  writeColumn_(sheet, first, tabCols.description, items.map(function (i) { return i.description; }));
  writeColumn_(sheet, first, tabCols.author, items.map(function (i) { return i.author; }));
  writeColumn_(sheet, first, tabCols.link, items.map(function (i) { return i.link; }));
  writeColumn_(sheet, first, tabCols.date, items.map(function () { return today; }));
  writeColumn_(sheet, first, tabCols.published, published);
  sheet.getRange(first, tabCols.date, n, 1).setNumberFormat(CONFIG.DATE_FORMAT);
  sheet.getRange(first, tabCols.published, n, 1).setNumberFormat(CONFIG.DATE_FORMAT);

  // Highlight the span covered by the columns we fill.
  var colNumbers = Object.keys(CONFIG.TAB_HEADERS).map(function (key) { return tabCols[key]; });
  var firstCol = Math.min.apply(null, colNumbers);
  var lastCol = Math.max.apply(null, colNumbers);
  sheet.getRange(first, firstCol, n, lastCol - firstCol + 1)
    .setBackground(CONFIG.NEW_ROW_COLOR);
}

/** Writes a flat array of values into one column, starting at the given row. */
function writeColumn_(sheet, firstRow, col, values) {
  sheet.getRange(firstRow, col, values.length, 1)
    .setValues(values.map(function (v) { return [v]; }));
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