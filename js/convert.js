/*
 * Brace — convert.js
 *
 * JSON -> YAML is essentially lossless. YAML -> JSON is not, and we'd
 * rather say so plainly than let it happen quietly:
 *   - comments are dropped (JSON has no comment syntax)
 *   - anchors/aliases are expanded into repeated inline data
 *   - multiple '---' documents become one JSON array
 *   - duplicate keys resolve to their last value
 *   - YAML's .inf / .nan have no JSON equivalent and become null
 *     (this is just what JSON.stringify already does with Infinity/NaN —
 *     we're surfacing an existing JS behavior, not adding one)
 *   - YAML timestamps become ISO-8601 strings (JSON has no date type)
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  function countYAMLComments(text) {
    var count = 0;
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var inSingle = false, inDouble = false;
      for (var c = 0; c < line.length; c++) {
        var ch = line[c];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble) {
          // A '#' only starts a comment if it's at the start of the line
          // or preceded by whitespace (the YAML rule) — this avoids
          // false positives on things like "url: http://x/#frag".
          if (c === 0 || /\s/.test(line[c - 1])) {
            count++;
            break;
          }
        }
      }
    }
    return count;
  }

  function countAnchors(text) {
    var matches = text.match(/(^|[\s{,\[])&[A-Za-z0-9_-]+/g);
    return matches ? matches.length : 0;
  }

  // Recursively walks parsed data counting values that will change shape
  // under JSON.stringify: Dates -> ISO strings, Infinity/-Infinity/NaN -> null.
  function walkForLossyValues(value, counts, seen) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "number" && !isFinite(value)) counts.nonFiniteNumbers++;
      return;
    }
    if (value instanceof Date) {
      counts.dates++;
      return;
    }
    if (seen.has(value)) return; // guard against accidental cycles
    seen.add(value);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) walkForLossyValues(value[i], counts, seen);
    } else {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          walkForLossyValues(value[key], counts, seen);
        }
      }
    }
  }

  Brace.convert = {
    // Produces YAML text from parsed data. `isMultiDoc` data is an array
    // of documents, dumped as separate '---'-separated YAML documents
    // rather than as one YAML document containing a top-level array.
    toYAMLText: function (data, isMultiDoc) {
      var yaml = global.jsyaml;
      var opts = { lineWidth: -1, noRefs: true };
      if (isMultiDoc && Array.isArray(data)) {
        return data.map(function (doc) { return yaml.dump(doc, opts); }).join("---\n");
      }
      return yaml.dump(data, opts);
    },

    toJSONText: function (data) {
      return JSON.stringify(data, null, 2);
    },

    // Builds a plain-language list of what changed. `rawYamlText` and
    // `dupKeyIssues` are optional (pass what you have); missing inputs
    // just mean fewer notes, never an error.
    analyzeYamlToJson: function (rawYamlText, data, isMultiDoc, dupKeyIssues) {
      var notes = [];

      if (isMultiDoc && Array.isArray(data)) {
        notes.push(data.length + " YAML documents (separated by \"---\") were combined into one JSON array.");
      }

      if (rawYamlText) {
        var comments = countYAMLComments(rawYamlText);
        if (comments > 0) {
          notes.push(comments + " comment line" + (comments === 1 ? "" : "s") + " removed — JSON has no comment syntax.");
        }
        var anchors = countAnchors(rawYamlText);
        if (anchors > 0) {
          notes.push(anchors + " anchor" + (anchors === 1 ? "" : "s") + "/alias reference" + (anchors === 1 ? "" : "s") + " expanded into repeated inline data.");
        }
      }

      if (dupKeyIssues && dupKeyIssues.length > 0) {
        notes.push(dupKeyIssues.length + " duplicate key" + (dupKeyIssues.length === 1 ? "" : "s") + " resolved to its last value (see Issues panel).");
      }

      var counts = { dates: 0, nonFiniteNumbers: 0 };
      walkForLossyValues(data, counts, new Set());
      if (counts.dates > 0) {
        notes.push(counts.dates + " timestamp" + (counts.dates === 1 ? "" : "s") + " converted to ISO-8601 string" + (counts.dates === 1 ? "" : "s") + ".");
      }
      if (counts.nonFiniteNumbers > 0) {
        notes.push(counts.nonFiniteNumbers + " Infinity/NaN value" + (counts.nonFiniteNumbers === 1 ? "" : "s") + " became null — JSON has no representation for them.");
      }

      notes.push("Any non-string mapping keys were converted to strings, matching JSON's requirement.");

      return notes;
    },

    analyzeJsonToYaml: function () {
      return ["Nothing lossy here — JSON converts to YAML without any loss."];
    }
  };
})(window);
