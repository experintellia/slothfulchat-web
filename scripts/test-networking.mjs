// M3 end-to-end test:
// 1. starts the WS-TCP proxy
// 2. creates a fresh account on a chatmail relay (HTTPS POST from node —
//    core's in-wasm HTTP is still stubbed)
// 3. inside the browser: configure the account over IMAP/SMTP through the
//    proxy (TLS terminates in wasm), send a message to self via SMTP and
//    wait for it to arrive back via IMAP
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
const bob = await newAccount();
console.log(`created accounts ${alice.email} and ${bob.email} on the relay`);

// -- ws-tcp proxy --
const proxy = fork(fileURLToPath(new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)), [], {
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
  console.log('core booted, configuring account over IMAP/SMTP through the proxy…');

  const result = await page.evaluate(
    async ({ alice, bob }) => {
      const rpc = window.dc.rpc;
      // temp diagnostics: surface core logs + rpc step markers
      window.dc.on('Info', (c, ev) => console.log('[core]', ev.msg));
      window.dc.on('Warning', (c, ev) => console.warn('[core warn]', ev.msg));
      window.dc.on('Error', (c, ev) => console.error('[core err]', ev.msg));
      const setup = async ({ email, password }) => {
        console.log('[step] addAccount');
        const id = await rpc.addAccount();
        console.log('[step] batchSetConfig', id);
        await rpc.batchSetConfig(id, { addr: email, mail_pw: password });
        console.log('[step] configure', id);
        try {
          await rpc.configure(id);
        } catch (err) {
          throw new Error(`configure(${email}) failed: ${JSON.stringify(err)}`);
        }
        await rpc.startIo(id);
        return id;
      };
      // two accounts in the same in-browser core (multiaccount)
      const aliceId = await setup(alice);
      const bobId = await setup(bob);

      const marker = 'wasm-roundtrip-' + Math.random().toString(36).slice(2);
      const arrived = new Promise((resolve) => {
        window.dc.on('IncomingMsg', async (contextId, event) => {
          if (contextId !== bobId) return;
          const msg = await rpc.getMessage(bobId, event.msgId);
          if (msg.text.includes(marker)) resolve(msg.text);
        });
      });

      // chatmail relays require E2E encryption: hand alice bob's public key
      // via vcard (1 = ContactId::SELF) before sending.
      const vcard = await rpc.makeVcard(bobId, [1]);
      const [contactId] = await rpc.importVcardContents(aliceId, vcard);
      const chatId = await rpc.createChatByContactId(aliceId, contactId);
      await rpc.miscSendTextMessage(aliceId, chatId, marker);

      const text = await Promise.race([
        arrived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout waiting for message delivery')), 120_000),
        ),
      ]);
      return { ok: true, text };
    },
    { alice, bob },
  );
  console.log(
    `OK: two accounts configured over the WS tunnel; alice→bob message delivered: "${result.text}"`,
  );
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
