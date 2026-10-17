// Server-tunnel transport test: tokio-wasm-shim's net.rs reaching a mail
// server's own IMAP/SMTP tunnel (madmail's /mailtunnel) instead of the bridge.
//
// The wasm side runs for real: crates/tokio-wasm-shim/browser-test, a small
// crate around the shim, is built with wasm-pack and, in a Web Worker, does
// what core does with an IMAP/SMTP host — lookup_host, TcpStream::connect —
// then checks 300 kB come back unchanged. The other side is a stand-in for
// madmail's /mailtunnel protocol (see crates/chatmail-www/src/mail_tunnel.rs
// there) that echoes instead of dialing IMAP; madmail's own Rust tests cover
// its side against a real listener.
//
// Variants:
//  - websocket: https/wss://tunnel.test reaches the server through a local
//    CONNECT proxy; the tunnel must be a plain WebSocket one.
//  - polling: the proxy refuses every CONNECT, so the WebSocket fails, while
//    page routing serves the https requests; the shim must fall back to
//    long-polling.
//  - ip: the same over WebSocket for a madmail on a bare IP (203.0.113.7,
//    TEST-NET-3), which has a browser-trusted Let's Encrypt IP certificate when
//    installed with --auto-ip-cert.
//  - off: the beta switch is off, so tunnel.test is never probed and goes to
//    the (unset) bridge like any host without a tunnel.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const BYTES = 300_000;
const dir = mkdtempSync(join(tmpdir(), 'server-tunnel-'));

// -- the wasm harness --
const crate = fileURLToPath(new URL('../crates/tokio-wasm-shim/browser-test', import.meta.url));
execFileSync('wasm-pack', ['build', '--dev', '--target', 'web', '--out-dir', join(dir, 'pkg'), crate], {
  stdio: 'inherit',
});
const files = {
  'harness.js': readFileSync(join(dir, 'pkg/tokio_wasm_shim_browser_test.js')),
  'harness_bg.wasm': readFileSync(join(dir, 'pkg/tokio_wasm_shim_browser_test_bg.wasm')),
  'worker.js': `
    import init, { echo, set_server_tunnel } from './harness.js'
    onmessage = async ({ data: { tunnel, host, port, n } }) => {
      try {
        await init({ module_or_path: './harness_bg.wasm' })
        set_server_tunnel(tunnel)
        postMessage('OK ' + (await echo(host, port, n)))
      } catch (e) {
        postMessage('ERR ' + e)
      }
    }`,
};

// -- "madmail": the /mailtunnel protocol over https, echoing what it would relay --
const key = join(dir, 'key.pem');
const cert = join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
  '-days', '1', '-subj', '/CN=tunnel.test', '-addext', 'subjectAltName=DNS:tunnel.test,IP:203.0.113.7'],
  { stdio: 'ignore' });
const https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) });
const sessions = []; // the transport of each tunnel opened
const polls = new Map(); // id → { queue: Buffer[], wake }
const readBody = req =>
  new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
https.on('request', async (req, res) => {
  const send = (status, body = '', type = 'text/plain') => {
    res.writeHead(status, { 'access-control-allow-origin': '*', 'content-type': type });
    res.end(body);
  };
  const { pathname } = new URL(req.url, 'https://x');
  if (req.method === 'GET' && pathname === '/mailtunnel') return send(200, 'mailtunnel 1');
  if (req.method === 'POST' && /^\/mailtunnel\/\d+$/.test(pathname)) {
    const id = randomBytes(16).toString('hex');
    polls.set(id, { queue: [], wake: () => {} });
    sessions.push('polling');
    return send(200, id);
  }
  const m = pathname.match(/^\/mailtunnel\/poll\/([0-9a-f]{32})(\/close)?$/);
  const poll = m && polls.get(m[1]);
  if (!poll) return send(404);
  if (m[2]) {
    polls.delete(m[1]);
    poll.wake();
    return send(204);
  }
  if (req.method === 'POST') {
    poll.queue.push(await readBody(req)); // the echo
    poll.wake();
    return send(204);
  }
  if (!poll.queue.length) await new Promise(r => ((poll.wake = r), setTimeout(r, 25_000)));
  if (!polls.has(m[1])) return send(404);
  send(200, Buffer.concat(poll.queue.splice(0)), 'application/octet-stream');
});
const wss = new WebSocketServer({ noServer: true });
https.on('upgrade', (req, socket, head) => {
  if (!/^\/mailtunnel\/\d+$/.test(new URL(req.url, 'https://x').pathname)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    sessions.push('websocket');
    ws.on('message', (data, binary) => (binary ? ws.send(data) : ws.close()));
  });
});
await new Promise(r => https.listen(0, '127.0.0.1', r));
const httpsPort = https.address().port;

// -- CONNECT proxy: the browser's only way to tunnel.test --
let allowConnect = true;
const proxy = createServer().on('connect', (req, client, head) => {
  const known = req.url === 'tunnel.test:443' || req.url === '203.0.113.7:443';
  if (!allowConnect || !known) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const up = connect(httpsPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    up.write(head);
    up.pipe(client).pipe(up);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));

// polling mode: the browser's https requests to tunnel.test, delivered by
// hand (route.fetch would go through the proxy, which refuses everything then)
const forward = route =>
  new Promise((resolve, reject) => {
    const q = route.request();
    const { pathname, search } = new URL(q.url());
    const req = httpsRequest(
      { host: '127.0.0.1', port: httpsPort, path: pathname + search, method: q.method(), headers: q.headers(),
        ca: readFileSync(cert), servername: 'tunnel.test' },
      res => {
        const body = [];
        res.on('data', c => body.push(c));
        res.on('end', () =>
          resolve(route.fulfill({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body) })));
      },
    );
    req.on('error', reject);
    req.end(q.postDataBuffer() ?? undefined);
  }).catch(() => route.abort().catch(() => {}));

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
  proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
  args: ['--ignore-certificate-errors'],
});
async function run(mode) {
  allowConnect = mode !== 'polling';
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('https://app.test/**', r => {
    const name = new URL(r.request().url()).pathname.slice(1);
    if (!name) return r.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    return r.fulfill({ contentType: type, body: files[name] });
  });
  if (mode === 'polling') await ctx.route('https://tunnel.test/**', forward);
  const page = await ctx.newPage();
  await page.goto('https://app.test/');
  const before = sessions.length;
  const out = await page.evaluate(
    args =>
      new Promise(resolve => {
        const w = new Worker('/worker.js', { type: 'module' });
        w.onmessage = e => resolve(e.data);
        w.onerror = e => resolve('ERR worker ' + e.message);
        w.postMessage(args);
      }),
    { tunnel: mode !== 'off', host: mode === 'ip' ? '203.0.113.7' : 'tunnel.test', port: 993, n: BYTES },
  );
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
  await ctx.close();
  return { out, transports: sessions.slice(before) };
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
};
for (const mode of ['websocket', 'polling', 'ip']) {
  const { out, transports } = await run(mode);
  // 198.18.x.x: the synthetic address the shim hands core for a tunneled host
  const echoed = out.startsWith('OK 198.1') && out.endsWith(`echoed ${BYTES} bytes`);
  const expected = mode === 'polling' ? 'polling' : 'websocket';
  check(mode, echoed && transports.join() === expected, `${out} | sessions: ${transports.join() || 'none'}`);
}
const off = await run('off');
check('off', off.out.includes('no WebSocket proxy configured') && off.transports.length === 0,
  `${off.out} | sessions: ${off.transports.join() || 'none'}`);

await browser.close();
proxy.close();
wss.close();
https.close();
if (failures.length) {
  console.error(`server tunnel: ${failures.length} variant(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('server tunnel: all variants passed');
