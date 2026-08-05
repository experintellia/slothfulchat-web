// Offline check for the PGP offload (issue #3): boots the example page,
// forces key generation, and asserts it ran on the crypto pool worker — then
// that a broken pool never costs correctness. Pool activity is read back with
// the core worker's { type: 'crypto-stats' } query.
// Encryption and decryption are covered by test-crypto-offload-e2e.mjs.
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

// Later phases swap in a broken crypto worker. Both report ready, so core
// registers the offload handler and genuinely takes the offload branch:
//   failing — answers every op with an error (a wasm trap, a dead instance)
//   silent  — never answers at all (worker reclaimed by the OS, wedged);
//             only the pool's own deadline can rescue this one
const BROKEN_WORKERS = {
  failing: `
    self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: false, error: 'simulated pool failure' })
    self.postMessage({ type: 'ready' })
  `,
  silent: `
    self.onmessage = () => {}
    self.postMessage({ type: 'ready' })
  `,
  // served only for the FIRST fetch (see fetchCount): reports a wasm trap, so
  // the pool must terminate it and respawn — the respawn gets the real worker
  fatalOnce: `
    self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: false, fatal: true, error: 'simulated trap' })
    self.postMessage({ type: 'ready' })
  `,
};
let sabotage = null;
let fetchCount = 0;

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, urlPath));
    if (!path.startsWith(root)) throw new Error('traversal');
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    if (sabotage && urlPath.endsWith('/crypto-worker.js')) {
      fetchCount++;
      // 'fatalOnce' only breaks the first worker; the respawn gets the real one
      if (sabotage !== 'fatalOnce' || fetchCount === 1) {
        res.end(BROKEN_WORKERS[sabotage]);
        return;
      }
    }
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

// CHROMIUM_BIN=/path/to/chrome overrides the browser binary, for sandboxes
// that ship a Chromium not matching the installed Playwright version
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {},
);
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[page]', m.text().slice(0, 200));
});

// Boots the page and forces `accounts` key generations through jsonrpc, then
// reports how many ops the pool actually completed.
async function runScenario({ accounts = 1, sequential = false } = {}) {
  await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });
  return page.evaluate(async ({ accounts, sequential }) => {
    // asks the core worker how many ops its crypto pool actually ran
    const cryptoStats = () =>
      new Promise((resolve) => {
        window.core.worker.addEventListener('message', function onStats(event) {
          if (event.data?.type !== 'crypto-stats') return;
          window.core.worker.removeEventListener('message', onStats);
          resolve(event.data.offloaded);
        });
        window.core.worker.postMessage({ type: 'crypto-stats' });
      });
    const warnings = [];
    window.dc.on('Warning', (_accountId, event) => warnings.push(String(event?.msg ?? '')));
    // give the prewarmed pool a moment to register (it races core boot)
    await new Promise((r) => setTimeout(r, 3000));
    // Each account generates its own key under its own lock. Fired
    // concurrently, more accounts than the pool's queue bound pushes ops past
    // it; whatever the queue does with them, every key must still be
    // produced. Sequentially, a later op can land on a respawned worker.
    const keygen = async (i) => {
      const aid = await window.dc.rpc.addAccount();
      await window.dc.rpc.setConfig(aid, 'configured_addr', `offload${i}@example.org`);
      await window.dc.rpc.exportSelfKeys(aid, `/keys-${aid}`, null);
      const info = await window.dc.rpc.getInfo(aid);
      // a run only counts if the key was really generated and stored
      if (Number(info.private_key_count) < 1) throw new Error(`account ${aid} stored no key`);
    };
    const t = performance.now();
    const results = [];
    if (sequential) {
      for (let i = 0; i < accounts; i++) {
        results.push(
          await keygen(i).then(
            () => ({ status: 'fulfilled' }),
            (reason) => ({ status: 'rejected', reason }),
          ),
        );
      }
    } else {
      results.push(...(await Promise.allSettled(Array.from({ length: accounts }, (_u, i) => keygen(i)))));
    }
    const keygenMs = performance.now() - t;
    return {
      offloaded: await cryptoStats(),
      keygenMs,
      keyed: results.filter((r) => r.status === 'fulfilled').length,
      failure: results.find((r) => r.status === 'rejected')?.reason?.message ?? null,
      fellBackInline: warnings.some((w) => w.includes('offload, generating inline')),
    };
  }, { accounts, sequential });
}

const ACCOUNTS = 12; // > the pool's MAX_QUEUED, so the queue bound gets exercised

let failed = false;
try {
  const offloadRun = await runScenario({ accounts: ACCOUNTS });
  console.log(
    `ops on the crypto pool worker: ${JSON.stringify(offloadRun.offloaded)}` +
      ` (${ACCOUNTS} concurrent keygens in ${Math.round(offloadRun.keygenMs)} ms)`,
  );
  if (!offloadRun.offloaded.keygen) {
    throw new Error('keygen did NOT run on the pool worker');
  }
  // whatever the queue did with them — pool or inline — all keys must exist
  if (offloadRun.keyed !== ACCOUNTS) {
    throw new Error(
      `only ${offloadRun.keyed}/${ACCOUNTS} keygens completed under queue pressure` +
        ` (${offloadRun.failure})`,
    );
  }
  console.log(`OK: keygen ran on the pool; all ${ACCOUNTS} concurrent keygens produced keys`);

  // The pool must never be a correctness dependency. Both broken workers
  // register successfully, so core really takes the offload branch and has to
  // recover from it — by error for 'failing', by deadline for 'silent'.
  for (const [mode, note] of [
    ['failing', 'every op errors'],
    ['silent', 'never answers'],
  ]) {
    sabotage = mode;
    const run = await runScenario();
    const ran = Object.keys(run.offloaded);
    if (ran.length) throw new Error(`${mode} pool still completed ops: ${ran}`);
    // the warning proves core took the offload branch and recovered, rather
    // than the pool never having registered in the first place
    if (!run.fellBackInline) {
      throw new Error(`${mode}: core never entered the offload branch, so the fallback is untested`);
    }
    if (run.keyed !== 1) throw new Error(`${mode}: keygen did NOT fall back inline`);
    console.log(
      `OK: pool that ${note} — keygen fell back inline (${Math.round(run.keygenMs)} ms)`,
    );
  }

  // A trap must not take the pool out permanently: the first worker reports
  // one, and the respawned (healthy) worker has to pick the work back up.
  sabotage = 'fatalOnce';
  fetchCount = 0;
  const respawnRun = await runScenario({ accounts: 2, sequential: true });
  if (!respawnRun.fellBackInline) {
    throw new Error('fatalOnce: the trapped op did not fall back inline');
  }
  if (!respawnRun.offloaded.keygen) {
    throw new Error('fatalOnce: pool never recovered — nothing ran on it after the trap');
  }
  if (respawnRun.keyed !== 2) {
    throw new Error('fatalOnce: work did not complete across the respawn');
  }
  console.log(
    `OK: pool trapped once, respawned, and resumed offloading (${JSON.stringify(respawnRun.offloaded)})`,
  );
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
