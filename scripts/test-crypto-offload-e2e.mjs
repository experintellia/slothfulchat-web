// Crypto offload end-to-end test (issue #3, PR #178).
//
// verify-crypto-offload.mjs can only reach key generation: encryption happens
// in the send loop and decryption on receive, neither of which runs without a
// mail server. So this drives a real message between two accounts over an
// in-process mock madmail server — nothing leaves the process — and asserts
// that pk_encrypt AND decrypt_keys really ran on the crypto pool worker.
//
// Two accounts are REQUIRED, not one: the madmail transport ignores
// unencrypted inbound mail, so the message has to travel as a real
// end-to-end-encrypted message between key-exchanged accounts. The send
// handler asserts the relayed body is PGP armor, so "encrypted" is checked
// against the wire, not inferred.
//
// Phase 2 repeats the round trip with a crypto worker that fails every op.
// The same message must still arrive — decrypted inline — which is the
// property that keeps a broken pool from costing anyone their mail.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// --- mock madmail (message-serving + delivery, from test-html-email-e2e) ---
const users = new Map();
let userSeq = 0;
/** Bodies relayed through /webimap/send, to assert they are really encrypted. */
const relayed = [];
const readBody = req =>
  new Promise(resolve => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => resolve(b));
  });
const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};
const meta = (uid, raw) => ({
  uid,
  seq_num: uid,
  flags: [],
  size: Buffer.byteLength(raw),
  date: new Date('2026-08-01T12:00:00Z').toISOString(),
  envelope: {},
});
const respondMessages = (res, user, sinceUid) => {
  const out = [];
  for (const [uid, raw] of user.msgs) if (uid > sinceUid) out.push(meta(uid, raw));
  json(res, 200, out);
};
const mock = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return void ((res.statusCode = 204), res.end());
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;
  if (req.method === 'POST' && path === '/new') {
    const email = `u${++userSeq}@webimap.example`;
    const password = randomBytes(9).toString('hex');
    users.set(email, { password, nextUid: 1, msgs: new Map(), waiters: [] });
    return void json(res, 200, { email, password, dclogin_url: '' });
  }
  if (path.startsWith('/webimap/')) {
    const user = users.get(req.headers['x-email']);
    if (!user || user.password !== req.headers['x-password']) {
      return void json(res, 401, { error: 'bad credentials' });
    }
    if (path === '/webimap/mailboxes') {
      const n = user.msgs.size;
      return void json(res, 200, [{ name: 'INBOX', messages: n, unseen: n }]);
    }
    if (path === '/webimap/messages') {
      const sinceUid = Number(url.searchParams.get('since_uid') ?? '0') || 0;
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 120);
      const hasNew = [...user.msgs.keys()].some(uid => uid > sinceUid);
      if (hasNew || wait <= 0) return void respondMessages(res, user, sinceUid);
      const waiter = {
        timer: setTimeout(() => {
          user.waiters = user.waiters.filter(w => w !== waiter);
          respondMessages(res, user, sinceUid);
        }, wait * 1000),
        respond: () => respondMessages(res, user, sinceUid),
      };
      user.waiters.push(waiter);
      return;
    }
    const m = path.match(/^\/webimap\/message\/(\d+)$/);
    if (m) {
      const uid = Number(m[1]);
      if (req.method === 'GET') {
        const raw = user.msgs.get(uid);
        if (raw === undefined) return void json(res, 404, { error: 'no such message' });
        return void json(res, 200, { ...meta(uid, raw), body: raw });
      }
      if (req.method === 'DELETE') {
        user.msgs.delete(uid);
        return void json(res, 200, { status: 'ok' });
      }
    }
    if (req.method === 'POST' && path === '/webimap/send') {
      let payload = {};
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        /* keep {} */
      }
      relayed.push(payload.body ?? '');
      const recipients = []
        .concat(payload.to ?? [])
        .flatMap(r => (typeof r === 'string' ? r.split(/[,\s]+/) : []))
        .map(r => r.trim())
        .filter(Boolean);
      for (const rcpt of recipients) {
        const dest = users.get(rcpt);
        if (!dest) continue;
        const uid = dest.nextUid++;
        dest.msgs.set(uid, payload.body ?? '');
        const waiters = dest.waiters;
        dest.waiters = [];
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.respond();
        }
      }
      return void json(res, 200, { status: 'sent' });
    }
  }
  json(res, 404, { error: 'not found' });
});
// must be loopback: core only allows plain http for localhost, https otherwise
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const QR = `webimapaccount:127.0.0.1:${mock.address().port}`;
console.log(`mock madmail on 127.0.0.1:${mock.address().port}`);

// --- static server for the core-wasm example page ---
// Phase 2 swaps in a crypto worker that reports ready — so core registers the
// offload handler and really takes the offload branch — but fails every op.
const FAILING_WORKER = `
  self.onmessage = (e) => self.postMessage({ id: e.data.id, ok: false, error: 'simulated pool failure' })
  self.postMessage({ type: 'ready' })
`;
let breakPool = false;

const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const p = normalize(join(root, urlPath));
    if (!p.startsWith(root)) throw new Error('traversal');
    res.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream');
    if (breakPool && urlPath.endsWith('/crypto-worker.js')) return void res.end(FAILING_WORKER);
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

// CHROMIUM_BIN=/path/to/chrome overrides the browser binary, for sandboxes
// that ship a Chromium not matching the installed Playwright version
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {},
);
const page = await browser.newPage();
const verbose = !!process.env.VERBOSE;
page.on('console', m => {
  const t = m.text();
  if (verbose || /error|panic|failed/i.test(t)) console.log('[page]', t.slice(0, 300));
});
page.on('pageerror', e => console.error('[pageerror]', e.message));

/** Provisions two accounts on the mock, sends alice -> bob, waits for arrival,
 * and reports which ops the crypto pool completed along the way. */
async function roundTrip() {
  await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });
  return page.evaluate(async qr => {
    const rpc = window.dc.rpc;
    const warnings = [];
    window.dc.on('Warning', (_id, ev) => warnings.push(String(ev?.msg ?? '')));
    // asks the core worker how many ops its crypto pool actually ran
    const cryptoStats = () =>
      new Promise(resolve => {
        window.core.worker.addEventListener('message', function onStats(event) {
          if (event.data?.type !== 'crypto-stats') return;
          window.core.worker.removeEventListener('message', onStats);
          resolve(event.data.offloaded);
        });
        window.core.worker.postMessage({ type: 'crypto-stats' });
      });
    // let the prewarmed pool register before any crypto runs (it races boot)
    await new Promise(r => setTimeout(r, 3000));

    // no addr/mail_pw: the QR provisions the account against the mock itself
    const setup = async () => {
      const id = await rpc.addAccount();
      await rpc.addTransportFromQr(id, qr);
      await rpc.startIo(id);
      return id;
    };
    const aliceId = await setup();
    const bobId = await setup();

    // madmail is chatmail-style (e2ee required): exchange public keys via
    // vcard both ways first (1 = ContactId::SELF), so the send is genuinely
    // encrypted to a known key and bob can reply.
    const bobVcard = await rpc.makeVcard(bobId, [1]);
    const [bobContact] = await rpc.importVcardContents(aliceId, bobVcard);
    const aliceVcard = await rpc.makeVcard(aliceId, [1]);
    await rpc.importVcardContents(bobId, aliceVcard);

    const marker = 'offload-e2e-' + Math.random().toString(36).slice(2);
    // arm the listener before sending, so a fast delivery can't be missed
    const arrived = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for delivery')), 120_000);
      window.dc.on('IncomingMsg', async (contextId, event) => {
        if (contextId !== bobId) return;
        const msg = await rpc.getMessage(bobId, event.msgId);
        if (msg.text?.includes(marker)) {
          clearTimeout(timer);
          resolve(msg.text);
        }
      });
    });
    const chatId = await rpc.createChatByContactId(aliceId, bobContact);
    await rpc.miscSendTextMessage(aliceId, chatId, marker);
    const text = await arrived;

    return {
      text,
      marker,
      offloaded: await cryptoStats(),
      fellBackInline: warnings.some(w => /offload, (generating|encrypting|decrypting) inline/.test(w)),
    };
  }, QR);
}

const check = (cond, what) => {
  if (!cond) throw new Error(what);
  console.log(`OK: ${what}`);
};

let failed = false;
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min) — test hung');
  process.exit(1);
}, 360_000);
try {
  // --- phase 1: the pool does the crypto ---
  const pooled = await roundTrip();
  check(pooled.text.includes(pooled.marker), 'alice -> bob message delivered and decrypted');
  check(
    relayed.some(body => body.includes('BEGIN PGP MESSAGE')),
    'the relayed message was PGP-encrypted on the wire',
  );
  console.log('pool ran:', JSON.stringify(pooled.offloaded));
  check(pooled.offloaded.keygen > 0, 'keygen ran on the crypto pool worker');
  check(pooled.offloaded.pk_encrypt > 0, 'pk_encrypt ran on the crypto pool worker');
  check(pooled.offloaded.decrypt_keys > 0, 'decrypt_keys ran on the crypto pool worker');

  // --- phase 2: same round trip, with every pool op failing ---
  breakPool = true;
  relayed.length = 0;
  const inline = await roundTrip();
  check(inline.text.includes(inline.marker), 'message still delivered with a failing pool');
  check(
    relayed.some(body => body.includes('BEGIN PGP MESSAGE')),
    'the inline fallback still encrypted the message',
  );
  check(
    Object.keys(inline.offloaded).length === 0,
    'no op completed on the pool, so the fallback really carried it',
  );
  // proves core entered the offload branch and recovered, rather than the
  // pool never having registered at all
  check(inline.fellBackInline, 'core logged the fallback to inline crypto');
} catch (err) {
  console.error('FAIL:', err.message);
  failed = true;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.close();
  mock.close();
}
process.exit(failed ? 1 : 0);
