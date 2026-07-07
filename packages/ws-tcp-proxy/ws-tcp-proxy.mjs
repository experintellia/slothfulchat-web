#!/usr/bin/env node
// WebSocket→TCP proxy for the slothfulchat-web wasm core.
//
//   /tcp/{ip}/{port} — raw byte tunnel to ip:port (TLS terminates in the
//                      browser wasm, the proxy only ever sees ciphertext)
//   /dns/{host}      — one JSON message with resolved IPs, then close
//
// Optional whitelist (set CHATMAIL_WHITELIST to a comma-separated list of
// chatmail domains). When set, DNS still resolves any name, but a TCP tunnel
// is only allowed to an IP that was just resolved for a whitelisted domain —
// so a hosted bridge can only reach vetted chatmail servers. Empty = allow all.
//
// ponytail: still a single inspectable file — no auth, the port + optional
// domain whitelist are the only guards. A hostile authoritative DNS server for
// a whitelisted domain could point it at an internal IP (SSRF); acceptable for
// vetted servers. Upgrade path: pin known IPs instead of trusting the resolver.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8641);
const ALLOWED_TCP_PORTS = new Set([143, 465, 587, 993]);

// Whitelist mode: empty env => allow-all (unchanged behavior).
const WHITELIST = (process.env.CHATMAIL_WHITELIST ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_TTL_MS = 10 * 60 * 1000; // temporary: resolved IPs expire after 10 min
const allowedIps = new Map(); // ip -> expiresAt (ms)

const isWhitelisted = host => {
  const h = host.toLowerCase();
  return WHITELIST.some(d => h === d || h.endsWith('.' + d));
};
const ipAllowed = ip => {
  const expires = allowedIps.get(ip);
  if (expires === undefined) return false;
  if (expires < Date.now()) {
    allowedIps.delete(ip);
    return false;
  }
  return true;
};

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const [, kind, host, port] = req.url.split('/');
  if (kind === 'dns') {
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      const ips = [...(v4.value ?? []), ...(v6.value ?? [])];
      // In whitelist mode, remember IPs resolved for a whitelisted domain so
      // the /tcp handler will let the core connect to them.
      if (WHITELIST.length && isWhitelisted(host)) {
        const expires = Date.now() + ALLOW_TTL_MS;
        for (const ip of ips) allowedIps.set(ip, expires);
      }
      ws.send(JSON.stringify(ips));
    } catch (err) {
      ws.send(JSON.stringify([]));
    }
    ws.close();
    return;
  }
  if (kind !== 'tcp' || !ALLOWED_TCP_PORTS.has(Number(port))) {
    ws.close(4003, 'forbidden');
    return;
  }
  if (WHITELIST.length && !ipAllowed(host)) {
    console.warn(`tcp ${host}:${port} blocked (not on whitelist allow-list)`);
    ws.close(4003, 'forbidden');
    return;
  }
  console.log(`tcp ${host}:${port} open`);
  const socket = connect(Number(port), host);
  socket.on('data', (data) => ws.readyState === ws.OPEN && ws.send(data));
  socket.on('close', () => ws.close());
  socket.on('error', (err) => {
    console.error(`tcp ${host}:${port}:`, err.message);
    ws.close(4004, err.code ?? 'tcp error');
  });
  ws.on('message', (data) => socket.write(data));
  ws.on('close', () => {
    console.log(`tcp ${host}:${port} closed`);
    socket.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`ws-tcp proxy on ws://localhost:${PORT}`);
  if (WHITELIST.length) console.log(`whitelist: ${WHITELIST.join(', ')}`);
});
