const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

global.window = global;
global.jsyaml = require('../lib/js-yaml.min.js');
for (const name of ['parser', 'linter', 'convert', 'csv', 'tree-view']) {
  require('../js/' + name + '.js');
}

const { parser, linter, convert, csv, treeView } = global.Brace;

test('YAML document start markers do not wrap a single document in an array', () => {
  assert.deepEqual(parser.parseAs('---\nanswer: 42\n', 'yaml'), {
    format: 'yaml', data: { answer: 42 }, isMultiDoc: false,
  });
  const stream = parser.parseAs('---\na: 1\n---\nb: 2\n', 'yaml');
  assert.deepEqual(stream.data, [{ a: 1 }, { b: 2 }]);
  assert.equal(stream.isMultiDoc, true);
  assert.deepEqual(parser.parseAs('---\n- 1\n- 2\n', 'yaml').data, [1, 2]);
});

test('JSON lint compares decoded duplicate keys and exact decimal values', () => {
  const issues = linter.lintJSON(String.raw`{"a":1,"\u0061":2,"n":[9007199254740993,1e400,1e-400,1.0000000000000001]}`);
  assert.deepEqual(issues.map(issue => issue.code), [
    'duplicate-key', 'numeric-precision', 'numeric-precision', 'numeric-precision', 'numeric-precision',
  ]);
  assert.throws(() => convert.analyzeJsonToYaml(issues), /would change value/);
  assert.deepEqual(linter.lintJSON('[1.25,1e-7,-0,1e100,1.000000]'), []);
});

test('JSON format preserves keys, escapes, and numeric tokens', () => {
  const original = String.raw`{"n":9007199254740993,"n":1.2500e-3,"s":"a \" b","x":[{},[]]}`;
  const formatted = convert.formatJSON(original, 1000);
  assert.match(formatted, /9007199254740993/);
  assert.match(formatted, /1\.2500e-3/);
  assert.equal(linter.lintJSON(formatted).filter(issue => issue.code === 'duplicate-key').length, 1);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(original));
  assert.throws(() => convert.formatJSON(original, 20), /exceeds/);
});

test('graph budget rejects cycles, excessive depth and alias expansion', () => {
  const cycle = parser.parseAs('node: &x\n  itself: *x\n', 'yaml');
  assert.match(parser.inspectData(cycle.data), /self-referencing/);
  const shared = { name: 'shared' };
  assert.equal(parser.inspectData([shared, shared]), null);
  let nested = shared;
  for (let i = 0; i < 130; i++) nested = [nested];
  assert.match(parser.inspectData(nested), /limit/);
  let expanded = shared;
  for (let i = 0; i < 18; i++) expanded = [expanded, expanded];
  assert.match(parser.inspectData(expanded), /limit/);
});

test('scope paths use own keys and distinguish dots from nesting', () => {
  const path = [{ type: 'key', name: 'parent' }, { type: 'key', name: 'items' }];
  assert.equal(treeView.resolvePath({ parent: null }, path), undefined);
  assert.equal(treeView.resolvePath({}, path), undefined);
  assert.equal(treeView.resolvePath({}, [{ type: 'key', name: 'constructor' }]), undefined);
  assert.notEqual(treeView.formatPath([{ type: 'key', name: 'a.b' }]),
    treeView.formatPath([{ type: 'key', name: 'a' }, { type: 'key', name: 'b' }]));
});

test('CSV reads logical records and rejects malformed quoting', () => {
  const source = 'a,b\r1,"x\r\ny"\r2,"""z"""';
  assert.equal(csv.detectDelimiter(source), ',');
  assert.deepEqual(csv.read(source, ','), [['a', 'b'], ['1', 'x\r\ny'], ['2', '"z"']]);
  assert.throws(() => csv.read('a,"b', ','), /Unclosed/);
  assert.throws(() => csv.read('a,b"c', ','), /Unexpected/);
  assert.deepEqual(csv.read('"",\n', ','), [['', '']]);
});

test('CSV preserves special column names and lets callers opt out of inference', () => {
  const rows = csv.read('__proto__,constructor,constructor\n42,true,00501', ',');
  const typed = csv.toObjects(rows, ',', 'yes', true);
  assert.deepEqual(typed.columns, ['__proto__', 'constructor', 'constructor_2']);
  assert.equal(JSON.stringify(typed.data), '[{"__proto__":42,"constructor":true,"constructor_2":"00501"}]');
  assert.equal(csv.toObjects(rows, ',', 'yes', false).data[0].__proto__, '42');
  assert.throws(() => csv.toObjects(rows, ',', 'yes', false, 10), /exceed/);
});

test('all startup resources are precached and all precache files exist', () => {
  const root = join(__dirname, '..');
  const context = {
    self: { registration: { scope: 'https://example.test/brace/' }, addEventListener() {} },
  };
  vm.runInNewContext(readFileSync(join(root, 'service-worker.js'), 'utf8'), context);
  const assets = new Set(context.PRECACHE_FILES);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  for (const resource of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])) {
    assert.ok(assets.has(resource), 'missing startup asset: ' + resource);
  }
  for (const icon of manifest.icons) assert.ok(assets.has(icon.src));
  assert.ok(assets.has(manifest.start_url.replace(/^\.\//, '')));
  for (const asset of assets) assert.ok(existsSync(join(root, asset)), 'missing file: ' + asset);
});
