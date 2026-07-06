// M1/M2 smoke test: serve packages/core-wasm, load the example page headless,
// assert get_system_info answers from inside the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, urlPath));
    if (!path.startsWith(root)) throw new Error('traversal');
    const data = await readFile(path);
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

let failed = false;
try {
  await page.goto(`http://localhost:${port}/example/index.html`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 120_000 });
  const info = await page.evaluate(() => window.__systemInfo);
  if (!info || !info.deltachat_core_version) {
    console.error('FAIL: unexpected get_system_info result:', JSON.stringify(info));
    failed = true;
  } else {
    console.log(
      `OK: core ${info.deltachat_core_version} answered get_system_info in the browser (sqlite ${info.sqlite_version ?? '?'}, arch ${info.arch ?? '?'})`,
    );
    // typed client (generated RawClient) must work too
    const ids = await page.evaluate(() => window.dc.rpc.getAllAccountIds());
    if (!Array.isArray(ids)) {
      console.error('FAIL: typed client getAllAccountIds returned', JSON.stringify(ids));
      failed = true;
    } else {
      console.log(`OK: typed client works (getAllAccountIds -> [${ids}])`);
    }
  }
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
