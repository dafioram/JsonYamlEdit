/*
 * Brace — csv.js
 *
 * Converts CSV/TSV text into an array of objects (or, headerless, an array
 * of objects with generic column_N keys) so it can flow through the exact
 * same JSON pipeline as everything else in the app — tree view, table
 * view, linting, and conversion all just work on the result for free.
 *
 * Design choices, spelled out because they're all judgment calls:
 *   - Delimiter is auto-detected (comma / semicolon / tab) by consistency
 *     across lines, not just "does it contain a comma."
 *   - Header presence is guessed with a simplified version of the classic
 *     CSV-sniffing heuristic: a header row typically has far fewer
 *     numeric-looking cells than the data rows below it.
 *   - Numbers are only coerced when the conversion round-trips exactly
 *     (String(Number(x)) === x). This is what keeps "00501" (a zip code)
 *     as the string "00501" instead of silently becoming 501.
 *   - Duplicate column names are auto-renamed (name, name_2, name_3, ...)
 *     rather than silently overwritten, since — unlike a hand-written JSON
 *     duplicate key — there's no later "raw text" for the linter to catch
 *     this in once it's been folded into an object.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  var MAX_IMPORT_CELLS = 100000;
  var DELIMITER_CANDIDATES = [",", ";", "\t"];
  var DELIMITER_LABELS = { ",": "comma", ";": "semicolon", "\t": "tab" };

  // Read complete records, including quoted line breaks. The optional row
  // limit lets delimiter detection sample without parsing the entire file.
  function read(text, delimiter, limit) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    var closedQuote = false;
    var recordStarted = false;
    var line = 1;
    var cells = 0;

    function finishField() {
      if (++cells > MAX_IMPORT_CELLS * 2) throw new Error("Too many CSV fields to import.");
      row.push(field);
      field = "";
      closedQuote = false;
    }

    function finishRecord() {
      if (recordStarted) {
        finishField();
        rows.push(row);
        if (rows.length > MAX_IMPORT_CELLS + 1) throw new Error("Too many CSV records to import.");
      }
      row = [];
      recordStarted = false;
    }

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
          closedQuote = true;
        } else {
          field += c;
          if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
        }
      } else if (c === delimiter) {
        recordStarted = true;
        finishField();
      } else if (c === "\r" || c === "\n") {
        finishRecord();
        if (rows.length === limit) return rows;
        if (c === "\r" && text[i + 1] === "\n") i++;
        line++;
      } else if (closedQuote || (c === '"' && field !== "")) {
        throw new Error("Unexpected character near a quote on line " + line + ".");
      } else if (c === '"') {
        recordStarted = true;
        quoted = true;
      } else {
        recordStarted = true;
        field += c;
      }
    }
    if (quoted) throw new Error("Unclosed quoted field at the end of line " + line + ".");
    finishRecord();
    return rows;
  }

  function detectDelimiter(text) {
    var best = ",", bestScore = -Infinity;
    DELIMITER_CANDIDATES.forEach(function (delimiter) {
      var rows;
      try {
        rows = read(text, delimiter, 20);
      } catch (err) {
        return;
      }
      if (!rows.length) return;
      var counts = rows.map(function (r) { return r.length - 1; });
      var present = counts.filter(function (count) { return count > 0; });
      if (!present.length) return;
      var average = present.reduce(function (sum, count) { return sum + count; }, 0) / present.length;
      var variance = present.reduce(function (sum, count) { return sum + Math.pow(count - average, 2); }, 0) / present.length;
      var score = average * present.length / rows.length - variance;
      if (score > bestScore) { bestScore = score; best = delimiter; }
    });
    return best;
  }

  // Round-trip-safe: "00501" and "1e3" stay strings; "42" and "-3.5" become numbers.
  function isNumericToken(s) {
    var t = s.trim();
    if (t === "") return false;
    var n = Number(t);
    return !isNaN(n) && isFinite(n) && String(n) === t;
  }

  function cellType(s) {
    var t = (s || "").trim();
    if (t === "") return "empty";
    if (/^(true|false)$/i.test(t)) return "bool";
    if (isNumericToken(t)) return "numeric";
    return "string";
  }

  // Per-column dominant-type comparison rather than a single overall
  // numeric-count average: for each column, look at what type the DATA
  // rows mostly are; if that's numeric/boolean but row 0's cell in that
  // column is a plain string, that's a strong signal row 0 is a header,
  // not another data row. (Columns that are string-typed all the way down
  // give no usable signal either way — a known, accepted limitation of
  // type-based sniffing, same as most real CSV sniffers.)
  function looksLikeHeader(rows) {
    if (rows.length < 2) return false;
    var header = rows[0];
    var dataRows = rows.slice(1, Math.min(rows.length, 21));
    var informativeColumns = 0;
    var mismatches = 0;

    for (var c = 0; c < header.length; c++) {
      var dataTypes = dataRows
        .map(function (r) { return cellType(r[c]); })
        .filter(function (t) { return t !== "empty"; });
      if (dataTypes.length === 0) continue;

      var counts = {};
      dataTypes.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      var dominant = Object.keys(counts).reduce(function (a, b) { return counts[a] >= counts[b] ? a : b; });
      if (dominant !== "numeric" && dominant !== "bool") continue; // no signal from an all-string column

      informativeColumns++;
      if (cellType(header[c]) === "string") mismatches++;
    }

    if (informativeColumns === 0) return false;
    return mismatches >= Math.ceil(informativeColumns / 2);
  }

  function inferValue(raw) {
    if (raw === "") return null;
    var s = raw;
    if (s !== s.trim()) return s;
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (isNumericToken(s)) return Number(s);
    return raw;
  }

  // Renames duplicate/blank column names so no column's data is silently
  // dropped — "name", "name" -> "name", "name_2"; blank -> "column_N".
  function resolveColumnNames(rawNames) {
    var used = new Set();
    var nextSuffix = new Map();
    var notes = [];
    var result = rawNames.map(function (name, index) {
      var base = (name || "").trim() || ("column_" + (index + 1));
      if (!used.has(base)) { used.add(base); return base; }
      var n = nextSuffix.get(base) || 2;
      var candidate = base + "_" + n;
      while (used.has(candidate)) { n++; candidate = base + "_" + n; }
      nextSuffix.set(base, n + 1);
      used.add(candidate);
      notes.push('Duplicate column "' + base + '" renamed to "' + candidate + '" so its data wasn\'t overwritten.');
      return candidate;
    });
    return { names: result, notes: notes };
  }

  function toObjects(rows, delimiter, headerMode, inferTypes, outputLimit) {
    if (rows.length === 0) throw new Error("That file has no CSV records.");
    var hadHeader = headerMode === "yes" || (headerMode === "auto" && looksLikeHeader(rows));
    var dataRows = hadHeader ? rows.slice(1) : rows;
    var columnCount = rows.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
    if (columnCount > MAX_IMPORT_CELLS || dataRows.length * columnCount > MAX_IMPORT_CELLS) {
      throw new Error("This import would expand to more than 100,000 cells.");
    }

    var rawNames = [];
    for (var c = 0; c < columnCount; c++) rawNames.push(hadHeader ? rows[0][c] : null);
    var resolved = resolveColumnNames(rawNames);
    // Even a few fields can produce excessive output if a long column name
    // is repeated in every JSON object. Bound that expansion before allocation.
    var keyLength = resolved.names.reduce(function (sum, name) { return sum + JSON.stringify(name).length; }, 0);
    if (dataRows.length * keyLength > outputLimit) {
      throw new Error("The imported JSON would exceed the 5 MB editor limit.");
    }
    var data = dataRows.map(function (row) {
      var obj = Object.create(null);
      resolved.names.forEach(function (name, index) {
        var value = row[index];
        obj[name] = value === undefined ? null : inferTypes ? inferValue(value) : value;
      });
      return obj;
    });

    return {
      data: data,
      hadHeader: hadHeader,
      columns: resolved.names,
      delimiter: delimiter,
      rowCount: data.length,
      columnNotes: resolved.notes
    };
  }

  // Narrow heuristic used only as a fallback when YAML would otherwise
  // swallow CSV text as one degenerate folded string (js-yaml treats
  // multi-line unindented plain text as a single scalar, joining lines
  // with spaces, rather than raising an error) — so this only needs to
  // catch text that's clearly column-shaped, not identify CSV in general.
  function looksTabular(text) {
    var delimiter = detectDelimiter(text);
    try {
      var rows = read(text, delimiter, 20);
      if (rows.length < 2 || rows[0].length < 2) return false;
      var consistent = rows.filter(function (row) { return row.length === rows[0].length; }).length;
      return consistent / rows.length >= 0.8;
    } catch (err) {
      return false;
    }
  }

  Brace.csv = {
    read: read,
    detectDelimiter: detectDelimiter,
    looksLikeHeader: looksLikeHeader,
    toObjects: toObjects,
    looksTabular: looksTabular,
    DELIMITER_LABELS: DELIMITER_LABELS
  };
})(window);
