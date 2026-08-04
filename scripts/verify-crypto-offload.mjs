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

// Phase 2 swaps in a crypto worker that reports ready (so core registers the
// offload handler) but fails every op, standing in for a wasm trap or a dead
// pool. Core must still complete the operation inline.
const SABOTAGED_WORKER = `
  self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: false, error: 'simulated pool failure' })
  self.postMessage({ type: 'ready' })
`;
let sabotage = false;

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, urlPath));
    if (!path.startsWith(root)) throw new Error('traversal');
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    if (sabotage && urlPath.endsWith('/crypto-worker.js')) {
      res.end(SABOTAGED_WORKER);
      return;
    }
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

// Boots the page, forces a keygen through jsonrpc, and reports which ops the
// crypto pool actually ran (via the { type: 'crypto-offload' } markers).
async function runKeygen() {
  await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });
  return page.evaluate(async () => {
    const offloaded = [];
    const warnings = [];
    window.core.worker.addEventListener('message', (event) => {
      if (event.data?.type === 'crypto-offload') offloaded.push(event.data.op);
    });
    window.dc.on('Warning', (_accountId, event) => warnings.push(String(event?.msg ?? '')));
    // give the prewarmed pool a moment to register (it races core boot)
    await new Promise((r) => setTimeout(r, 3000));
    const aid = await window.dc.rpc.addAccount();
    await window.dc.rpc.setConfig(aid, 'configured_addr', 'offload@example.org');
    const t = performance.now();
    await window.dc.rpc.exportSelfKeys(aid, '/keys', null);
    const keygenMs = performance.now() - t;
    // the run only counts if a key was really generated and stored
    const info = await window.dc.rpc.getInfo(aid);
    // marker messages may still be in flight
    await new Promise((r) => setTimeout(r, 500));
    return {
      offloaded,
      keygenMs,
      keyCount: Number(info.private_key_count),
      fellBackInline: warnings.some((w) => w.includes('offload, generating inline')),
    };
  });
}

let failed = false;
try {
  const offloadRun = await runKeygen();
  console.log('ops observed on the crypto pool worker:', JSON.stringify(offloadRun.offloaded));
  console.log('exportSelfKeys (keygen) took', Math.round(offloadRun.keygenMs), 'ms');
  if (!offloadRun.offloaded.includes('keygen')) {
    throw new Error('keygen did NOT run on the pool worker (no crypto-offload marker)');
  }
  if (offloadRun.keyCount < 1) throw new Error("offloaded keygen stored no key");
  console.log('OK: keygen ran on the crypto pool worker');

  // The pool must never be a correctness dependency: with every op failing,
  // core has to fall back to computing inline.
  sabotage = true;
  const inlineRun = await runKeygen();
  if (inlineRun.offloaded.length) {
    throw new Error(`sabotaged pool still reported ops: ${inlineRun.offloaded}`);
  }
  // the warning proves core took the offload branch and recovered, rather
  // than the pool never having registered in the first place
  if (!inlineRun.fellBackInline) {
    throw new Error('core never entered the offload branch, so the fallback is untested');
  }
  if (inlineRun.keyCount < 1) {
    throw new Error('keygen did NOT fall back inline when the pool failed');
  }
  console.log(
    `OK: with a failing pool, keygen fell back inline (${Math.round(inlineRun.keygenMs)} ms)`,
  );
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
