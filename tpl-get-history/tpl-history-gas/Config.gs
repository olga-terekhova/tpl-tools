/**
 * Config: payload contract version, sheet layouts and cell formats.
 *
 * Each layout lists the script-managed columns, left to right.
 * For "loans" and "bibs", any column to the right of the managed block
 * belongs to the user and is never written by the ETL.
 */

var SCHEMA_VERSION = 1;
var LIST_SEP = ' | ';
var LOCK_WAIT_MS = 30000;
var MAX_ERROR_CHARS = 2000;

var FMT = {
  TEXT: '@',
  DATE: 'yyyy-mm-dd',
  TS: 'yyyy-mm-dd hh:mm:ss',
  INT: '0'
};

function col_(name, fmt) {
  return { name: name, fmt: fmt };
}

var LAYOUT = {
  loans: {
    name: 'loans',
    key: 'loanId',
    cols: [
      col_('loanId', FMT.TEXT),
      col_('bibId', FMT.TEXT),
      col_('checkedOut', FMT.DATE),
      col_('returned', FMT.DATE),
      col_('insertedAt', FMT.TS),
      col_('updatedAt', FMT.TS)
    ]
  },
  bibs: {
    name: 'bibs',
    key: 'bibId',
    cols: [
      col_('bibId', FMT.TEXT),
      col_('title', FMT.TEXT),
      col_('subtitle', FMT.TEXT),
      col_('authors', FMT.TEXT),
      col_('series', FMT.TEXT),
      col_('format', FMT.TEXT),
      col_('publicationDate', FMT.TEXT),
      col_('language', FMT.TEXT),
      col_('contentType', FMT.TEXT),
      col_('callNumber', FMT.TEXT),
      col_('isbns', FMT.TEXT),
      col_('subjects', FMT.TEXT),
      col_('genres', FMT.TEXT),
      col_('audiences', FMT.TEXT),
      col_('insertedAt', FMT.TS),
      col_('updatedAt', FMT.TS)
    ]
  },
  bibAuthors: {
    name: 'bib_authors',
    cols: [
      col_('bibId', FMT.TEXT),
      col_('position', FMT.INT),
      col_('author', FMT.TEXT)
    ]
  },
  bibSeries: {
    name: 'bib_series',
    cols: [
      col_('bibId', FMT.TEXT),
      col_('position', FMT.INT),
      col_('series', FMT.TEXT),
      col_('volume', FMT.TEXT)
    ]
  },
  history: {
    name: 'history',
    cols: [
      col_('returned', FMT.DATE),
      col_('checkedOut', FMT.DATE),
      col_('title', FMT.TEXT),
      col_('subtitle', FMT.TEXT),
      col_('authors', FMT.TEXT),
      col_('series', FMT.TEXT),
      col_('format', FMT.TEXT),
      col_('publicationDate', FMT.TEXT),
      col_('callNumber', FMT.TEXT),
      col_('loanId', FMT.TEXT),
      col_('bibId', FMT.TEXT)
    ]
  },
  syncLog: {
    name: 'sync_log',
    cols: [
      col_('receivedAt', FMT.TS),
      col_('fetchedAt', FMT.TS),
      col_('mode', FMT.TEXT),
      col_('count', FMT.INT),
      col_('loansReceived', FMT.INT),
      col_('loansInserted', FMT.INT),
      col_('loansUpdated', FMT.INT),
      col_('bibsInserted', FMT.INT),
      col_('bibsUpdated', FMT.INT),
      col_('warnings', FMT.TEXT),
      col_('status', FMT.TEXT),
      col_('error', FMT.TEXT)
    ]
  }
};

function colNames_(layout) {
  return layout.cols.map(function (c) { return c.name; });
}

function colFormats_(layout) {
  return layout.cols.map(function (c) { return c.fmt; });
}
