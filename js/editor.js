/*
 * Brace — editor.js
 *
 * Thin wrapper around CodeMirror 5 (vendored locally, no CDN dependency —
 * see lib/codemirror/). Handles mode switching between JSON and YAML,
 * debounced change notification, and flagging a single error line when
 * the parser reports a syntax error.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  function Editor(textareaEl, onChange) {
    var self = this;
    this.errorLineHandle = null;
    this.errorLineNumber = null;

    this.cm = CodeMirror.fromTextArea(textareaEl, {
      mode: { name: "javascript", json: true },
      theme: "brace",
      lineNumbers: true,
      lineWrapping: false,
      matchBrackets: true,
      foldGutter: true,
      gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter", "brace-error-gutter"],
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      viewportMargin: 50
    });

    var debounceHandle = null;
    this.cm.on("change", function () {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(function () {
        if (onChange) onChange(self.cm.getValue());
      }, 200);
    });
  }

  Editor.prototype.getValue = function () { return this.cm.getValue(); };

  Editor.prototype.setValue = function (text) {
    var cursor = this.cm.getCursor();
    this.cm.setValue(text);
    try { this.cm.setCursor(cursor); } catch (e) { /* out of range after replace; ignore */ }
  };

  Editor.prototype.setMode = function (format) {
    this.cm.setOption("mode", format === "yaml" ? "yaml" : { name: "javascript", json: true });
  };

  Editor.prototype.refresh = function () {
    var self = this;
    setTimeout(function () { self.cm.refresh(); }, 0);
  };

  Editor.prototype.clearErrorLine = function () {
    if (this.errorLineNumber !== null) {
      this.cm.removeLineClass(this.errorLineNumber - 1, "background", "cm-error-line");
      this.errorLineNumber = null;
    }
  };

  Editor.prototype.markErrorLine = function (lineNumber) {
    this.clearErrorLine();
    if (typeof lineNumber === "number" && lineNumber > 0 && lineNumber <= this.cm.lineCount()) {
      this.cm.addLineClass(lineNumber - 1, "background", "cm-error-line");
      this.errorLineNumber = lineNumber;
    }
  };

  Editor.prototype.jumpToLine = function (lineNumber) {
    if (typeof lineNumber !== "number") return;
    var line = Math.max(0, lineNumber - 1);
    this.cm.scrollIntoView({ line: line, ch: 0 }, 80);
    this.cm.setCursor({ line: line, ch: 0 });
    this.cm.focus();
  };

  Brace.editor = {
    create: function (textareaEl, onChange) { return new Editor(textareaEl, onChange); }
  };
})(window);
