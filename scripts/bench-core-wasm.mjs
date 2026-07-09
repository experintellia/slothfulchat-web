// Benchmark: how long does dc.rpc.addAccount() take in a *real* browser?
//
// Answers two questions the account-creation slowness raised, with numbers:
//   1. persist=1 (OPFS sahpool) vs persist=0 (in-memory VFS) — the delta is the
//      real OPFS write cost. (Node can't answer this: no OPFS there.)
//   2. Is the per-account cost flat (the ~154 schema migrations, a constant) or
//      does it spike after ~10 accounts (sahpool pool growth past its 32-file
//      initial_capacity, ~3 files/account)? We create N accounts and print each.
//
// Boots packages/core-wasm/example/index.html headless in chromium, same as
// scripts/smoke-core-wasm.mjs. Needs the built dist + wasm-dist (pnpm --filter
// @slothfulchat/core-wasm build && the wasm-pack build).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const N = Number(process.env.N ?? 20);

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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r = (x) => Math.round(x);

// One run in a fresh browser context (= fresh OPFS partition, empty each time).
async function benchMode(browser, persist) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') console.error('[page]', t.slice(0, 200));
  });
  await page.goto(`http://localhost:${port}/example/index.html?persist=${persist ? '1' : '0'}`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 120_000 });

  const times = await page.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await window.dc.rpc.addAccount();
      out.push(performance.now() - t);
    }
    return out;
  }, N);

  await ctx.close();
  return times;
}

const browser = await chromium.launch();
let failed = false;
try {
  const info = await (async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
    await page.waitForFunction(() => window.__systemInfo, null, { timeout: 120_000 });
    const i = await page.evaluate(() => window.__systemInfo);
    await ctx.close();
    return i;
  })();
  console.log(`core ${info.deltachat_core_version}, sqlite ${info.sqlite_version}, ${N} accounts/run\n`);

  const opfs = await benchMode(browser, true);
  const mem = await benchMode(browser, false);

  console.log('  #   OPFS(ms)  mem(ms)');
  for (let i = 0; i < N; i++) {
    console.log(`  ${String(i + 1).padStart(2)}  ${String(r(opfs[i])).padStart(7)}  ${String(r(mem[i])).padStart(7)}`);
  }
  const om = median(opfs), mm = median(mem);
  console.log(
    `\nOPFS   min ${r(Math.min(...opfs))}  median ${r(om)}  max ${r(Math.max(...opfs))}`,
  );
  console.log(
    `memory min ${r(Math.min(...mem))}  median ${r(mm)}  max ${r(Math.max(...mem))}`,
  );
  console.log(`\nOPFS write overhead per account ≈ ${r(om - mm)}ms (median OPFS − median memory)`);
  console.log('flat per-account cost ⇒ migrations; spike after ~10 ⇒ sahpool pool growth');
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
