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

  var DELIMITER_CANDIDATES = [",", ";", "\t"];
  var DELIMITER_LABELS = { ",": "comma", ";": "semicolon", "\t": "tab" };

  function countUnquoted(line, delimiter) {
    var count = 0;
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === delimiter && !inQuotes) count++;
    }
    return count;
  }

  function detectDelimiter(text) {
    var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l.trim() !== ""; }).slice(0, 20);
    if (lines.length === 0) return ",";

    var best = ",", bestScore = -Infinity;
    DELIMITER_CANDIDATES.forEach(function (delim) {
      var counts = lines.map(function (l) { return countUnquoted(l, delim); });
      var present = counts.filter(function (c) { return c > 0; });
      if (present.length === 0) return;
      var avg = present.reduce(function (a, b) { return a + b; }, 0) / present.length;
      var variance = present.reduce(function (a, b) { return a + Math.pow(b - avg, 2); }, 0) / present.length;
      var consistency = present.length / lines.length; // fraction of lines that contain it at all
      var score = avg * consistency - variance;
      if (score > bestScore) { bestScore = score; best = delim; }
    });
    return best;
  }

  // Character-level parser: handles quoted fields, embedded delimiters,
  // embedded newlines inside quotes, and doubled-quote escaping ("" -> ").
  function parseRows(text, delimiter) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM (common from Excel exports)

    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delimiter) { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

    // Drop fully-blank lines (a common trailing-newline artifact).
    return rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ""); });
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
    var s = raw.trim();
    if (s === "") return null;
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (isNumericToken(s)) return Number(s);
    return raw;
  }

  // Renames duplicate/blank column names so no column's data is silently
  // dropped — "name", "name" -> "name", "name_2"; blank -> "column_N".
  function resolveColumnNames(rawNames) {
    var used = Object.create(null);
    var notes = [];
    var result = rawNames.map(function (name, index) {
      var base = (name || "").trim() || ("column_" + (index + 1));
      if (!used[base]) { used[base] = 1; return base; }
      var n = 2;
      var candidate = base + "_" + n;
      while (used[candidate]) { n++; candidate = base + "_" + n; }
      used[candidate] = 1;
      notes.push('Duplicate column "' + base + '" renamed to "' + candidate + '" so its data wasn\'t overwritten.');
      return candidate;
    });
    return { names: result, notes: notes };
  }

  function parse(text) {
    var delimiter = detectDelimiter(text);
    var rows = parseRows(text, delimiter);

    if (rows.length === 0) {
      return { data: [], hadHeader: false, columns: [], delimiter: delimiter, rowCount: 0, columnNotes: [] };
    }

    var hadHeader = looksLikeHeader(rows);
    var dataRows = hadHeader ? rows.slice(1) : rows;
    var columnCount = rows.reduce(function (max, r) { return Math.max(max, r.length); }, 0);

    var rawNames = [];
    for (var c = 0; c < columnCount; c++) {
      rawNames.push(hadHeader ? rows[0][c] : null);
    }
    var resolved = resolveColumnNames(rawNames);

    var data = dataRows.map(function (r) {
      var obj = {};
      for (var i = 0; i < resolved.names.length; i++) {
        obj[resolved.names[i]] = i < r.length ? inferValue(r[i]) : null;
      }
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
    var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l.trim() !== ""; });
    if (lines.length < 2) return false;
    var delimiter = detectDelimiter(text);
    var counts = lines.slice(0, 20).map(function (l) { return countUnquoted(l, delimiter); });
    var consistent = counts.filter(function (c) { return c === counts[0]; }).length;
    return counts[0] >= 1 && (consistent / counts.length) >= 0.8;
  }

  Brace.csv = {
    parse: parse,
    looksTabular: looksTabular,
    DELIMITER_LABELS: DELIMITER_LABELS
  };
})(window);
