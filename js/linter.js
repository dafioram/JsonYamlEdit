/*
 * Brace — linter.js
 *
 * Duplicate-key detection and a couple of cheap, high-value structural
 * warnings for JSON and YAML source text.
 *
 * Design note: JSON.parse() silently keeps the *last* value when a key is
 * repeated (that's the JSON spec's own behavior), so we can't detect
 * duplicates from the parsed data — we have to scan the raw text ourselves.
 * For YAML we lean on js-yaml's own strict parser (which throws on the
 * first duplicate key it finds) and iteratively neutralize each duplicate
 * we find so the next pass can surface the next one. That's more reliable
 * than hand-rolling a YAML-aware indentation scanner.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  // ---- JSON duplicate-key scan --------------------------------------

  // Hand-rolled single-pass tokenizer. Only tracks enough state to tell
  // "am I looking at an object key" — it does not fully validate JSON
  // (that's JSON.parse's job). Wrapped by the caller in a try/catch so a
  // weird edge case here can never take down the rest of the app.
  function lintJSONDuplicates(text) {
    var issues = [];
    var stack = []; // { type: 'object'|'array', seenKeys: Set, path: string }
    var i = 0;
    var len = text.length;
    var line = 1;

    function currentPath() {
      if (!stack.length) return "root";
      return stack[stack.length - 1].path;
    }

    function skipString() {
      // assumes text[i] === '"'
      var start = i;
      i++;
      while (i < len) {
        var c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") line++;
        if (c === '"') {
          i++;
          return text.slice(start + 1, i - 1);
        }
        i++;
      }
      return text.slice(start + 1); // unterminated; best effort
    }

    try {
      while (i < len) {
        var ch = text[i];

        if (ch === "\n") {
          line++;
          i++;
          continue;
        }
        if (ch === " " || ch === "\t" || ch === "\r") {
          i++;
          continue;
        }

        if (ch === '"') {
          var strLine = line;
          var strVal = skipString();

          // Is this string a key? Peek past whitespace for ':' and make
          // sure we're directly inside an object (not an array of strings).
          var j = i;
          while (j < len && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) {
            j++;
          }
          var top = stack[stack.length - 1];
          if (text[j] === ":" && top && top.type === "object") {
            if (top.seenKeys.has(strVal)) {
              issues.push({
                severity: "warning",
                source: "json",
                message: 'Duplicate key "' + strVal + '" in object at ' + top.path + " — the last value silently wins.",
                line: strLine
              });
            } else {
              top.seenKeys.add(strVal);
            }
          }
          continue;
        }

        if (ch === "{") {
          stack.push({ type: "object", seenKeys: new Set(), path: currentPath() });
          i++;
          continue;
        }
        if (ch === "[") {
          stack.push({ type: "array", path: currentPath() + "[]" });
          i++;
          continue;
        }
        if (ch === "}" || ch === "]") {
          stack.pop();
          i++;
          continue;
        }

        i++;
      }
    } catch (e) {
      // Best-effort linting only; never let this break the app.
    }

    return issues;
  }

  // ---- YAML duplicate-key scan ---------------------------------------

  // Reuses js-yaml's own strict-mode parser (throws on the first duplicate
  // mapping key) and repeatedly renames the offending key to a unique
  // placeholder so the next duplicate further down can surface too.
  function lintYAMLDuplicates(text) {
    var issues = [];
    var working = text;
    var yaml = global.jsyaml;
    if (!yaml) return issues;

    var MAX_PASSES = 50;
    for (var pass = 0; pass < MAX_PASSES; pass++) {
      try {
        yaml.load(working);
        break; // no (more) duplicate keys
      } catch (e) {
        var isDup = e && e.name === "YAMLException" && /duplicated mapping key/i.test(e.reason || e.message || "");
        if (!isDup) break; // a genuine syntax error — the parser step will report it

        var mark = e.mark;
        if (!mark || typeof mark.line !== "number") break; // can't localize; avoid infinite loop

        issues.push({
          severity: "warning",
          source: "yaml",
          message: "Duplicate key on line " + (mark.line + 1) + " — the last value silently wins.",
          line: mark.line + 1
        });

        var lines = working.split("\n");
        var idx = mark.line;
        if (idx < 0 || idx >= lines.length) break;
        var replaced = lines[idx].replace(/^(\s*)([^\s:#][^:#]*?)(\s*:)/, function (m, indent, key, colon) {
          return indent + "__brace_dup_" + pass + "__" + colon;
        });
        if (replaced === lines[idx]) break; // couldn't neutralize; avoid infinite loop
        lines[idx] = replaced;
        working = lines.join("\n");
      }
    }

    return issues;
  }

  // ---- Cheap structural warnings -------------------------------------

  function lintYAMLTabs(text) {
    var issues = [];
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (/^\t+/.test(lines[i])) {
        issues.push({
          severity: "error",
          source: "yaml",
          message: "Line " + (i + 1) + " is indented with a tab — YAML indentation must use spaces.",
          line: i + 1
        });
      }
    }
    return issues;
  }

  // ---- Public API ------------------------------------------------------

  Brace.linter = {
    lintJSON: function (text) {
      return lintJSONDuplicates(text);
    },
    lintYAML: function (text) {
      return lintYAMLDuplicates(text).concat(lintYAMLTabs(text));
    }
  };
})(window);
