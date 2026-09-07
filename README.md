# Brace — a JSON &amp; YAML workbench

A local-first, static web app for viewing, editing, and converting JSON and
YAML files. Everything happens in your browser — nothing is uploaded
anywhere, ever.

## Running it

Brace is a static site (`index.html` + assets) — no build step, no server
code, no `npm install` required to use it.

**Quickest option:** just double-click `index.html` to open it directly in
a browser. Everything works this way *except* installing it as an offline
app (see below).

**For the PWA install prompt / offline support to work**, the browser
requires the app to be served over `http://` or `https://`, not opened as
a bare `file://` path — that's a browser security rule for service
workers, not something specific to Brace. Any static file server works,
for example, from this folder:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080`. From there, most browsers offer an
"Install" option in the address bar, or you can use the in-app "Install
app" button once it appears.

## Features

- **Open a file** by dragging it in, using the file picker, or pasting
  JSON/YAML text directly (button, or Ctrl/Cmd+V on the empty-state
  screen). CSV/TSV files are also accepted — see below.
- **Auto-detects JSON vs. YAML** — no need to tell it which.
- **CSV/TSV import**: dropped, uploaded, or pasted CSV is converted to an
  array of JSON objects on the way in, so it immediately gets the full
  Tree/Table/lint/convert treatment like anything else. Header row
  presence is auto-detected (a simplified version of the classic
  CSV-sniffing heuristic — it compares whether the first row's cells are
  string-typed while the columns below trend numeric/boolean); if none is
  found, columns are named `column_1`, `column_2`, etc. Values are typed
  where safe — numbers and `true`/`false` become real JSON types, but only
  when the conversion round-trips exactly, so `"00501"` (a zip code) stays
  a string instead of silently losing its leading zero. Duplicate column
  names are auto-renamed (`name`, `name_2`) rather than overwritten. An
  "Import notes" panel explains what was detected on each import.
  Header detection has real limits on very small or all-text samples —
  if it guesses wrong, the header row just shows up as an obvious first
  data row, so it's easy to spot; editing the raw JSON directly is the
  fix for now.
- **Raw editor** with syntax highlighting, line numbers, bracket matching,
  and code folding (CodeMirror), fully editable — this is the one place
  edits actually happen; Tree and Table are for browsing.
- **Tree view**: collapsible nesting, a key/item count badge on every
  object and array, search (auto-expands and highlights matching
  branches), expand-all / collapse-all, and a "copy path" button on every
  node.
- **Table view**: a persistent pane, not a tab — it stays visible
  alongside whichever of Raw/Tree is active (collapsible if you want it
  out of the way). Automatically available for any array of objects (root
  or a nested one, via the ▦ Table button next to it in Tree view).
  Columns are the union of keys across all rows, so it tolerates
  real-world, not-quite-uniform data — missing fields just render as an
  empty cell. Sortable columns, a row filter, CSV export, and nested
  object/array cells collapse into a small badge you can click to peek
  inside.
- **Convert** between JSON and YAML. JSON → YAML is lossless. YAML → JSON
  is not, and Brace tells you exactly what changed rather than doing it
  quietly — see "Conversion notes," below.
- **Linter**: flags duplicate keys (in both JSON and YAML — the *last*
  value silently wins in both formats, which is rarely what you meant) and
  YAML lines indented with tabs (invalid per the YAML spec). Issues are
  clickable and jump straight to the offending line in the Raw view.
- **Installable / offline-capable** (PWA) once served over http(s) — see
  above.

### Conversion notes: what YAML → JSON actually changes

JSON has no comments, no anchors/aliases, no multi-document separators,
and no special float values — so converting a YAML file that uses any of
these *will* change it. Every conversion shows a plain-language summary,
for example:

- Comments removed (JSON has no comment syntax).
- Anchors/aliases expanded into repeated inline data.
- Multiple `---` documents combined into one JSON array.
- Duplicate keys resolved to their last value.
- `.inf` / `.nan` become `null` (JSON has no representation for them —
  this is just what `JSON.stringify` already does with `Infinity`/`NaN`).
- YAML timestamps become ISO-8601 strings.

Going YAML → JSON never happens silently; going JSON → YAML never loses
anything.

## Limits & known constraints

- **5 MB file size cap.** Brace parses the entire file in memory in your
  browser — there's no server to hand off the heavy lifting to, and no
  streaming/partial parser (JSON and YAML aren't byte-seekable formats the
  way CSV is, so this would be a much bigger undertaking). 5 MB comfortably
  covers hand-written configs, API responses, and most data exports; if
  you need bigger, a proper desktop tool with a streaming parser is the
  better fit for now.
- **Tree/Table are read-only views.** Editing happens in the Raw view;
  Tree and Table are for navigating and understanding the data. (Click
  "copy path" on a tree node to quickly locate it in the raw text.)
- **No undo history beyond the browser's native text-edit undo** inside
  the Raw editor (Ctrl/Cmd+Z works there as usual).

## Under the hood

- Vanilla HTML/CSS/JS — no framework, no build step, no bundler.
- [js-yaml](https://github.com/nodeca/js-yaml) (MIT license) for YAML
  parsing/dumping.
- [CodeMirror 5](https://codemirror.net/5/) (MIT license) for the raw
  editor.
- Both are vendored locally in `lib/` — nothing is loaded from a CDN, so
  the app has zero network dependency at runtime and the "your data never
  leaves this device" claim actually holds up.
- All state lives in memory for the current tab; nothing is written to
  `localStorage` or any other persistent browser storage.

## File structure

```
index.html
manifest.webmanifest      PWA manifest
service-worker.js         offline caching (app shell only)
css/                       app.css (UI), editor-theme.css (CodeMirror theme)
js/
  parser.js               format auto-detection + JSON/YAML parsing
  linter.js               duplicate-key & tab-indentation checks
  csv.js                   CSV/TSV -> JSON conversion (delimiter/header
                           detection, type inference)
  convert.js               JSON <-> YAML conversion + lossy-conversion notes
  tree-view.js             collapsible tree renderer
  table-view.js            sortable/filterable table renderer
  editor.js                CodeMirror wrapper
  app.js                   wiring: state, file loading, view switching
lib/                       vendored js-yaml + CodeMirror 5 (no CDN)
icons/                     PWA icons
```

## A note on testing

The core logic (format detection, parsing, duplicate-key linting,
conversion, and the tree/table rendering logic) was unit-tested directly
in Node and via a jsdom-based DOM smoke test during development. What
*wasn't* possible to test in this environment was a real browser run —
so give the actual drag-and-drop, CodeMirror editing feel, and PWA
install prompt a check in your browser of choice before relying on it for
anything important, and let me know if anything looks off.
