// Self-check for the CHATMAIL_ALLOWLIST guard in the WS→TCP proxy.
//   allowed:  DNS for a allowlisted domain populates the IP allow-list, and a
//             TCP tunnel to one of those IPs is accepted.
//   blocked:  a TCP tunnel to an IP that was never resolved is refused (4003).
//   localhost: /dns/localhost always gets a hardcoded loopback reply (health
//             check), but the loopback IPs only reach /tcp when 'localhost' is
//             explicitly on the allowlist.
// Needs network (resolves nine.testrun.org), like the other networking suites.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const ALLOWLISTED = 'nine.testrun.org';
const proxyPath = fileURLToPath(
  new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)
);

const startProxy = (port, allowlist) =>
  fork(proxyPath, [], {
    env: { ...process.env, PORT: String(port), CHATMAIL_ALLOWLIST: allowlist },
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

const waitReady = () =>
  new Promise(r => setTimeout(r, 400)); // give the proxy a moment to listen

const proxy = startProxy(8651, ALLOWLISTED);
const localProxy = startProxy(8652, `${ALLOWLISTED},localhost`);
const base = 'ws://localhost:8651';
const localBase = 'ws://localhost:8652';

try {
  await waitReady();

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
  process.exitCode = 0;
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  proxy.kill();
  localProxy.kill();
}
