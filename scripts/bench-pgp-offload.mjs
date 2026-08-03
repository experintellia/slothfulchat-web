// Benchmark for issue #3: does inline PGP crypto blocking the core worker
// matter, and what would a dedicated crypto worker buy?
//
// Drives packages/core-wasm/bench/index.html headless (same server + launch
// pattern as scripts/bench-core-wasm.mjs). The page runs all scenarios itself
// (?autorun=1) and leaves the result object on window.__benchResults — so the
// exact same measurement runs on a phone via the deployed /bench/ page.
// Needs the built dist + wasm-dist incl. the BenchPgp export.
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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r = (x) => Math.round(x);
const pad = (s, n) => String(s).padStart(n);

function printSummary(res) {
  const v = res.verdict;
  console.log(`device: ${res.device.userAgent}`);
  console.log(
    `cores ${res.device.hardwareConcurrency}, deviceMemory ${res.device.deviceMemory ?? 'n/a'}`,
  );
  console.log(
    `boot ${r(res.bootMs)}ms | crypto worker spawn ${r(res.worker.spawnTotalMs)}ms ` +
      `(wasm init ${r(res.worker.workerInitMs)}ms)`,
  );

  console.log('\ncore-worker ping latency (ms):');
  console.log('  scenario                 n  median     p95     max');
  for (const [name, s] of [
    ['S1 idle', res.idle.stats],
    ['S2 inline keygen', res.inlineKeygen.stats],
    ['S3 inline sends', res.inlineEncrypt.stats],
    ['S4 worker keygen', res.worker.keygen.stats],
  ]) {
    console.log(
      `  ${name.padEnd(22)} ${pad(s.n, 4)} ${pad(r(s.median), 7)} ${pad(r(s.p95), 7)} ${pad(r(s.max), 7)}`,
    );
  }

  console.log(
    `\nkeygen (ms): inline [${res.inlineKeygen.samples.map(r)}] median ${r(v.keygenInlineMedianMs)}` +
      (res.inlineKeygen.reduced ? ' (reduced: sample >15s)' : ''),
  );
  console.log(
    `             worker [${res.worker.keygen.samples.map((s) => r(s.computeMs))}] median ${r(v.keygenWorkerMedianMs)}` +
      (res.worker.keygen.reduced ? ' (reduced: sample >15s)' : ''),
  );

  const se = res.inlineEncrypt;
  console.log(
    `\ninline self-chat sends (2000 chars, ms): median ${r(se.sendStats.median)} ` +
      `p95 ${r(se.sendStats.p95)} max ${r(se.sendStats.max)} | 100KB send ${r(se.bigSendMs)}`,
  );

  console.log('\ncrypto-worker encrypt/decrypt sweep (median of 3, ms):');
  console.log('   size(B)  enc.compute  enc.overhead  dec.compute  dec.overhead');
  for (const { size, reps } of res.worker.sweep) {
    const m = (k) => r(median(reps.map((x) => x[k])));
    console.log(
      `  ${pad(size, 8)} ${pad(m('encryptComputeMs'), 11)} ${pad(m('encryptOverheadMs'), 13)}` +
        ` ${pad(m('decryptComputeMs'), 12)} ${pad(m('decryptOverheadMs'), 13)}`,
    );
  }

  console.log(
    `\nverdict: inline keygen stalls core rpc to p95 ${r(v.pingInlineKeygenP95Ms)}ms ` +
      `(idle baseline ${r(v.pingIdleP95Ms)}ms); with the crypto worker it stays at ` +
      `p95 ${r(v.pingWorkerKeygenP95Ms)}ms. total ${r(v.totalMs / 1000)}s`,
  );
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[page]', m.text().slice(0, 300));
});

let failed = false;
try {
  await page.goto(`http://localhost:${port}/bench/index.html?persist=0&autorun=1`);
  await page.waitForFunction(() => window.__benchResults || window.__benchError, null, {
    timeout: 300_000,
  });
  const err = await page.evaluate(() => window.__benchError);
  if (err) throw new Error(err);
  const results = await page.evaluate(() => window.__benchResults);
  printSummary(results);
  console.log('\nraw JSON:');
  console.log(JSON.stringify(results));
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
