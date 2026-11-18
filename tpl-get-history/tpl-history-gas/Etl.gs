/**
 * ETL: pure functions (no SpreadsheetApp calls), so they can be tested in Node.
 *
 * A "table" read from a sheet looks like:
 *   { norm: [[...]],    managed block, values normalized to strings
 *     raw:  [[...]],    managed block, values exactly as read
 *     lastRow: n,       last used row of the whole sheet (1 = header only)
 *     manual: null | { headers: [...], values: [[...]], formats: [[...]] } }
 */

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function list_(arr) {
  return (Array.isArray(arr) ? arr : []).map(str_).filter(Boolean).join(LIST_SEP);
}

function cmp_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpLoanId_(a, b) {
  // Loan ids are signed 32-bit integers stored as strings.
  var d = Number(a) - Number(b);
  return d ? d : cmp_(a, b);
}

/** Oldest first: the order used when appending loans. */
function compareLoansAsc_(a, b) {
  return cmp_(a.returned || '9999-99-99', b.returned || '9999-99-99') ||
    cmp_(a.checkedOut, b.checkedOut) ||
    cmpLoanId_(a.loanId, b.loanId);
}

/** Newest return first: the order used in the history view. */
function compareLoansDesc_(a, b) {
  return cmp_(b.returned || '9999-99-99', a.returned || '9999-99-99') ||
    cmp_(b.checkedOut, a.checkedOut) ||
    cmpLoanId_(a.loanId, b.loanId);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Returns a list of problems; an empty list means the payload is acceptable. */
function validatePayload_(p) {
  var errs = [];
  if (!p || typeof p !== 'object') return ['payload is not a JSON object'];
  if (p.schemaVersion !== SCHEMA_VERSION) errs.push('unsupported schemaVersion: ' + p.schemaVersion);
  if (p.source !== 'tpl') errs.push('unexpected source: ' + p.source);
  if (p.mode !== 'full' && p.mode !== 'recent') errs.push('unexpected mode: ' + p.mode);
  if (p.valid !== true) errs.push('payload is marked invalid by the extension');
  if (!Array.isArray(p.loans)) errs.push('loans is not an array');
  if (!Array.isArray(p.bibs)) errs.push('bibs is not an array');
  if (errs.length) return errs;

  var bibIds = {};
  p.bibs.forEach(function (b, i) {
    var id = str_(b && b.bibId);
    if (!id) errs.push('bib #' + i + ' has no bibId');
    else if (bibIds[id]) errs.push('duplicate bibId ' + id);
    else bibIds[id] = true;
  });

  var loanIds = {};
  p.loans.forEach(function (l, i) {
    l = l || {};
    var id = str_(l.loanId);
    var where = 'loan ' + (id || '#' + i);
    if (!id) errs.push(where + ': no loanId');
    else if (loanIds[id]) errs.push('duplicate loanId ' + id);
    else loanIds[id] = true;
    if (!bibIds[str_(l.bibId)]) errs.push(where + ': no matching bib');
    if (!DATE_RE.test(str_(l.checkedOut))) errs.push(where + ': bad checkedOut "' + str_(l.checkedOut) + '"');
    var r = str_(l.returned);
    if (r && !DATE_RE.test(r)) errs.push(where + ': bad returned "' + r + '"');
  });

  if (p.mode === 'full' && typeof p.count === 'number' && p.loans.length !== p.count) {
    errs.push('full mode: ' + p.loans.length + ' loans but count is ' + p.count);
  }
  return errs;
}

/* ------------------------------------------------------------------ */
/* Payload -> records                                                  */
/* ------------------------------------------------------------------ */

/** Loan records, oldest first. */
function prepareLoans_(loans) {
  return loans.map(function (l) {
    return {
      loanId: str_(l.loanId),
      bibId: str_(l.bibId),
      checkedOut: str_(l.checkedOut),
      returned: str_(l.returned)
    };
  }).sort(compareLoansAsc_);
}

function seriesLabel_(s) {
  var name = str_(s && s.name);
  // Display only: "1." -> "1". The raw volume is kept in bib_series.
  var vol = str_(s && s.volume).replace(/\.$/, '');
  return vol ? name + ' #' + vol : name;
}

function bibRecord_(b) {
  return {
    bibId: str_(b.bibId),
    title: str_(b.title),
    subtitle: str_(b.subtitle),
    authors: list_(b.authors),
    series: (Array.isArray(b.series) ? b.series : [])
      .filter(function (s) { return str_(s && s.name); })
      .map(seriesLabel_).join(LIST_SEP),
    format: str_(b.format),
    publicationDate: str_(b.publicationDate),
    language: str_(b.language),
    contentType: str_(b.contentType),
    callNumber: str_(b.callNumber),
    isbns: list_(b.isbns),
    subjects: list_(b.subjects),
    genres: list_(b.genres),
    audiences: list_(b.audiences)
  };
}

/**
 * Bib records in append order: by the first (oldest) loan that refers to them.
 * Bibs without loans (should not happen) go last, in payload order.
 */
function prepareBibs_(bibs, sortedLoans) {
  var byId = {};
  bibs.forEach(function (b) { byId[str_(b.bibId)] = b; });
  var seen = {};
  var out = [];
  sortedLoans.forEach(function (l) {
    if (!seen[l.bibId] && byId[l.bibId]) {
      seen[l.bibId] = true;
      out.push(byId[l.bibId]);
    }
  });
  bibs.forEach(function (b) {
    var id = str_(b.bibId);
    if (!seen[id]) { seen[id] = true; out.push(b); }
  });
  return out;
}

/** { bibId: [[bibId, position, author], ...] } for every bib in the payload. */
function authorRowsByBib_(bibs) {
  var out = {};
  bibs.forEach(function (b) {
    var id = str_(b.bibId);
    out[id] = (Array.isArray(b.authors) ? b.authors : []).map(str_).filter(Boolean)
      .map(function (a, i) { return [id, i + 1, a]; });
  });
  return out;
}

/** { bibId: [[bibId, position, series, volume], ...] } for every bib in the payload. */
function seriesRowsByBib_(bibs) {
  var out = {};
  bibs.forEach(function (b) {
    var id = str_(b.bibId);
    out[id] = (Array.isArray(b.series) ? b.series : [])
      .filter(function (s) { return str_(s && s.name); })
      .map(function (s, i) { return [id, i + 1, str_(s.name), str_(s.volume)]; });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Planning writes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Upsert plan for a keyed table (loans, bibs).
 * - Existing key, same data: nothing.
 * - Existing key, changed data: rewrite the managed cells of that row, set updatedAt.
 * - New key: append, set insertedAt (updatedAt stays empty).
 * Returns { updates: [{ index, row }], appends: [row], inserted, updated }.
 * "index" is the 0-based position in table.norm (sheet row = index + 2).
 */
function planUpsert_(layout, table, records, now) {
  var names = colNames_(layout);
  var keyCol = names.indexOf(layout.key);
  var insCol = names.indexOf('insertedAt');
  var dataCols = names.filter(function (n) {
    return n !== layout.key && n !== 'insertedAt' && n !== 'updatedAt';
  });

  var index = {};
  table.norm.forEach(function (r, i) {
    var k = r[keyCol];
    if (!k) return;
    if (index.hasOwnProperty(k)) {
      throw new Error('Sheet "' + layout.name + '" has duplicate ' + layout.key + ' ' + k +
        ' (rows ' + (index[k] + 2) + ' and ' + (i + 2) + ')');
    }
    index[k] = i;
  });

  var plan = { updates: [], appends: [], inserted: 0, updated: 0 };
  records.forEach(function (rec) {
    var k = rec[layout.key];
    if (index.hasOwnProperty(k)) {
      var i = index[k];
      var changed = dataCols.some(function (c) {
        return table.norm[i][names.indexOf(c)] !== rec[c];
      });
      if (!changed) return;
      plan.updates.push({
        index: i,
        row: names.map(function (c, j) {
          if (j === insCol) return table.raw[i][j];
          if (c === 'updatedAt') return now;
          return rec[c];
        })
      });
      plan.updated++;
    } else {
      plan.appends.push(names.map(function (c) {
        if (c === 'insertedAt') return now;
        if (c === 'updatedAt') return '';
        return rec[c];
      }));
      index[k] = -1;  // guards against a repeated key in the same batch
      plan.inserted++;
    }
  });
  return plan;
}

/**
 * Plan for a child table (bib_authors, bib_series), rewritten as a whole.
 * Existing groups keep their place; a group is replaced only if the incoming
 * list differs; groups of new bibs are appended in bibOrder.
 * Returns { rows, changedBibs }.
 */
function planChildren_(table, incomingByBib, bibOrder) {
  var groups = {};
  var order = [];
  table.norm.forEach(function (r) {
    var id = r[0];
    if (!id) return;
    if (!groups[id]) { groups[id] = []; order.push(id); }
    groups[id].push(r);
  });

  var changedBibs = 0;
  bibOrder.forEach(function (id) {
    var rows = incomingByBib[id] || [];
    if (groups[id]) {
      if (!sameRows_(groups[id], rows)) { groups[id] = rows; changedBibs++; }
    } else if (rows.length) {
      groups[id] = rows;
      order.push(id);
      changedBibs++;
    }
  });

  var out = [];
  order.forEach(function (id) {
    groups[id].forEach(function (r) { out.push(r); });
  });
  return { rows: out, changedBibs: changedBibs };
}

function sameRows_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (var j = 0; j < a[i].length; j++) {
      if (String(a[i][j]) !== String(b[i][j])) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* History view                                                        */
/* ------------------------------------------------------------------ */

/** 1 -> "A", 27 -> "AA". */
function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function rowToObject_(names, row) {
  var o = {};
  names.forEach(function (n, j) { o[n] = row[j]; });
  return o;
}

/**
 * Manual columns of a table, minus columns that have neither a header
 * nor any value. Header names are prefixed with the table name.
 */
function manualColumns_(table, prefix, firstCol) {
  var m = table.manual;
  var keep = [];
  if (m) {
    m.headers.forEach(function (h, j) {
      var hasValue = m.values.some(function (r) { return r[j] !== '' && r[j] !== null; });
      if (str_(h) || hasValue) keep.push(j);
    });
  }
  return {
    headers: keep.map(function (j) {
      return prefix + (str_(m.headers[j]) || 'col' + columnLetter_(firstCol + j));
    }),
    values: function (i) {
      return keep.map(function (j) { return i === undefined ? '' : m.values[i][j]; });
    },
    formats: function (i) {
      return keep.map(function (j) { return i === undefined ? 'General' : m.formats[i][j]; });
    }
  };
}

/**
 * One row per loan, newest return first, with the bib's attributes and
 * the user's manual columns from loans and bibs appended on the right.
 * Returns { header, rows, formats }.
 */
function buildHistory_(loansT, bibsT) {
  var L = colNames_(LAYOUT.loans);
  var B = colNames_(LAYOUT.bibs);
  var H = colNames_(LAYOUT.history);
  var hFmt = colFormats_(LAYOUT.history);

  var bibIndex = {};
  bibsT.norm.forEach(function (r, i) { if (r[0]) bibIndex[r[0]] = i; });

  var lm = manualColumns_(loansT, 'loans.', L.length + 1);
  var bm = manualColumns_(bibsT, 'bibs.', B.length + 1);

  var items = [];
  loansT.norm.forEach(function (r, i) {
    if (!r[0]) return;
    var loan = rowToObject_(L, r);
    var bi = bibIndex[loan.bibId];
    var bib = bi === undefined ? {} : rowToObject_(B, bibsT.norm[bi]);
    var row = H.map(function (c) {
      if (loan.hasOwnProperty(c)) return loan[c];
      return bib.hasOwnProperty(c) ? bib[c] : '';
    });
    items.push({
      loan: loan,
      row: row.concat(lm.values(i), bm.values(bi)),
      fmt: hFmt.concat(lm.formats(i), bm.formats(bi))
    });
  });

  items.sort(function (a, b) { return compareLoansDesc_(a.loan, b.loan); });
  return {
    header: H.concat(lm.headers, bm.headers),
    rows: items.map(function (it) { return it.row; }),
    formats: items.map(function (it) { return it.fmt; })
  };
}
