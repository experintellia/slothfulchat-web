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
// Only the two allowlisted-domain cases need network (nine.testrun.org); the
// bind and malformed-frame cases are offline-safe.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
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
const dns = (base, host) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/dns/${host}`);
    ws.on('message', data => resolve(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('dns closed with no reply')));
  });

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
const base = 'ws://localhost:8651';
const localBase = 'ws://localhost:8652';
let refusing = null;

try {
  await waitReady(8651, 8652, 8653);

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

  const ips = await dns(base, ALLOWLISTED);
  assert.ok(ips.length > 0, `expected resolved IPs for ${ALLOWLISTED}`);
  console.log(`resolved ${ALLOWLISTED} ->`, ips);

  const allowed = await tryTcp(base, ips[0]);
  assert.equal(allowed, 'allowed', `tunnel to resolved IP ${ips[0]} should be allowed`);

  const blocked = await tryTcp(base, '203.0.113.1'); // TEST-NET-3, never resolved
  assert.equal(blocked, 'blocked', 'tunnel to un-resolved IP should be blocked (4003)');

  console.log('OK: allowlist allows resolved chatmail IPs, blocks the rest');

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
  refusing?.kill();
}
