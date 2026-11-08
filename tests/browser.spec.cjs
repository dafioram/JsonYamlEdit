const { test, expect } = require('@playwright/test');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { extname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
let base;
let server;
let unavailable = false;
let hits;

test.beforeAll(async () => {
  // Mount under a path to match project sites on GitHub Pages.
  server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    hits.push(pathname);
    if (unavailable || !pathname.startsWith('/brace/')) {
      response.writeHead(unavailable ? 503 : 404).end();
      return;
    }
    const file = join(root, pathname.slice('/brace/'.length) || 'index.html');
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  hits = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port + '/brace/';
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
});

async function upload(page, name, text) {
  await page.locator('#fileInput').setInputFiles({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  });
}

async function open(page, name, text) {
  await page.goto(base);
  await upload(page, name, text);
  await expect(page.locator('#appShell')).toBeVisible();
}

async function edit(page, text, immediateAction) {
  await page.evaluate(({ text, immediateAction }) => {
    document.querySelector('.CodeMirror').CodeMirror.setValue(text);
    if (immediateAction) document.querySelector(immediateAction).click();
  }, { text, immediateAction });
}

async function download(page, action) {
  const waiting = page.waitForEvent('download');
  await action();
  const file = await waiting;
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), 'utf8') };
}

test('downloads and conversion use edits made before the debounce and undo restores format', async ({ page }) => {
  await open(page, 'fixture.json', '{"old":true}');
  await page.locator('#tabraw').click();
  const saved = await download(page, () => edit(page, '{"latest":2}', '#downloadBtn'));
  expect(saved).toEqual({ name: 'fixture.json', text: '{"latest":2}' });

  await edit(page, '{"latest":3}', '#convertBtn');
  await expect(page.locator('#transformText')).toHaveValue('latest: 3\n');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#formatBadge')).toHaveText('JSON');

  await page.locator('#convertBtn').click();
  await page.getByRole('button', { name: 'Replace editor text' }).click();
  await expect(page.locator('#formatBadge')).toHaveText('YAML');
  await page.getByRole('button', { name: 'Undo change' }).click();
  await expect(page.locator('#formatBadge')).toHaveText('JSON');
  expect((await download(page, () => page.locator('#downloadBtn').click())).text).toBe('{"latest":3}');
});

test('conversion guards numeric precision and previews one marked YAML document as an object', async ({ page }) => {
  await open(page, 'numbers.json', '{"id":9007199254740993,"huge":1e400}');
  await page.locator('#convertBtn').click();
  await expect(page.locator('#appError')).toContainText('would change value');
  await expect(page.locator('#transformDialog')).toBeHidden();

  await open(page, 'one.yaml', '---\nanswer: 42\n');
  await expect(page.locator('#formatBadge')).toHaveText('YAML');
  await page.locator('#convertBtn').click();
  expect(JSON.parse(await page.locator('#transformText').inputValue())).toEqual({ answer: 42 });
});

test('malformed JSON opens in Raw and a failed CSV load preserves the active document', async ({ page }) => {
  await open(page, 'repair.json', '{a: 1}');
  await expect(page.locator('#viewraw')).toBeVisible();
  await expect(page.locator('#formatBadge')).toHaveText('JSON');
  await expect(page.locator('#statusLine')).toContainText('Syntax error');
  await expect(page.locator('#convertBtn')).toBeDisabled();
  await page.locator('#issuesToggle').click();
  await expect(page.locator('#issuesList')).not.toContainText('No issues found');
  await page.locator('#formatSelect').selectOption('yaml');
  await expect(page.locator('#statusLine')).toHaveText('Valid');

  await upload(page, 'failed.csv', 'a,"unclosed');
  await expect(page.locator('#csvStatus')).toContainText('Unclosed quoted field');
  await expect(page.locator('#csvApply')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await download(page, () => page.locator('#downloadBtn').click()))
    .toEqual({ name: 'repair.yaml', text: '{a: 1}' });
});

test('new document and JSON formatting preserve numeric spelling', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.locator('#viewraw')).toBeVisible();
  await edit(page, '{"n":9007199254740993}', '#formatBtn');
  await expect(page.locator('#transformText')).toHaveValue('{\n  "n": 9007199254740993\n}');
  await page.getByRole('button', { name: 'Replace editor text' }).click();
  expect((await download(page, () => page.locator('#downloadBtn').click())).text)
    .toContain('9007199254740993');
});

test('removed nested scope and invalid edits clear stale table export', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await open(page, 'scoped.json', '{"parent":{"items":[{"id":1,"payload":{"a":2}}]}}');
  await page.getByRole('button', { name: 'Toggle parent:' }).click();
  await page.getByRole('button', { name: '▦ Table' }).click();
  await page.locator('.cell-badge').click();
  await expect(page.locator('.cell-popover')).toBeVisible();
  await page.locator('#tabraw').click();
  await edit(page, '{"other":true}');
  await expect(page.locator('#tableCsvBtn')).toBeHidden();
  await expect(page.locator('.cell-popover')).toHaveCount(0);
  await expect(page.locator('#tableScopeLabel')).toHaveText('root');

  await edit(page, '[{"id":2}]');
  await expect(page.locator('#tableCsvBtn')).toBeVisible();
  await edit(page, '{', '#tableCsvBtn');
  await expect(page.locator('#tableCsvBtn')).toBeHidden();
  await expect(page.locator('#statusLine')).toContainText('Syntax error');
  expect(pageErrors).toEqual([]);
});

test('cyclic YAML remains editable, and sparse tables bound visible rows and columns', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await open(page, 'cycle.yaml', 'node: &x\n  itself: *x\n');
  await expect(page.locator('#statusLine')).toHaveText('Raw only');
  await expect(page.locator('#treeContainer')).toContainText('self-referencing');
  await expect(page.locator('#convertBtn')).toBeDisabled();
  await page.locator('#tabraw').click();
  expect((await download(page, () => page.locator('#downloadBtn').click())).text)
    .toBe('node: &x\n  itself: *x\n');

  const data = Array.from({ length: 400 }, (_, index) => ({ ['x' + index]: index }));
  await open(page, 'wide.json', JSON.stringify(data));
  await expect(page.locator('tbody tr')).toHaveCount(100);
  await expect(page.locator('thead th')).toHaveCount(50);
  await page.getByRole('button', { name: 'Next columns' }).click();
  await expect(page.locator('thead th').first()).toHaveText('x50');
  await page.getByRole('button', { name: 'Next rows' }).click();
  await expect(page.locator('.table-pager').first()).toContainText('Rows 101–200');
  expect(pageErrors).toEqual([]);
});

test('tree search distinguishes key punctuation and filtered branches collapse on first click', async ({ page }) => {
  await open(page, 'search.json', '{"a.b":"different","a":{"b":"needle"}}');
  await page.locator('#treeSearchInput').fill('needle');
  await expect(page.locator('#treeContainer')).toContainText('needle');
  await expect(page.locator('#treeContainer')).not.toContainText('different');
  const toggle = page.getByRole('button', { name: 'Toggle search.json' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('TSV preview lets the user choose a header, and CSV export protects formula strings', async ({ page }) => {
  await page.goto(base);
  await upload(page, 'example.tsv', '__proto__\tnote\r42\tBobby;Casey;David\r43\t=1+1');
  await expect(page.locator('#csvDelimiter')).toHaveValue('tab');
  await page.locator('#csvHeader').selectOption('yes');
  await page.locator('#csvApply').click();
  await expect(page.locator('#appShell')).toBeVisible();
  const json = await download(page, () => page.locator('#downloadBtn').click());
  expect(json.name).toBe('example.json');
  expect(JSON.parse(json.text).map(row => row.__proto__)).toEqual([42, 43]);
  const protectedCSV = await download(page, () => page.locator('#tableCsvBtn').click());
  expect(protectedCSV.text).toBe("__proto__,note\n42,Bobby;Casey;David\n43,'=1+1");
  await page.getByLabel('Protect formulas').uncheck();
  const raw = await download(page, () => page.locator('#tableCsvBtn').click());
  expect(raw.text).toContain('\n43,=1+1');

  await open(page, 'objects.json', '[{"constructor":"safe","line":"a\\rb"},{"line":"ok"}]');
  const inherited = await download(page, () => page.locator('#tableCsvBtn').click());
  expect(inherited.text).toBe('constructor,line\nsafe,"a\rb"\n,ok');
});

test('opening index.html directly loads a dropped document', async ({ page }) => {
  await page.goto(pathToFileURL(join(root, 'index.html')).href);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['{"local":true}'], 'local.json', { type: 'application/json' }));
    document.querySelector('#dropZone').dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: data,
    }));
  });
  await expect(page.locator('#treeContainer')).toContainText('local:');
});

test('fresh service worker loads documents offline and preserves unrelated caches', async ({ page, context }) => {
  await page.goto(base + 'manifest.webmanifest');
  await page.evaluate(async () => {
    await caches.open('another-app');
    await caches.open('brace-v1');
    const oldScope = location.origin + '/brace/';
    await caches.open('brace-shell:' + oldScope + ':obsolete');
  });
  await page.goto(base);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const keys = await page.evaluate(() => caches.keys());
  expect(keys).toContain('another-app');
  expect(keys).toContain('brace-v1');
  expect(keys).not.toContain('brace-shell:' + base + ':obsolete');
  const baseline = hits.length;
  unavailable = true;
  await context.setOffline(true);
  try {
    await page.goto(base + 'index.html?offline=1');
    await upload(page, 'offline.json', '{"ready":true}');
    await expect(page.locator('#treeContainer')).toContainText('ready:');
    expect(hits.slice(baseline)).not.toContain('/brace/js/csv.js');
  } finally {
    unavailable = false;
    await context.setOffline(false);
  }
});
