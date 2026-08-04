// End-to-end check for the PGP offload (issue #3): boots the example page,
// creates an account and forces keygen, and asserts the op ran on the crypto
// pool worker (observed via the { type: 'crypto-offload' } marker messages).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, urlPath));
    if (!path.startsWith(root)) throw new Error('traversal');
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[page]', m.text().slice(0, 200));
});

let failed = false;
try {
  await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });

  const result = await page.evaluate(async () => {
    const offloaded = [];
    window.core.worker.addEventListener('message', (event) => {
      if (event.data?.type === 'crypto-offload') offloaded.push(event.data.op);
    });
    // give the prewarmed pool a moment to register (it races core boot)
    await new Promise((r) => setTimeout(r, 3000));
    const aid = await window.dc.rpc.addAccount();
    await window.dc.rpc.setConfig(aid, 'configured_addr', 'offload@example.org');
    const t = performance.now();
    await window.dc.rpc.exportSelfKeys(aid, '/keys', null);
    const keygenMs = performance.now() - t;
    // marker messages may still be in flight
    await new Promise((r) => setTimeout(r, 500));
    return { offloaded, keygenMs };
  });

  console.log('ops observed on the crypto pool worker:', JSON.stringify(result.offloaded));
  console.log('exportSelfKeys (keygen) took', Math.round(result.keygenMs), 'ms');
  if (!result.offloaded.includes('keygen')) {
    throw new Error('keygen did NOT run on the pool worker (no crypto-offload marker)');
  }
  console.log('OK: keygen ran on the crypto pool worker');
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
