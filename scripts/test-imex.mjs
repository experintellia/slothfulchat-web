// Backup export+import (file-based IMEX) e2e test on wasm:
// 1. starts the WS-TCP proxy, creates a throwaway chatmail account (node side)
// 2. in the browser: configure the account, put a marker message in the
//    self-chat, exportBackup to /backup (tar in the in-memory fs)
// 3. remove the account, addAccount again, importBackup the tar
// 4. assert the address and the marker message survived the roundtrip
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { chromium } from 'playwright';

const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new';

// -- account creation (node side) --
async function newAccount() {
  const resp = await fetch(CHATMAIL_NEW, { method: 'POST' });
  if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`);
  return resp.json(); // { email, password }
}
const alice = await newAccount();
console.log(`created account ${alice.email} on the relay`);

// -- ws-tcp proxy --
const proxy = fork(fileURLToPath(new URL('./ws-tcp-proxy.mjs', import.meta.url)), [], {
  env: { ...process.env, PORT: '8641' },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 500));

// -- static server --
const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(root)) throw new Error('traversal');
    res.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream');
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const verbose = !!process.env.VERBOSE;
page.on('console', (m) => {
  const t = m.text();
  if (verbose || /error|warn|panic|failed|Failed/i.test(t)) console.log('[page]', t.slice(0, 500));
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

let failed = false;
const watchdog = setTimeout(() => { console.error('FAIL: global watchdog (6 min) — test hung'); proxy.kill(); process.exit(1); }, 360_000);
try {
  await page.goto(
    `http://localhost:${port}/example/index.html?persist=0&proxy=${encodeURIComponent('ws://localhost:8641')}`,
  );
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });
  console.log('core booted, configuring account…');

  const result = await page.evaluate(
    async ({ alice }) => {
      const rpc = window.dc.rpc;
      window.dc.on('Warning', (c, ev) => console.warn('[core warn]', ev.msg));
      window.dc.on('Error', (c, ev) => console.error('[core err]', ev.msg));

      console.log('[step] addAccount+configure');
      const aliceId = await rpc.addAccount();
      await rpc.batchSetConfig(aliceId, { addr: alice.email, mail_pw: alice.password });
      await rpc.configure(aliceId);

      // marker message in the self-chat (contact 1 = SELF); IO is not
      // started, the message stays local — enough for the IMEX roundtrip
      const marker = 'wasm-imex-roundtrip-' + Math.random().toString(36).slice(2);
      const selfChat = await rpc.createChatByContactId(aliceId, 1);
      await rpc.miscSendTextMessage(aliceId, selfChat, marker);

      console.log('[step] exportBackup');
      const fileWritten = new Promise((resolve) => {
        window.dc.on('ImexFileWritten', (contextId, event) => {
          if (contextId === aliceId) resolve(event.path);
        });
      });
      await rpc.exportBackup(aliceId, '/backup', null);
      const tarPath = await Promise.race([
        fileWritten,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout waiting for ImexFileWritten')), 30_000),
        ),
      ]);
      if (!tarPath.endsWith('.tar')) throw new Error(`unexpected backup path: ${tarPath}`);

      const tarBytes = await window.core.fsRead(tarPath);
      if (tarBytes.length <= 10 * 1024) {
        throw new Error(`backup tar too small: ${tarBytes.length} bytes`);
      }
      console.log(`[step] backup written: ${tarPath} (${tarBytes.length} bytes)`);

      console.log('[step] removeAccount + importBackup');
      await rpc.removeAccount(aliceId);
      const importedId = await rpc.addAccount();
      // the tar lives in /backup, outside the removed account dir — but write
      // the stashed bytes back anyway to exercise the fs side channel
      await window.core.fsWrite(tarPath, tarBytes);
      await rpc.importBackup(importedId, tarPath, null);

      const addr =
        (await rpc.getConfig(importedId, 'configured_addr')) ??
        (await rpc.getConfig(importedId, 'addr'));
      if (addr !== alice.email) {
        throw new Error(`imported addr mismatch: ${addr} != ${alice.email}`);
      }

      const selfChat2 = await rpc.createChatByContactId(importedId, 1);
      const msgIds = await rpc.getMessageIds(importedId, selfChat2, false, false);
      let found = false;
      for (const msgId of msgIds) {
        const msg = await rpc.getMessage(importedId, msgId);
        if (msg.text && msg.text.includes(marker)) found = true;
      }
      if (!found) throw new Error(`marker message not found after import (${msgIds.length} msgs)`);

      return { ok: true, addr, tarPath, tarSize: tarBytes.length, msgCount: msgIds.length };
    },
    { alice },
  );
  console.log(
    `backup ${result.tarPath} (${result.tarSize} bytes) reimported: addr=${result.addr}, self-chat has ${result.msgCount} message(s) incl. marker`,
  );
  console.log('OK: backup export+import roundtrip on wasm');
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.close();
  proxy.kill();
}
process.exit(failed ? 1 : 0);
