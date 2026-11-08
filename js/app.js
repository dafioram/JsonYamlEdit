/*
 * Brace — app.js
 *
 * Wires together parser/linter/convert/tree-view/table-view/editor into
 * the actual application. Everything runs client-side; nothing here makes
 * a network request.
 */
(function () {
  "use strict";

  var MAX_FILE_SIZE_BYTES = window.Brace.parser.MAX_FILE_SIZE_BYTES;
  var MAX_FILE_SIZE_LABEL = "5 MB";

  var state = {
    rawText: "",
    savedText: "",
    savedFormat: null,
    format: null,
    data: null,
    isMultiDoc: false,
    lintIssues: [],
    parseError: null,
    currentView: "tree",
    tableScope: null, // { segments, pathStr } | null
    fileName: null,
    hasLoadedOnce: false
  };

  var el = {}; // populated in init() from data-id attributes
  var editor = null;
  var tableView = null;
  var treeView = null;
  var deferredInstallPrompt = null;
  var pendingTransform = null;
  var undoTransform = null;
  var loadRequest = 0;

  function qs(id) { return document.getElementById(id); }

  function bytesOf(text) {
    return new Blob([text]).size;
  }

  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  // ---- Loading pipeline ------------------------------------------------

  function showSizeError(sizeBytes) {
    reportLoadProblem(
      "That's " + humanBytes(sizeBytes) + " — Brace parses everything in your browser, " +
      "so files are capped at " + MAX_FILE_SIZE_LABEL + " for now."
    );
  }

  // Load failures can happen either on the empty-state screen (first
  // load) or later via "Open file" once a file is already showing — those
  // two cases need to render into different places, since the empty
  // state's own banner is permanently hidden once the app shell is up.
  function reportLoadProblem(message) {
    if (state.hasLoadedOnce) {
      el.appError.textContent = message;
      el.appError.hidden = false;
    } else {
      el.emptyError.textContent = message;
      el.emptyError.hidden = false;
    }
  }

  function clearLoadProblem() {
    el.emptyError.hidden = true;
    el.emptyError.textContent = "";
    el.appError.hidden = true;
    el.appError.textContent = "";
  }

  // The display name always reflects the CURRENT format, not whatever
  // extension the original upload happened to have — otherwise the tree
  // root label (and, without this, the download filename too) keeps
  // showing "data.yaml" after converting to JSON.
  function currentBaseName() {
    return state.fileName ? state.fileName.replace(/\.[^.]+$/, "") : null;
  }

  function currentDisplayName() {
    var base = currentBaseName();
    if (!base) return null;
    return base + "." + (state.format === "yaml" ? "yaml" : "json");
  }

  function formatForName(fileName) {
    if (/\.json$/i.test(fileName || "")) return "json";
    if (/\.ya?ml$/i.test(fileName || "")) return "yaml";
    return null;
  }

  function parseDocument(text, format) {
    try {
      var result = window.Brace.parser.parseAs(text, format);
      result.error = null;
      return result;
    } catch (err) {
      return { format: format, data: null, isMultiDoc: false, error: window.Brace.parser.normalizeError(err, format) };
    }
  }

  function loadNew(text, fileName, requestedFormat) {
    var sizeBytes = bytesOf(text);
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      showSizeError(sizeBytes);
      return false;
    }
    clearLoadProblem();

    var format = requestedFormat || formatForName(fileName);
    var result = format ? parseDocument(text, format) : window.Brace.parser.detectAndParse(text);
    if (!format && (result.error || (result.format === "yaml" && typeof result.data === "string")) &&
        window.Brace.csv.looksTabular(text)) {
      return importCSVText(text, fileName);
    }
    if (!result.format) {
      var fallback = /^\s*[[{]/.test(text) ? "json" : "yaml";
      result = parseDocument(text, fallback);
    }

    setUndoTransform(null);
    state.fileName = fileName || null;
    state.tableScope = null;
    state.savedText = text.replace(/\r\n?|\n/g, "\n");
    state.savedFormat = result.format;
    state.hasLoadedOnce = true;
    el.tableFilterInput.value = "";
    el.issuesPanel.hidden = true;
    renderConversionNotes([]);

    enterShell();
    if (result.error || requestedFormat && !fileName) setView("raw");
    replaceDocument(text, result);
    return true;
  }

  // CSV isn't really its own format in this app — it's just another way
  // to produce an initial JSON document. Once converted, it flows through
  // the exact same loadNew() pipeline as everything else (tree, table,
  // linting, and further JSON<->YAML conversion all just work on it).
  function importCSVText(text, fileName) {
    var result;
    try {
      result = window.Brace.csv.parse(text);
    } catch (e) {
      reportLoadProblem("Couldn't parse that as CSV: " + e.message);
      return;
    }
    if (result.data.length === 0) {
      reportLoadProblem("That CSV file looks empty.");
      return;
    }

    var jsonText = JSON.stringify(result.data, null, 2);
    var derivedName = fileName ? fileName.replace(/\.[^.]+$/, "") + ".json" : null;
    if (!loadNew(jsonText, derivedName, "json")) return false;

    var delimiterLabel = window.Brace.csv.DELIMITER_LABELS[result.delimiter] || ("\"" + result.delimiter + "\"");
    var notes = [
      "Imported " + result.rowCount + " row" + (result.rowCount === 1 ? "" : "s") +
        " from CSV, using " + delimiterLabel + " as the delimiter.",
      result.hadHeader
        ? "The first row was detected as a header and used for column names."
        : "No header row was detected, so columns were named column_1, column_2, and so on. " +
          "If that's wrong, edit the raw JSON directly to rename them."
    ].concat(result.columnNotes);
    renderConversionNotes(notes, "Import notes");
    return true;
  }

  // Re-parse an edit to already-loaded content, strictly as the current
  // format (no re-detection — we don't want editing to silently flip
  // formats on the user).
  function reparseCurrent(text) {
    if (undoTransform && text !== state.rawText) setUndoTransform(null);
    state.rawText = text;
    var result = parseDocument(text, state.format);
    state.data = result.data;
    state.isMultiDoc = result.isMultiDoc;
    state.parseError = result.error;
    editor.markErrorLine(result.error && result.error.line);
    runLintAndRender();
  }

  function runLintAndRender() {
    state.lintIssues = state.parseError ? [] : window.Brace.parser.lint(state.rawText, state.format);
    renderStatusLine();
    renderIssuesPanel();
    renderFormatBadge();
    el.convertBtn.disabled = el.formatBtn.disabled = !!state.parseError;

    el.treeSearchInput.disabled = el.treeExpandAllBtn.disabled = el.treeCollapseAllBtn.disabled = !!state.parseError;
    if (state.parseError) {
      renderTreeOrTableUnavailable("There's a syntax error in the raw text — fix it to see the tree and table views again.");
      return;
    }

    // Table is a persistent pane (not a tab), so it must stay in sync on
    // every load/edit/convert regardless of which of Raw/Tree is active —
    // otherwise it goes stale the moment it's not the focused tab.
    renderTable();
    if (state.currentView === "tree") renderTree();
  }

  // ---- View rendering ---------------------------------------------------

  function enterShell() {
    el.emptyState.hidden = true;
    el.appShell.hidden = false;
    el.formatBadge.hidden = false;
    el.convertBtn.hidden = false;
    el.downloadBtn.hidden = false;
  }

  function renderStatusLine() {
    if (state.parseError) {
      el.statusLine.textContent = "Syntax error" + (state.parseError.line ? " on line " + state.parseError.line : "");
      el.statusLine.className = "status-line status-error";
      return;
    }
    var n = state.lintIssues.length;
    el.statusLine.textContent = n === 0 ? "Valid" : (n + " issue" + (n === 1 ? "" : "s"));
    el.statusLine.className = "status-line" + (n === 0 ? " status-ok" : " status-warn");
  }

  function renderFormatBadge() {
    var label = state.format ? state.format.toUpperCase() : "";
    if (state.format === "yaml" && state.isMultiDoc && Array.isArray(state.data)) {
      label += " \u00B7 " + state.data.length + " documents";
    }
    el.formatBadge.textContent = label;
    el.formatSelect.value = state.format;
    el.formatBadge.className = "format-badge format-badge-" + state.format;
    el.convertBtn.textContent = state.format === "yaml" ? "Convert to JSON" : "Convert to YAML";
    el.downloadBtn.textContent = "Download ." + (state.format === "yaml" ? "yaml" : "json");
  }

  function renderIssuesPanel() {
    el.issuesList.innerHTML = "";
    var issues = state.parseError ? [{ severity: "error", message: state.parseError.message, line: state.parseError.line }] : state.lintIssues;
    el.issuesToggle.textContent = "Issues" + (issues.length ? " (" + issues.length + ")" : "");
    el.issuesToggle.classList.toggle("has-issues", issues.length > 0);

    if (issues.length === 0) {
      var none = document.createElement("li");
      none.className = "issue-none";
      none.textContent = "No issues found.";
      el.issuesList.appendChild(none);
      return;
    }
    issues.forEach(function (issue) {
      var li = document.createElement("li");
      li.className = "issue issue-" + issue.severity;
      var icon = document.createElement("span");
      icon.className = "issue-icon";
      icon.textContent = issue.severity === "error" ? "\u2715" : "\u26A0";
      li.appendChild(icon);
      var msg = document.createElement("span");
      msg.className = "issue-message";
      msg.textContent = issue.message;
      li.appendChild(msg);
      if (issue.line) {
        var jump = document.createElement("button");
        jump.type = "button";
        jump.className = "issue-jump";
        jump.textContent = "Line " + issue.line;
        jump.addEventListener("click", function () {
          setView("raw");
          editor.jumpToLine(issue.line);
        });
        li.appendChild(jump);
      }
      el.issuesList.appendChild(li);
    });
  }

  function renderConversionNotes(notes, title) {
    el.notesTitle.textContent = title || "Conversion notes";
    el.notesList.innerHTML = "";
    if (!notes || notes.length === 0) {
      el.notesPanel.hidden = true;
      return;
    }
    notes.forEach(function (note) {
      var li = document.createElement("li");
      li.textContent = note;
      el.notesList.appendChild(li);
    });
    el.notesPanel.hidden = false;
    el.issuesPanel.hidden = false; // surface it immediately rather than making them find the toggle
  }

  function renderTreeOrTableUnavailable(message) {
    treeView = null;
    el.treeContainer.innerHTML = "";
    var p1 = document.createElement("div");
    p1.className = "tree-empty-note";
    p1.textContent = message;
    el.treeContainer.appendChild(p1);

    clearTableView();
    var p2 = document.createElement("div");
    p2.className = "table-empty-note";
    p2.textContent = message;
    el.tableContainer.appendChild(p2);
  }

  function renderTree() {
    treeView = window.Brace.treeView.create(el.treeContainer, {
      onUseAsTable: function (segments, pathStr) {
        state.tableScope = { segments: segments, pathStr: pathStr };
        renderTable();
        setTableCollapsed(false); // Table is always visible — make sure the user actually sees the result
      }
    });
    treeView.render(state.data, currentDisplayName() || "root");
    el.treeSearchInput.value = "";
  }

  function clearTableView() {
    if (tableView) tableView.closePopover();
    tableView = null;
    el.tableContainer.replaceChildren();
    el.tableToolbar.hidden = true;
  }

  function renderTable() {
    clearTableView();
    var scopedData = state.data;
    var scopeLabel = "root";
    if (state.tableScope) {
      var resolved = window.Brace.treeView.resolvePath(state.data, state.tableScope.segments);
      if (!window.Brace.tableView.isCandidate(resolved)) {
        state.tableScope = null; // path no longer valid (e.g. after an edit) — fall back to root
      } else {
        scopedData = resolved;
        scopeLabel = state.tableScope.pathStr;
      }
    }

    el.tableScopeLabel.textContent = scopeLabel;
    el.tableScopeReset.hidden = !state.tableScope;

    if (!window.Brace.tableView.isCandidate(scopedData)) {
      var note = document.createElement("div");
      note.className = "table-empty-note";
      note.textContent = window.Brace.treeView.typeOf(scopedData) === "array"
        ? "This array mixes objects with other value types, so it can't be shown as a table. Try the Tree view instead."
        : "Pick \u25A6 Table next to an array of objects in the Tree view to inspect it here.";
      el.tableContainer.appendChild(note);
      return;
    }

    el.tableToolbar.hidden = false;
    tableView = window.Brace.tableView.create(el.tableContainer, el.tablePopoverHost);
    tableView.setData(scopedData);
    if (el.tableFilterInput.value) tableView.setFilter(el.tableFilterInput.value);
  }

  function setTableCollapsed(collapsed) {
    el.viewtable.classList.toggle("collapsed", collapsed);
    el.tableCollapseBtn.textContent = collapsed ? "\u25B8" : "\u25BE";
    el.tableCollapseBtn.title = collapsed ? "Expand table" : "Collapse table";
  }

  function setView(view) {
    state.currentView = view;
    ["raw", "tree"].forEach(function (v) {
      el["tab" + v].classList.toggle("active", v === view);
      el["view" + v].hidden = v !== view;
    });
    if (view === "raw") editor.refresh();
    else if (!state.parseError && state.hasLoadedOnce) renderTree();
  }

  // ---- Editor sync -------------------------------------------------------

  function syncEditorFromState() {
    editor.setMode(state.format);
    editor.setValue(state.rawText);
    editor.clearErrorLine();
    editor.refresh();
  }

  // ---- File loading sources ----------------------------------------------

  function handleFile(file) {
    var request = ++loadRequest;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      showSizeError(file.size);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      if (request !== loadRequest) return;
      var text = String(reader.result);
      if (/\.(csv|tsv)$/i.test(file.name)) importCSVText(text, file.name);
      else loadNew(text, file.name);
    };
    reader.onerror = function () {
      if (request === loadRequest) reportLoadProblem("Couldn't read that file.");
    };
    reader.readAsText(file);
  }

  function isEmptyStateVisible() { return !el.emptyState.hidden; }

  function wireDropZone() {
    ["dragenter", "dragover"].forEach(function (evt) {
      el.dropZone.addEventListener(evt, function (e) {
        e.preventDefault();
        el.dropZone.classList.add("drag-active");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      el.dropZone.addEventListener(evt, function (e) {
        e.preventDefault();
        el.dropZone.classList.remove("drag-active");
      });
    });
    el.dropZone.addEventListener("drop", function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    el.dropZone.addEventListener("click", function (e) {
      if (e.target === el.pasteBtn) return; // that button has its own handler
      el.fileInput.click();
    });
  }

  function wireFileInputs() {
    el.fileInput.addEventListener("change", function () {
      if (el.fileInput.files && el.fileInput.files[0]) handleFile(el.fileInput.files[0]);
      el.fileInput.value = "";
    });
    function canReplaceDocument() {
      var dirty = state.hasLoadedOnce && (editor.getValue() !== state.savedText || state.format !== state.savedFormat);
      return !dirty || confirm("Replace the current document? Download your edits first if you want to keep them.");
    }
    el.openFileBtn.addEventListener("click", function () {
      if (canReplaceDocument()) el.fileInput.click();
    });
    el.newDocumentBtn.addEventListener("click", function () {
      if (!canReplaceDocument()) return;
      ++loadRequest;
      loadNew("{}", null, "json");
    });
  }

  function wirePaste() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      el.pasteBtn.addEventListener("click", function () {
        var request = ++loadRequest;
        navigator.clipboard.readText().then(function (text) {
          if (request !== loadRequest) return;
          if (text && text.trim()) loadNew(text, null);
          else reportLoadProblem("Your clipboard doesn't seem to have any text in it.");
        }).catch(function () {
          if (request !== loadRequest) return;
          reportLoadProblem("Couldn't read the clipboard — try pasting directly into this page instead (Ctrl/Cmd+V).");
        });
      });
    } else {
      el.pasteBtn.title = "Clipboard access isn't available here — paste directly into the page instead (Ctrl/Cmd+V).";
      el.pasteBtn.disabled = true;
    }

    document.addEventListener("paste", function (e) {
      if (!isEmptyStateVisible()) return; // never hijack paste once the editor is in use
      var text = (e.clipboardData || window.clipboardData).getData("text");
      if (text && text.trim()) {
        e.preventDefault();
        ++loadRequest;
        loadNew(text, null);
      }
    });
  }

  // ---- Toolbar actions -----------------------------------------------------

  function flushEditor() {
    editor.cancelPendingChange();
    var text = editor.getValue();
    if (text !== state.rawText) reparseCurrent(text);
  }

  function setUndoTransform(snapshot) {
    undoTransform = snapshot;
    el.undoTransformBtn.hidden = !snapshot;
  }

  function showTransformPreview(text, format, notes, title) {
    if (bytesOf(text) > MAX_FILE_SIZE_BYTES) throw new Error("The output exceeds the 5 MB editor limit.");
    var result = window.Brace.parser.parseAs(text, format);
    pendingTransform = {
      original: { text: editor.getValue(), format: state.format, scope: state.tableScope },
      text: text,
      result: result,
      notes: notes
    };
    el.transformTitle.textContent = title || "Conversion preview";
    el.transformNotes.replaceChildren();
    notes.forEach(function (note) {
      var li = document.createElement("li");
      li.textContent = note;
      el.transformNotes.appendChild(li);
    });
    el.transformText.value = text;
    el.transformDialog.returnValue = "";
    el.transformDialog.showModal();
  }

  function replaceDocument(text, result) {
    state.rawText = text;
    state.format = result.format;
    state.data = result.data;
    state.isMultiDoc = result.isMultiDoc;
    state.parseError = result.error || null;
    syncEditorFromState();
    if (state.parseError) editor.markErrorLine(state.parseError.line);
    runLintAndRender();
  }

  function wireConvert() {
    el.convertBtn.addEventListener("click", function () {
      clearLoadProblem();
      flushEditor();
      if (state.parseError) return;

      try {
        var converter = window.Brace.convert;
        if (state.format === "yaml") {
          var dupIssues = state.lintIssues.filter(function (i) { return i.code === "duplicate-key"; });
          var notes = converter.analyzeYamlToJson(state.data, state.isMultiDoc, dupIssues);
          showTransformPreview(converter.toJSONText(state.data), "json", notes);
        } else {
          var jsonNotes = converter.analyzeJsonToYaml(state.lintIssues);
          showTransformPreview(converter.toYAMLText(state.data, state.isMultiDoc), "yaml", jsonNotes);
        }
      } catch (err) {
        reportLoadProblem("Couldn't convert this document: " + err.message);
      }
    });

    el.formatSelect.addEventListener("change", function () {
      var format = el.formatSelect.value;
      if (format === state.format) return;
      clearLoadProblem();
      setUndoTransform(null);
      state.format = format;
      state.tableScope = null;
      editor.setMode(format);
      reparseCurrent(editor.getValue());
    });

    el.formatBtn.addEventListener("click", function () {
      clearLoadProblem();
      flushEditor();
      if (state.parseError) return;
      try {
        var converter = window.Brace.convert;
        if (state.format === "json") {
          showTransformPreview(converter.formatJSON(state.rawText, MAX_FILE_SIZE_BYTES), "json",
            ["Formatting changes whitespace and preserves the original JSON tokens."], "Format preview");
        } else {
          showTransformPreview(converter.toYAMLText(state.data, state.isMultiDoc, true), "yaml", [
            "Formatting rewrites YAML from parsed values. Comments, duplicate keys, original anchor names, and scalar styles may be lost."
          ], "Format preview");
        }
      } catch (err) {
        reportLoadProblem("Couldn't format this document: " + err.message);
      }
    });

    el.transformDialog.addEventListener("close", function () {
      var transform = pendingTransform;
      pendingTransform = null;
      if (!transform || el.transformDialog.returnValue !== "apply") return;
      if (editor.getValue() !== transform.original.text || state.format !== transform.original.format) return;
      setUndoTransform(transform.original);
      state.tableScope = null;
      replaceDocument(transform.text, transform.result);
      renderConversionNotes(transform.notes);
    });

    el.undoTransformBtn.addEventListener("click", function () {
      var undo = undoTransform;
      flushEditor();
      if (!undoTransform) return;
      setUndoTransform(null);
      state.tableScope = undo.scope;
      replaceDocument(undo.text, window.Brace.parser.parseAs(undo.text, undo.format));
      renderConversionNotes([]);
    });
  }

  function wireDownload() {
    el.downloadBtn.addEventListener("click", function () {
      var ext = state.format === "yaml" ? "yaml" : "json";
      var mime = state.format === "yaml" ? "application/yaml" : "application/json";
      var text = editor.getValue();
      var blob = new Blob([text], { type: mime + ";charset=utf-8" });
      state.savedText = text;
      state.savedFormat = state.format;
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (currentBaseName() || "data") + "." + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  function wireTabs() {
    el.tabraw.addEventListener("click", function () { setView("raw"); });
    el.tabtree.addEventListener("click", function () {
      flushEditor();
      setView("tree");
    });
  }

  function wireTreeToolbar() {
    el.treeSearchInput.addEventListener("input", function () {
      if (!treeView) return;
      treeView.search(el.treeSearchInput.value.trim());
    });
    el.treeExpandAllBtn.addEventListener("click", function () { if (treeView) treeView.expandAll(); });
    el.treeCollapseAllBtn.addEventListener("click", function () { if (treeView) treeView.collapseAll(); });
  }

  function wireTableToolbar() {
    el.tableFilterInput.addEventListener("input", function () {
      if (tableView) tableView.setFilter(el.tableFilterInput.value);
    });
    el.tableScopeReset.addEventListener("click", function () {
      state.tableScope = null;
      renderTable();
    });
    el.tableCsvBtn.addEventListener("click", function () {
      flushEditor();
      if (!tableView) return;
      var csv = tableView.toCSV();
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (currentBaseName() || "table") + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    el.tableCollapseBtn.addEventListener("click", function () {
      setTableCollapsed(!el.viewtable.classList.contains("collapsed"));
    });
  }

  function wireIssuesPanel() {
    el.issuesToggle.addEventListener("click", function () {
      el.issuesPanel.hidden = !el.issuesPanel.hidden;
    });
    el.notesCloseBtn.addEventListener("click", function () { el.notesPanel.hidden = true; });
  }

  // ---- PWA ------------------------------------------------------------------

  function wirePWA() {
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      el.installBtn.hidden = false;
    });
    el.installBtn.addEventListener("click", function () {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.finally(function () {
        deferredInstallPrompt = null;
        el.installBtn.hidden = true;
      });
    });
    window.addEventListener("appinstalled", function () {
      el.installBtn.hidden = true;
    });

    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("service-worker.js").catch(function () {
        // Offline install just won't be available this session — not fatal.
      });
    }
  }

  // ---- Init ------------------------------------------------------------------

  function grabElements() {
    [
      "emptyState", "emptyError", "dropZone", "fileInput", "chooseFileBtn", "pasteBtn",
      "appShell", "appError", "openFileBtn", "newDocumentBtn", "formatBadge", "convertBtn", "downloadBtn", "installBtn",
      "formatSelect", "formatBtn",
      "statusLine", "issuesToggle", "issuesPanel", "issuesList",
      "notesPanel", "notesTitle", "notesList", "notesCloseBtn", "undoTransformBtn",
      "transformDialog", "transformTitle", "transformNotes", "transformText",
      "tabraw", "tabtree", "viewraw", "viewtree", "viewtable", "tableCollapseBtn",
      "editorTextarea", "treeContainer", "treeSearchInput", "treeExpandAllBtn", "treeCollapseAllBtn",
      "tableContainer", "tableToolbar", "tableFilterInput", "tableCsvBtn",
      "tableScopeLabel", "tableScopeReset", "tablePopoverHost"
    ].forEach(function (id) { el[id] = qs(id); });
  }

  function init() {
    grabElements();
    editor = window.Brace.editor.create(el.editorTextarea, reparseCurrent);

    wireDropZone();
    wireFileInputs();
    wirePaste();
    wireConvert();
    wireDownload();
    wireTabs();
    wireTreeToolbar();
    wireTableToolbar();
    wireIssuesPanel();
    wirePWA();

    setView("tree");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
