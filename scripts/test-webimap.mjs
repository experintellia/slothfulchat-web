// webimap end-to-end test — runs FULLY OFFLINE, no relay, no WS-TCP proxy.
//
// What it proves: the "webimap" transport talks plain HTTP(S) to a madmail
// server directly from inside the wasm core (browser fetch, no bridge). We
// stand up a MOCK madmail server in this node process and drive two accounts
// (alice, bob) that each:
//   - POST /new to provision themselves (core does this during
//     addTransportFromQr, hence CORS + preflight handling below is load-bearing)
//   - long-poll GET /webimap/messages, GET /webimap/message/<uid>,
//     DELETE /webimap/message/<uid> (delete-after-receive), POST /webimap/send
// Then alice→bob and bob→alice text messages must round-trip through the mock,
// asserting both send and receive work in both directions with NO proxy param.
//
// Requires packages/core-wasm to be BUILT first (wasm + ts), exactly like
// scripts/test-networking.mjs:  the browser loads packages/core-wasm/dist and
// packages/core-wasm/example/index.html served over a local static server.
//
// Run:  node scripts/test-webimap.mjs        (VERBOSE=1 for full page logs)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// MOCK madmail server (in-process, 127.0.0.1, random free port)
// ---------------------------------------------------------------------------
// users: email -> { password, nextUid, msgs: Map<uid, rawString>, waiters: [] }
const users = new Map();
const counters = { newCalls: 0, sendCalls: 0, deleteCalls: 0, phantom404Gets: 0, delete404s: 0 };
let userSeq = 0;

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

// message metadata shape the transport expects (body only on the single-message route)
const meta = (uid, raw) => ({
  uid,
  seq_num: uid,
  flags: [],
  size: Buffer.byteLength(raw),
  date: new Date().toISOString(),
  envelope: {},
});

// respond to a /webimap/messages request with everything newer than sinceUid
const respondMessages = (res, user, sinceUid) => {
  const out = [];
  if (user.phantomOnce !== undefined) {
    out.push(meta(user.phantomOnce, ''));
    user.phantomOnce = undefined;
  }
  for (const [uid, raw] of user.msgs) if (uid > sinceUid) out.push(meta(uid, raw));
  json(res, 200, out);
};

const mock = createServer(async (req, res) => {
  // CORS on EVERY response — browser preflights the custom auth headers.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;

  // -- provisioning -------------------------------------------------------
  if (req.method === 'POST' && path === '/new') {
    counters.newCalls++;
    const email = `u${++userSeq}@webimap.example`;
    const password = randomBytes(9).toString('hex');
    // 404-tolerance probes (core must skip these, not back off — see core
    // patch "webimap: treat 404 on GET/DELETE as already-gone"):
    // a phantom UID listed once but gone on GET, and one DELETE answered 404
    // although the message IS deleted (late-landing-delete shape).
    users.set(email, {
      password,
      nextUid: 2,
      msgs: new Map(),
      waiters: [],
      phantomOnce: 1,
      delete404Once: true,
    });
    json(res, 200, { email, password, dclogin_url: '' });
    return;
  }

  // -- everything under /webimap requires valid auth ----------------------
  if (path.startsWith('/webimap/')) {
    const email = req.headers['x-email'];
    const password = req.headers['x-password'];
    const user = email && users.get(email);
    if (!user || user.password !== password) {
      json(res, 401, { error: 'bad credentials' });
      return;
    }

    // configure/verify hits this during addTransportFromQr
    if (req.method === 'GET' && path === '/webimap/mailboxes') {
      const n = user.msgs.size;
      json(res, 200, [{ name: 'INBOX', messages: n, unseen: n }]);
      return;
    }

    // long-pollable fetch of new messages
    if (req.method === 'GET' && path === '/webimap/messages') {
      const sinceUid = Number(url.searchParams.get('since_uid') ?? '0') || 0;
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 120);
      const hasNew = [...user.msgs.keys()].some((uid) => uid > sinceUid);
      if (hasNew || wait <= 0) {
        respondMessages(res, user, sinceUid);
        return;
      }
      // park until a message arrives for this user or `wait` seconds elapse
      const waiter = {
        sinceUid,
        timer: setTimeout(() => {
          user.waiters = user.waiters.filter((w) => w !== waiter);
          respondMessages(res, user, sinceUid);
        }, wait * 1000),
        respond: () => respondMessages(res, user, sinceUid),
      };
      user.waiters.push(waiter);
      return;
    }

    // single message (with body) / delete
    const m = path.match(/^\/webimap\/message\/(\d+)$/);
    if (m) {
      const uid = Number(m[1]);
      if (req.method === 'GET') {
        const raw = user.msgs.get(uid);
        if (raw === undefined) {
          counters.phantom404Gets++;
          json(res, 404, { error: 'no such message' });
          return;
        }
        json(res, 200, { ...meta(uid, raw), body: raw });
        return;
      }
      if (req.method === 'DELETE') {
        counters.deleteCalls++;
        user.msgs.delete(uid);
        if (user.delete404Once) {
          user.delete404Once = false;
          counters.delete404s++;
          json(res, 404, { error: 'no such message' });
          return;
        }
        json(res, 200, { status: 'ok' });
        return;
      }
    }

    // send: append body to every locally-known recipient, wake their pollers
    if (req.method === 'POST' && path === '/webimap/send') {
      counters.sendCalls++;
      let payload = {};
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        /* tolerate — treat as empty */
      }
      const recipients = []
        .concat(payload.to ?? [])
        .flatMap((r) => (typeof r === 'string' ? r.split(/[,\s]+/) : []))
        .map((r) => r.trim())
        .filter(Boolean);
      const body = payload.body ?? '';
      for (const rcpt of recipients) {
        const dest = users.get(rcpt);
        if (!dest) continue; // unknown domain / external recipient: silently accept
        const uid = dest.nextUid++;
        dest.msgs.set(uid, body);
        const waiters = dest.waiters;
        dest.waiters = [];
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.respond();
        }
      }
      json(res, 200, { status: 'sent' });
      return;
    }
  }

  json(res, 404, { error: 'not found' });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
console.log(`mock madmail server on 127.0.0.1:${mockPort} (no proxy, fully offline)`);

// ---------------------------------------------------------------------------
// static server for the built core-wasm example (same approach as test-networking.mjs)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage();
const verbose = !!process.env.VERBOSE;
page.on('console', (m) => {
  const t = m.text();
  if (verbose || /error|warn|panic|failed|Failed/i.test(t)) console.log('[page]', t.slice(0, 500));
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

let failed = false;
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min) — test hung');
  process.exit(1);
}, 360_000);
try {
  // NOTE: no proxy param — webimap needs no bridge, that is the whole point.
  await page.goto(`http://localhost:${port}/example/index.html?persist=0`);
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 60_000 });
  console.log('core booted, provisioning two webimap accounts against the mock…');

  const result = await page.evaluate(
    async ({ qr }) => {
      const rpc = window.dc.rpc;
      window.dc.on('Info', (c, ev) => console.log('[core]', ev.msg));
      window.dc.on('Warning', (c, ev) => console.warn('[core warn]', ev.msg));
      window.dc.on('Error', (c, ev) => console.error('[core err]', ev.msg));

      // addTransportFromQr provisions (POST /new) + configures (GET /webimap/mailboxes)
      const setup = async () => {
        const id = await rpc.addAccount();
        await rpc.addTransportFromQr(id, qr);
        await rpc.startIo(id);
        return id;
      };
      const aliceId = await setup();
      const bobId = await setup();

      const addrOf = async (id) =>
        (await rpc.getConfig(id, 'configured_addr')) ?? (await rpc.getConfig(id, 'addr'));
      const bobAddr = await addrOf(bobId);
      const aliceAddr = await addrOf(aliceId);

      // arm receive listeners before sending (event-driven, like test-networking.mjs)
      const waitIncoming = (wantId, marker) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timeout waiting for "${marker}" on account ${wantId}`)),
            120_000,
          );
          window.dc.on('IncomingMsg', async (contextId, event) => {
            if (contextId !== wantId) return;
            const msg = await rpc.getMessage(wantId, event.msgId);
            if (msg.text && msg.text.includes(marker)) {
              clearTimeout(timer);
              resolve({ chatId: event.chatId, text: msg.text });
            }
          });
        });

      // --- alice -> bob ---
      const toBob = 'webimap-a2b-' + Math.random().toString(36).slice(2);
      const bobGot = waitIncoming(bobId, toBob);
      // webimap accounts are chatmail-style (e2ee required): hand alice
      // bob's public key via vcard first (1 = ContactId::SELF), exactly
      // like test-networking.mjs does for chatmail relays.
      const vcard = await rpc.makeVcard(bobId, [1]);
      const [contactId] = await rpc.importVcardContents(aliceId, vcard);
      const aliceChatId = await rpc.createChatByContactId(aliceId, contactId);
      await rpc.miscSendTextMessage(aliceId, aliceChatId, toBob);
      const bobIn = await bobGot;

      // --- bob -> alice (reply in the chat the message arrived on) ---
      await rpc.acceptChat(bobId, bobIn.chatId);
      const toAlice = 'webimap-b2a-' + Math.random().toString(36).slice(2);
      const aliceGot = waitIncoming(aliceId, toAlice);
      await rpc.miscSendTextMessage(bobId, bobIn.chatId, toAlice);
      const aliceIn = await aliceGot;

      return {
        aliceAddr,
        bobAddr,
        toBob,
        toAlice,
        bobReceived: bobIn.text,
        aliceReceived: aliceIn.text,
      };
    },
    { qr: `webimapaccount:localhost:${mockPort}` },
  );

  // ---- assertions ----
  const problems = [];
  if (!result.bobReceived.includes(result.toBob))
    problems.push(`bob got "${result.bobReceived}", expected to contain "${result.toBob}"`);
  if (!result.aliceReceived.includes(result.toAlice))
    problems.push(`alice got "${result.aliceReceived}", expected to contain "${result.toAlice}"`);
  if (counters.newCalls < 2)
    problems.push(`expected >=2 POST /new (one per account), saw ${counters.newCalls}`);
  if (counters.sendCalls < 2)
    problems.push(`expected >=2 POST /webimap/send, saw ${counters.sendCalls}`);
  if (counters.deleteCalls < 1)
    problems.push(`expected >=1 DELETE (delete-after-receive), saw ${counters.deleteCalls}`);
  if (counters.phantom404Gets < 2)
    problems.push(`expected both accounts to hit the phantom 404 GET, saw ${counters.phantom404Gets}`);
  if (counters.delete404s < 2)
    problems.push(`expected both accounts to survive a 404 DELETE, saw ${counters.delete404s}`);

  if (problems.length) {
    console.error('FAIL:\n  - ' + problems.join('\n  - '));
    failed = true;
  } else {
    console.log(
      `PASS: webimap round-trip fully offline (no proxy).\n` +
        `  accounts: ${result.aliceAddr} <-> ${result.bobAddr}\n` +
        `  alice->bob: "${result.toBob}" received by bob\n` +
        `  bob->alice: "${result.toAlice}" received by alice\n` +
        `  mock saw: ${counters.newCalls} /new, ${counters.sendCalls} sends, ${counters.deleteCalls} deletes\n` +
        `  404 tolerance: ${counters.phantom404Gets} phantom GETs skipped, ${counters.delete404s} 404-DELETEs survived`,
    );
  }
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
