/*
 * Brace — convert.js
 *
 * Conversion previews surface known changes before replacing the source:
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
    if (value instanceof Uint8Array) {
      counts.binary++;
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

    analyzeYamlToJson: function (data, isMultiDoc, dupKeyIssues) {
      var notes = ["JSON output omits YAML comments and tag syntax and expands aliases into inline values."];

      if (isMultiDoc && Array.isArray(data)) {
        notes.push(data.length + " YAML documents (separated by \"---\") were combined into one JSON array.");
      }

      if (dupKeyIssues && dupKeyIssues.length > 0) {
        notes.push(dupKeyIssues.length + " duplicate key" + (dupKeyIssues.length === 1 ? "" : "s") + " resolved to its last value (see Issues panel).");
      }

      var counts = { dates: 0, nonFiniteNumbers: 0, binary: 0 };
      walkForLossyValues(data, counts, new Set());
      if (counts.dates > 0) {
        notes.push(counts.dates + " timestamp" + (counts.dates === 1 ? "" : "s") + " converted to ISO-8601 string" + (counts.dates === 1 ? "" : "s") + ".");
      }
      if (counts.nonFiniteNumbers > 0) {
        notes.push(counts.nonFiniteNumbers + " Infinity/NaN value" + (counts.nonFiniteNumbers === 1 ? "" : "s") + " became null — JSON has no representation for them.");
      }

      if (counts.binary > 0) {
        notes.push("YAML binary values become JSON objects with numbered byte properties.");
      }
      notes.push("JSON uses string keys and JavaScript numbers. Review the output if your YAML contains non-string keys or high-precision numbers.");

      return notes;
    },

    analyzeJsonToYaml: function (issues) {
      if (issues.some(function (issue) { return issue.code === "numeric-precision"; })) {
        throw new Error("This JSON contains numbers that would change value. See Issues for the affected lines.");
      }
      var notes = ["Review the generated YAML before replacing your JSON."];
      if (issues.some(function (issue) { return issue.code === "duplicate-key"; })) {
        notes.push("Duplicate keys collapse to their last value.");
      }
      return notes;
    }
  };
})(window);
