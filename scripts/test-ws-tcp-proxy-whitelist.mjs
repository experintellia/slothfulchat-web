// Self-check for the CHATMAIL_WHITELIST guard in the WS→TCP proxy.
//   allowed:  DNS for a whitelisted domain populates the IP allow-list, and a
//             TCP tunnel to one of those IPs is accepted.
//   blocked:  a TCP tunnel to an IP that was never resolved is refused (4003).
// Needs network (resolves nine.testrun.org), like the other networking suites.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 8651;
const WHITELISTED = 'nine.testrun.org';
const proxyPath = fileURLToPath(
  new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)
);

const proxy = fork(proxyPath, [], {
  env: { ...process.env, PORT: String(PORT), CHATMAIL_WHITELIST: WHITELISTED },
  stdio: 'inherit',
});
const base = `ws://localhost:${PORT}`;

// Resolve a name via /dns/{host}; returns the JSON array of IPs, then closes.
const dns = host =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/dns/${host}`);
    ws.on('message', data => resolve(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('dns closed with no reply')));
  });

// Try a /tcp/{ip}/{port} tunnel; resolves 'allowed' if the socket opens and
// stays open, or 'blocked' if the proxy closes it with 4003.
const tryTcp = (ip, port = 993) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/tcp/${ip}/${port}`);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      setTimeout(() => {
        resolve('allowed');
        ws.close();
      }, 500);
    });
    ws.on('close', code => {
      if (code === 4003) resolve('blocked');
      else if (!opened) reject(new Error(`unexpected close ${code}`));
    });
    ws.on('error', () => {}); // close event carries the verdict
  });

const waitReady = () =>
  new Promise(r => setTimeout(r, 400)); // give the proxy a moment to listen

try {
  await waitReady();

  const ips = await dns(WHITELISTED);
  assert.ok(ips.length > 0, `expected resolved IPs for ${WHITELISTED}`);
  console.log(`resolved ${WHITELISTED} ->`, ips);

  const allowed = await tryTcp(ips[0]);
  assert.equal(allowed, 'allowed', `tunnel to resolved IP ${ips[0]} should be allowed`);

  const blocked = await tryTcp('203.0.113.1'); // TEST-NET-3, never resolved
  assert.equal(blocked, 'blocked', 'tunnel to un-resolved IP should be blocked (4003)');

  console.log('OK: whitelist allows resolved chatmail IPs, blocks the rest');
  process.exitCode = 0;
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  proxy.kill();
}
