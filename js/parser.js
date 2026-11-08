/*
 * Brace — parser.js
 *
 * Auto-detects JSON vs YAML, parses permissively (duplicate keys are
 * tolerated here — the linter is what surfaces them as warnings), and
 * normalizes multi-document YAML into a single array with a flag so the
 * rest of the app can treat "one document" and "many documents" uniformly.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  function parseJSON(text) {
    var data = JSON.parse(text); // throws with a native, fairly clear message
    return { format: "json", data: data, isMultiDoc: false };
  }

  function parseYAML(text) {
    var docs = global.jsyaml.loadAll(text, null, { json: true });
    var isMultiDoc = docs.length > 1;
    var data = isMultiDoc ? docs : docs.length ? docs[0] : null;
    return { format: "yaml", data: data, isMultiDoc: isMultiDoc };
  }

  // Turns a caught error into a normalized shape the UI can render:
  // { message, line, column }. Handles both native JSON SyntaxError
  // (no structured position — we regex it out of the message when present)
  // and js-yaml's YAMLException (structured .mark).
  function normalizeError(err, sourceFormat) {
    var line = null, column = null;

    if (err && err.mark && typeof err.mark.line === "number") {
      // js-yaml's YAMLException
      line = err.mark.line + 1;
      column = typeof err.mark.column === "number" ? err.mark.column + 1 : null;
    } else if (err && typeof err.message === "string") {
      // Modern V8 JSON.parse errors sometimes include "(line X column Y)".
      // When they don't (e.g. "Unexpected end of JSON input"), we simply
      // have no position to report — better to omit it than guess.
      var m = err.message.match(/line (\d+) column (\d+)/i);
      if (m) {
        line = parseInt(m[1], 10);
        column = parseInt(m[2], 10);
      }
    }

    return {
      message: (err && err.message) ? err.message.split("\n")[0] : String(err),
      line: line,
      column: column,
      format: sourceFormat
    };
  }

  Brace.parser = {
    normalizeError: normalizeError,
    MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB — see README for rationale

    // Tries JSON first (strict, fast, unambiguous), then falls back to YAML
    // (a syntactic superset of JSON, so this order never misclassifies a
    // real JSON file as something else).
    detectAndParse: function (text) {
      if (text.trim() === "") {
        return { format: null, data: null, isMultiDoc: false, error: null, empty: true };
      }

      try {
        var jsonResult = parseJSON(text);
        return {
          format: jsonResult.format,
          data: jsonResult.data,
          isMultiDoc: jsonResult.isMultiDoc,
          error: null,
          empty: false
        };
      } catch (jsonErr) {
        try {
          var yamlResult = parseYAML(text);
          return {
            format: yamlResult.format,
            data: yamlResult.data,
            isMultiDoc: yamlResult.isMultiDoc,
            error: null,
            empty: false
          };
        } catch (yamlErr) {
          // Neither parser accepted it. YAML's error is usually the more
          // informative one here since it's a superset grammar.
          return {
            format: null,
            data: null,
            isMultiDoc: false,
            error: normalizeError(yamlErr, "yaml"),
            empty: false
          };
        }
      }
    },

    // Re-parses text that's already known to be a specific format (used
    // after the user explicitly picks a mode, e.g. via the format badge).
    parseAs: function (text, format) {
      if (format === "json") return parseJSON(text);
      if (format === "yaml") return parseYAML(text);
      throw new Error("Unknown format: " + format);
    },

    lint: function (text, format) {
      if (format === "json") return global.Brace.linter.lintJSON(text);
      if (format === "yaml") return global.Brace.linter.lintYAML(text);
      return [];
    }
  };
})(window);
