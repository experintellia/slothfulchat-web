#!/usr/bin/env node
// WebSocket→TCP proxy for the slothfulchat-web wasm core.
//
//   /tcp/{ip}/{port} — raw byte tunnel to ip:port (TLS terminates in the
//                      browser wasm, the proxy only ever sees ciphertext)
//   /dns/{host}      — one JSON message with resolved IPs, then close.
//                      /dns/localhost is always answered with the loopback IPs
//                      (never the resolver) so the webapp's bridge-reachability
//                      health check works everywhere, allowlist or not.
//
// Optional allowlist (set CHATMAIL_ALLOWLIST to a comma-separated list of
// chatmail domains). When set, DNS still resolves any name, but a TCP tunnel
// is only allowed to an IP that was just resolved for an allowlisted domain —
// so a hosted bridge can only reach vetted chatmail servers. Empty = allow all.
//
// Optional unfurl endpoint: serves GET /unfurl?url=… on the same port for the
// webapp's link previews — a hardened server-side metadata fetcher, NOT a
// tunnel; see unfurl.mjs. On by default for an allow-all bridge, off once
// CHATMAIL_ALLOWLIST is set (a vetted hosted bridge shouldn't silently fetch
// arbitrary pages); UNFURL=1 / UNFURL=0 overrides either way.
//
// ponytail: still a single inspectable file — no auth, the port + optional
// domain allowlist are the only guards. A hostile authoritative DNS server for
// an allowlisted domain could point it at an internal IP (SSRF); acceptable for
// vetted servers. Upgrade path: pin known IPs instead of trusting the resolver.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import { unfurlHandler } from './unfurl.mjs';

const PORT = Number(process.env.PORT ?? 8641);
const ALLOWED_TCP_PORTS = new Set([143, 465, 587, 993]);

// Allowlist mode: empty env => allow-all (unchanged behavior).
// CHATMAIL_WHITELIST is the deprecated pre-0.1.2 name; drop the fallback when
// nothing warns about it anymore.
if (process.env.CHATMAIL_WHITELIST && !process.env.CHATMAIL_ALLOWLIST)
  console.warn('CHATMAIL_WHITELIST is deprecated, use CHATMAIL_ALLOWLIST');
const ALLOWLIST = (process.env.CHATMAIL_ALLOWLIST ?? process.env.CHATMAIL_WHITELIST ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_TTL_MS = 10 * 60 * 1000; // temporary: resolved IPs expire after 10 min
const allowedIps = new Map(); // ip -> expiresAt (ms)

// Unfurl endpoint (link previews): on by default for an allow-all bridge — a
// local/personal one, where the operator hasn't restricted reach anyway, so a
// same-host preview fetcher is fine and needs no config. Off once an allowlist
// is set: a hosted bridge that vets its mail destinations shouldn't silently
// double as an open web-preview fetcher — opt in explicitly with UNFURL=1.
// An explicit UNFURL=1 / UNFURL=0 always wins.
const UNFURL = process.env.UNFURL !== undefined && process.env.UNFURL !== ''
  ? process.env.UNFURL === '1'
  : ALLOWLIST.length === 0;

const isAllowlisted = host => {
  const h = host.toLowerCase();
  return ALLOWLIST.some(d => h === d || h.endsWith('.' + d));
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

// plain (non-upgrade) HTTP requests only carry the opt-in unfurl endpoint
const server = createServer((req, res) => {
  if (UNFURL && req.url.startsWith('/unfurl')) return unfurlHandler(req, res);
  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const [, kind, host, port] = req.url.split('/');
  if (kind === 'dns') {
    // localhost is answered from a hardcoded reply, never the resolver: the
    // webapp probes /dns/localhost to check the bridge is reachable, so this
    // health check must succeed even when the resolver can't answer 'localhost'
    // (it lives in /etc/hosts, not DNS) and regardless of any allowlist. Only
    // when 'localhost' is *explicitly* allowlisted do we let the loopback IPs
    // through to /tcp — otherwise the health check never opens a tunnel.
    if (host && host.toLowerCase() === 'localhost') {
      const loopback = ['127.0.0.1', '::1'];
      if (ALLOWLIST.length && isAllowlisted(host)) {
        const expires = Date.now() + ALLOW_TTL_MS;
        for (const ip of loopback) allowedIps.set(ip, expires);
      }
      ws.send(JSON.stringify(loopback));
      ws.close();
      return;
    }
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      const ips = [...(v4.value ?? []), ...(v6.value ?? [])];
      // In allowlist mode, remember IPs resolved for an allowlisted domain so
      // the /tcp handler will let the core connect to them.
      if (ALLOWLIST.length && isAllowlisted(host)) {
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
  if (ALLOWLIST.length && !ipAllowed(host)) {
    console.warn(`tcp ${host}:${port} blocked (not on the allowlist)`);
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
  if (ALLOWLIST.length) console.log(`allowlist: ${ALLOWLIST.join(', ')}`);
  console.log(
    UNFURL
      ? `unfurl endpoint on http://localhost:${PORT}/unfurl?url=...`
      : 'unfurl endpoint off (allowlist set; UNFURL=1 to enable)'
  );
});
