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
requires HTTPS or a trusted local origin such as `http://localhost`. A
plain `file://` tab can still open and edit documents. Any static file
server works for local testing,
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
- **JSON and YAML mode** uses a known file extension and auto-detects pasted
  content. Open malformed files in Raw and change the mode from the toolbar.
- **New and Format text** start an empty JSON object or preview a rewrite
  of the current file. JSON formatting preserves tokens, including number
  spelling and duplicate keys. YAML formatting rewrites parsed data, so
  review the preview if comments or source style matter.
- **CSV/TSV import** previews records before opening them as JSON. Choose
  the delimiter and whether the first row is a header, or use the detected
  settings. TSV starts with the tab delimiter. Turn off type inference to
  keep fields as text. Duplicate column names are renamed, and malformed
  quoting is reported before import.
- **Raw editor** with syntax highlighting, line numbers, bracket matching,
  and code folding (CodeMirror), fully editable — this is the one place
  edits actually happen; Tree and Table are for browsing.
- **Tree view**: collapsible nesting, a key/item count badge on every
  object and array, search (shows and auto-expands matching
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
  inside. CSV export applies the current filter and sort across all pages.
  The default formula protection prefixes formula-like text with an
  apostrophe. Turn it off when you need the original field values.
- **Convert** between JSON and YAML with a preview and an undo action. Brace
  flags duplicate keys and blocks JSON conversion if a number would change value.
- **Linter**: flags duplicate keys (in both JSON and YAML — the *last*
  value silently wins in both formats, which is rarely what you meant) and
  YAML lines indented with tabs (invalid per the YAML spec). Issues are
  clickable and jump straight to the offending line in the Raw view.
- **Installable / offline-capable** (PWA) on HTTPS or localhost — see
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

Review the output before replacing the original. YAML uses a broader data
model than JSON and the preview calls out common representation changes.

## Limits & known constraints

- **5 MB file size cap.** Brace parses the entire file in memory in your
  browser — there's no server to hand off the heavy lifting to, and no
  streaming parser. Tree and Table are bounded by depth and expanded node
  count. YAML with cyclic aliases stays available in Raw. Tables page both
  rows and columns, and CSV exports are capped at one million cells.
- **Tree/Table are read-only views.** Editing happens in the Raw view;
  Tree and Table are for navigating and understanding the data. (Click
  "copy path" on a tree node to quickly locate it in the raw text.)
- **Undo** uses CodeMirror history for typing and a separate action to
  restore the text and format immediately after a conversion.

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

## Testing

The app itself still runs from `index.html` without a build or install.
To run the development checks with Node.js 24:

```bash
npm ci
npx playwright install chromium
npm test
```

GitHub Actions runs the Node unit tests and the Playwright Chromium tests
on pushes and pull requests. Browser checks cover direct file access,
document repair, conversion, exports, and a fresh service worker running
offline from a project subpath. On Linux, add `--with-deps` to the
Playwright install command if your system needs browser dependencies.
