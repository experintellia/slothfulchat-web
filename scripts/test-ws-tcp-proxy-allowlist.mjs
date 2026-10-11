// Self-check for the CHATMAIL_ALLOWLIST guard in the WS→TCP proxy, plus the
// two hardening guards around it:
//   allowed:  DNS for a allowlisted domain populates the IP allow-list, and a
//             TCP tunnel to one of those IPs is accepted.
//   blocked:  a TCP tunnel to an IP that was never resolved is refused (4003).
//   localhost: /dns/localhost always gets a hardcoded loopback reply (health
//             check), but the loopback IPs only reach /tcp when 'localhost' is
//             explicitly on the allowlist.
//   bind:     default bind is loopback-only (not reachable on a LAN address),
//             and a non-loopback HOST with an empty allowlist refuses to start.
//   frames:   a malformed (unmasked) client frame kills only that connection,
//             not the whole bridge.
//   scoping:  one client resolving an allowlisted domain does NOT authorize
//             that IP for a different client.
//   limits:   per-client and global connection caps, the per-client
//             new-connections-per-minute limit, the frame-size cap and the
//             connect deadline.
//   pressure: neither direction of a tunnel buffers without bound when its peer
//             stops reading (the tcp→ws half needs a backend on a privileged
//             port and is skipped where that can't be bound).
// Only the two allowlisted-domain cases need network (nine.testrun.org); every
// other case here is offline-safe (the limit cases dial 203.0.113.1, TEST-NET-3,
// which nothing answers). Set ALLOWLIST_NET=0 to skip those two (what CI does —
// a gate that goes red when a third-party relay is down is worse than no gate).
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const ALLOWLISTED = 'nine.testrun.org';
const proxyPath = fileURLToPath(
  new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)
);

// HOST: '' is the loopback default (the proxy reads an empty HOST as unset), so
// a HOST inherited from the caller's environment can't move the bind under us.
const startProxy = (port, allowlist, env = {}) =>
  fork(proxyPath, [], {
    env: { ...process.env, PORT: String(port), CHATMAIL_ALLOWLIST: allowlist, HOST: '', ...env },
    stdio: 'inherit',
  });

// Resolve a name via /dns/{host}; returns the JSON array of IPs, then closes.
// `as` sets X-Forwarded-For, which only counts on a TRUST_PROXY=1 bridge — it
// is how this test plays two different clients from one machine.
const dns = (base, host, as) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/dns/${host}`, as ? { headers: { 'x-forwarded-for': as } } : {});
    ws.on('message', data => resolve(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('close', code => reject(new Error(`dns closed with no reply (${code})`)));
  });

// Open a /tcp tunnel and *keep* it open (unlike tryTcp, which closes it).
// Resolves 'open' if nothing happens for 400 ms, else the close code.
const openTunnel = (base, { as, ip = '203.0.113.1', port = 993 } = {}) => {
  const ws = new WebSocket(`${base}/tcp/${ip}/${port}`, as ? { headers: { 'x-forwarded-for': as } } : {});
  ws.on('error', () => {}); // the close code carries the verdict
  const verdict = new Promise(resolve => {
    const t = setTimeout(() => resolve('open'), 400);
    ws.on('close', code => (clearTimeout(t), resolve(code)));
  });
  return { ws, verdict };
};

// Try a /tcp/{ip}/{port} tunnel. Resolves 'allowed' if the socket opens and
// stays open, 'blocked' if the allowlist guard refuses it (4003), or
// 'passed-guard' if it got past the guard but the connection itself failed
// (any other close before open, e.g. ECONNREFUSED with no local listener).
const tryTcp = (base, ip, port = 993) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/tcp/${ip}/${port}`);
    let opened = false;
    let timer;
    ws.on('open', () => {
      opened = true;
      // The WS upgrade completes before the proxy dials the backend, so 'open'
      // fires either way. If nothing closes it within 500ms the tunnel is live.
      timer = setTimeout(() => {
        resolve('allowed');
        ws.close();
      }, 500);
    });
    ws.on('close', code => {
      clearTimeout(timer);
      // 4003 = allowlist guard refused it. Any other close after 'open' means it
      // got past the guard but the backend connection itself failed (e.g. 4004
      // ECONNREFUSED with no local listener).
      if (code === 4003) resolve('blocked');
      else if (opened) resolve('passed-guard');
      else reject(new Error(`proxy unreachable: close ${code}`));
    });
    ws.on('error', () => {}); // close event carries the verdict
  });

// Is anything listening on host:port? 'open' / 'closed' (refused) / 'timeout'
// (a filtered LAN address counts as unreachable too).
const probe = (host, port) =>
  new Promise(resolve => {
    const sock = connect({ host, port, timeout: 1000 });
    sock.on('connect', () => (sock.destroy(), resolve('open')));
    sock.on('timeout', () => (sock.destroy(), resolve('timeout')));
    sock.on('error', () => resolve('closed'));
  });

// Complete a real handshake, then send an *unmasked* client frame — RFC 6455
// requires client→server frames to be masked, so ws rejects it with
// WS_ERR_EXPECTED_MASK. Written in the same packet as the handshake on purpose:
// the bad frame then arrives while the connection handler is still suspended in
// its DNS await, the exact window an 'error' listener has to already cover.
// Resolves with the status line, so the caller can assert the handshake was
// valid and the kill really came from the frame.
const sendUnmaskedFrame = (port, path) =>
  new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(Buffer.concat([
        Buffer.from(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          'Connection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n', 'latin1'),
        Buffer.from([0x81, 0x00]), // FIN + text, length 0, MASK bit clear
      ]));
    });
    const seen = [];
    sock.on('data', c => seen.push(c));
    sock.on('close', () => resolve(Buffer.concat(seen).toString('latin1').split('\r\n')[0]));
    sock.on('error', reject);
    setTimeout(() => sock.destroy(), 1000).unref();
  });

// Wait until every forked proxy actually listens (a fixed sleep raced the
// startup of three of them on a loaded machine).
const waitReady = async (...ports) => {
  for (let i = 0; i < 100; i++) {
    const up = await Promise.all(ports.map(p => probe('127.0.0.1', p)));
    if (up.every(r => r === 'open')) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`proxies never started listening on ${ports.join(', ')}`);
};

const proxy = startProxy(8651, ALLOWLISTED);
const localProxy = startProxy(8652, `${ALLOWLISTED},localhost`);
const bindProxy = startProxy(8653, ''); // no allowlist: the local-dev default
// TRUST_PROXY=1 makes the bridge take X-Forwarded-For as the client identity,
// which is how one test machine plays several clients. Tight caps so the limits
// trip in a handful of connections instead of hundreds.
const scopedProxy = startProxy(8671, 'localhost', { TRUST_PROXY: '1' });
const capProxy = startProxy(8672, '', {
  TRUST_PROXY: '1', MAX_CONNECTIONS: '3', MAX_CONNECTIONS_PER_IP: '2',
});
const dlProxy = startProxy(8673, '', { TRUST_PROXY: '1', TUNNEL_CONNECT_MS: '200' });
const base = 'ws://localhost:8651';
const localBase = 'ws://localhost:8652';
const scopedBase = 'ws://localhost:8671';
const capBase = 'ws://localhost:8672';
const dlBase = 'ws://localhost:8673';
const settle = () => new Promise(r => setTimeout(r, 200)); // let a close reach the server
let refusing = null;
let backend = null; // the tcp→ws backpressure check's fake mail server
let backendSock = null;

try {
  await waitReady(8651, 8652, 8653, 8671, 8672, 8673);

  // localhost is answered from a hardcoded loopback reply so the web app's
  // bridge-reachability health check works even under an allowlist.
  const local = await dns(base, 'localhost');
  assert.deepEqual(local, ['127.0.0.1', '::1'], 'localhost should get a hardcoded loopback reply');
  console.log('resolved localhost ->', local);

  // ...but that hardcoded reply must NOT open the allowlist unless localhost is
  // on it: a tunnel to loopback stays blocked (4003) here.
  const localBlocked = await tryTcp(base, '127.0.0.1');
  assert.equal(localBlocked, 'blocked', 'tunnel to localhost must stay blocked when localhost is not allowlisted');

  // When 'localhost' IS explicitly allowlisted, resolving it (as the health
  // check does) populates the IP allow-list, so the loopback IPs then get past
  // the guard (no 4003) — the tunnel fails only because nothing is listening.
  await dns(localBase, 'localhost');
  const localAllowed = await tryTcp(localBase, '127.0.0.1');
  assert.notEqual(localAllowed, 'blocked', 'tunnel to localhost must be allowed when localhost is allowlisted');
  console.log(`tunnel to localhost with localhost allowlisted -> ${localAllowed} (not blocked)`);

  // The only cases that reach the internet: resolving the allowlisted domain
  // and dialing one of the IPs that came back.
  if (process.env.ALLOWLIST_NET === '0') {
    console.log(`(ALLOWLIST_NET=0: skipped the ${ALLOWLISTED} resolve + tunnel cases)`);
  } else {
    const ips = await dns(base, ALLOWLISTED);
    assert.ok(ips.length > 0, `expected resolved IPs for ${ALLOWLISTED}`);
    console.log(`resolved ${ALLOWLISTED} ->`, ips);

    const allowed = await tryTcp(base, ips[0]);
    assert.equal(allowed, 'allowed', `tunnel to resolved IP ${ips[0]} should be allowed`);
    console.log('OK: allowlist allows resolved chatmail IPs');
  }

  const blocked = await tryTcp(base, '203.0.113.1'); // TEST-NET-3, never resolved
  assert.equal(blocked, 'blocked', 'tunnel to un-resolved IP should be blocked (4003)');
  console.log('OK: allowlist blocks IPs that were never resolved');

  // A malformed frame must kill only its own connection. Without a per-
  // connection 'error' listener, ws throws WS_ERR_EXPECTED_MASK out of the
  // process and every other user's transport dies with it.
  const status = await sendUnmaskedFrame(8651, '/dns/frame-check.invalid');
  assert.match(status, /^HTTP\/1\.1 101 /, `handshake should have succeeded, got: ${status}`);
  assert.equal(proxy.exitCode, null, 'an unmasked client frame must not kill the bridge');
  assert.equal(proxy.signalCode, null, 'an unmasked client frame must not kill the bridge');
  assert.deepEqual(
    await dns(base, 'localhost'),
    ['127.0.0.1', '::1'],
    'the bridge must still accept connections after a malformed frame'
  );
  console.log('OK: malformed frame closed one connection, bridge still serving');

  // Authorization is per client, not global. One client resolving an
  // allowlisted domain must not open that IP for everybody else — allowlisted
  // domains share addresses with unrelated services often enough.
  const [A, B] = ['203.0.113.10', '203.0.113.11'];
  await dns(scopedBase, 'localhost', A);
  const forA = await openTunnel(scopedBase, { as: A, ip: '127.0.0.1' }).verdict;
  assert.notEqual(forA, 4003, 'the client that resolved localhost must get past the guard');
  const forB = await openTunnel(scopedBase, { as: B, ip: '127.0.0.1' }).verdict;
  assert.equal(forB, 4003, "one client's DNS lookup must not authorize that IP for another client");
  console.log('OK: resolved-IP authorization is scoped to the client that resolved it');

  // Frame-size cap: ws defaults to 100 MiB per frame; IMAP/SMTP needs nothing
  // like it, and an oversized frame must be refused (1009), not allocated.
  const big = new WebSocket(`${capBase}/tcp/203.0.113.1/993`, {
    headers: { 'x-forwarded-for': '203.0.113.30' },
  });
  big.on('error', () => {});
  const oversize = await new Promise(resolve => {
    big.on('open', () => big.send(Buffer.alloc(512 * 1024)));
    big.on('close', resolve);
  });
  assert.equal(oversize, 1009, 'an oversized frame must be refused (1009 too big)');
  await settle();
  console.log('OK: oversized frame refused');

  // Connection caps: two per client, three for the whole bridge (both set on
  // this bridge). The tunnels dial TEST-NET-3, which nothing answers, so they
  // stay in 'connecting' — open as far as the caps are concerned.
  const [C, D] = ['203.0.113.20', '203.0.113.21'];
  const t1 = openTunnel(capBase, { as: C });
  const t2 = openTunnel(capBase, { as: C });
  assert.equal(await t1.verdict, 'open');
  assert.equal(await t2.verdict, 'open');
  assert.equal(await openTunnel(capBase, { as: C }).verdict, 1013,
    'a third tunnel from the same client must be refused');
  await settle();
  const t4 = openTunnel(capBase, { as: D });
  assert.equal(await t4.verdict, 'open', 'the per-client cap must not apply to a different client');
  assert.equal(await openTunnel(capBase, { as: D }).verdict, 1013,
    'the global cap must refuse a fourth tunnel even from a client under its own cap');
  await settle();
  t1.ws.close();
  await settle();
  const t6 = openTunnel(capBase, { as: C });
  assert.equal(await t6.verdict, 'open', 'closing a tunnel must free its slot again');
  for (const t of [t2, t4, t6]) t.ws.close();
  console.log('OK: per-client and global connection caps hold, and release');

  // Dial deadline: a tunnel to an address that never answers must be closed,
  // not left hanging (4004 = the backend connection failed).
  const dialStart = Date.now();
  assert.equal(await openTunnel(dlBase, { as: '203.0.113.40' }).verdict, 4004,
    'a tunnel that never connects must be closed by the dial deadline');
  assert.ok(Date.now() - dialStart < 2000, 'the dial deadline must fire promptly');
  console.log('OK: dial deadline closes a tunnel that never connects');

  // Per-client connection rate limit (120/min): a reconnect storm from one
  // client must be refused rather than served.
  let limitedAt = null;
  for (let i = 1; i <= 130 && limitedAt === null; i++) {
    const code = await new Promise(resolve => {
      const ws = new WebSocket(`${dlBase}/dns/localhost`, {
        headers: { 'x-forwarded-for': '203.0.113.41' },
      });
      ws.on('error', () => {});
      ws.on('close', resolve);
    });
    if (code === 1013) limitedAt = i;
  }
  assert.ok(limitedAt !== null, 'the per-client connection rate limit must kick in');
  console.log(`OK: per-client rate limit refused connection #${limitedAt}`);

  // Backpressure ws→tcp. The tunnel's TCP side never connects, so nothing we
  // send can leave the bridge. With backpressure the bridge stops reading from
  // the WebSocket once its socket buffer is full, which shows up here as our
  // own send queue staying full; without it, the bridge swallows every byte
  // into its own memory and our queue drains to nothing.
  const flood = new WebSocket(`${capBase}/tcp/203.0.113.1/993`, {
    headers: { 'x-forwarded-for': '203.0.113.50' },
  });
  flood.on('error', () => {});
  await new Promise(r => flood.on('open', r));
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 256; i++) flood.send(chunk); // 16 MB
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(
    flood.bufferedAmount > 4 * 1024 * 1024,
    `the bridge must stop reading a flood it cannot forward (queue drained to ${flood.bufferedAmount})`
  );
  flood.terminate();
  await settle();
  console.log('OK: ws→tcp backpressure holds the sender back');

  // Backpressure tcp→ws (and the resume that follows). Needs a backend on one
  // of the allowed ports — all privileged, so this half only runs where 993 can
  // be bound.
  let backendSent = 0;
  backend = createServer(sock => {
    backendSock = sock;
    const buf = Buffer.alloc(64 * 1024);
    const pump = () => {
      // stop far above the backpressure mark, so a bridge that ignores it hits
      // the ceiling quickly instead of buffering itself to death
      while (backendSent < 64 * 1024 * 1024 && sock.write(buf)) backendSent += buf.length;
    };
    sock.on('drain', pump);
    sock.on('error', () => {});
    pump();
  });
  const bound = await new Promise(r => {
    backend.once('error', () => r(false));
    backend.listen(993, '127.0.0.1', () => r(true));
  });
  if (bound) {
    const slow = new WebSocket(`${capBase}/tcp/127.0.0.1/993`, {
      headers: { 'x-forwarded-for': '203.0.113.51' },
    });
    slow.on('error', () => {});
    slow.on('message', () => {});
    await new Promise(r => slow.on('open', r));
    slow.pause(); // a client that stopped reading
    await new Promise(r => setTimeout(r, 1000));
    // The ceiling is what the kernel's own socket buffers hold plus the
    // bridge's 1 MB mark — single-digit MB. A bridge without backpressure runs
    // straight to the backend's 64 MB ceiling instead.
    const whilePaused = backendSent;
    assert.ok(
      whilePaused < 32 * 1024 * 1024,
      `the bridge must stop reading the backend for a paused client (relayed ${whilePaused} bytes)`
    );
    slow.resume();
    await new Promise(r => setTimeout(r, 500));
    assert.ok(backendSent > whilePaused, 'the bridge must resume reading once the client drains');
    slow.terminate();
    console.log('OK: tcp→ws backpressure pauses the backend, and resumes it');
  } else {
    console.log('(cannot bind port 993 here, skipped the tcp→ws backpressure check)');
  }
  await settle();

  // Default bind is loopback-only: an allow-all bridge must not be an open
  // relay for the whole network just by being started.
  assert.deepEqual(await dns('ws://127.0.0.1:8653', 'localhost'), ['127.0.0.1', '::1']);
  const lan = Object.values(networkInterfaces()).flat()
    .find(n => n && !n.internal && n.family === 'IPv4');
  if (lan) {
    assert.notEqual(
      await probe(lan.address, 8653), 'open',
      `default bind must not listen on the LAN address ${lan.address}`
    );
    console.log(`OK: default bind is loopback-only (${lan.address}:8653 unreachable)`);
  } else {
    console.log('(no non-loopback interface here, skipped the LAN-reachability probe)');
  }

  // ...and the one dangerous combination refuses to start at all.
  refusing = startProxy(8654, '', { HOST: '0.0.0.0' });
  const exit = await Promise.race([
    new Promise(r => refusing.on('exit', code => r(code))),
    new Promise(r => setTimeout(() => r('still running'), 3000)),
  ]);
  assert.equal(exit, 1, 'a non-loopback HOST with an empty allowlist must refuse to start');
  console.log('OK: HOST=0.0.0.0 without an allowlist refuses to start');

  process.exitCode = 0;
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  proxy.kill();
  localProxy.kill();
  bindProxy.kill();
  backendSock?.destroy();
  backend?.close();
  scopedProxy.kill();
  capProxy.kill();
  dlProxy.kill();
  refusing?.kill();
}
