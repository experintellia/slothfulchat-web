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
// Binds 127.0.0.1 by default: with no allowlist this is an open relay to any
// mail server, so it must not be reachable from the network unless the operator
// says so. HOST=0.0.0.0 (or one interface address) opts into a hosted bridge,
// and that combination *requires* CHATMAIL_ALLOWLIST — startup refuses without.
//
// Optional unfurl endpoint: serves GET /unfurl?url=… on the same port for the
// webapp's link previews — a hardened server-side metadata fetcher, NOT a
// tunnel; see unfurl.mjs. On by default for an allow-all bridge, off once
// CHATMAIL_ALLOWLIST is set (a vetted hosted bridge shouldn't silently fetch
// arbitrary pages); UNFURL=1 / UNFURL=0 overrides either way.
//
// Resource limits (the numbers live in one block below): a frame-size cap, a
// global and a per-client connection cap, new-connections-per-minute per
// client, connect/idle/lifetime deadlines, a ping reap for vanished peers and
// backpressure in both directions. Tunable: MAX_CONNECTIONS,
// MAX_CONNECTIONS_PER_IP, TUNNEL_CONNECT_MS, TUNNEL_IDLE_MS. Per-client limits
// key on the socket's peer address; behind a reverse proxy that is the proxy
// for everyone, so set TRUST_PROXY=1 there — but only where the proxy itself
// overwrites X-Forwarded-For.
//
// ponytail: still a single inspectable file — no auth, the bind address + the
// optional domain allowlist are the only guards. A hostile authoritative DNS
// server for an allowlisted domain could point it at an internal IP (SSRF);
// acceptable for vetted servers. Upgrade path: pin known IPs instead of
// trusting the resolver.
// ponytail: a hosted bridge (non-loopback HOST) still authenticates nobody and
// checks no Origin — anyone who can reach the port, including a hostile web
// page, may relay to the allowlisted servers. Ceiling: the allowlist is all
// that bounds the damage. Upgrade path (a design question, not a one-liner:
// the app must learn to send it): a shared bearer token in the upgrade URL
// plus an Origin allowlist for browser clients.
import { createServer } from 'node:http';
import { connect, isIP, BlockList } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import { unfurlHandler, clientIp, rateLimited } from './unfurl.mjs';

const PORT = Number(process.env.PORT ?? 8641);
const HOST = process.env.HOST || '127.0.0.1'; // `||`: an empty HOST is unset, not a wildcard bind
const ALLOWED_TCP_PORTS = new Set([143, 465, 587, 993]);

// Resource limits. Sized for what this protocol actually does, so one client
// (or one stuck server) can't consume the bridge for everybody.
const MAX_PAYLOAD = 256 * 1024; // one WS frame; the core's tunnel writes ≤64 KB
const MAX_BUFFERED = 1024 * 1024; // per direction, before we stop reading (see below)
const MAX_CONNS = Number(process.env.MAX_CONNECTIONS) || 512; // whole bridge
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP) || 16;
const NEW_CONNS_PER_MIN = 120; // per client; a reconnect storm is not 120/min
const CONNECT_MS = Number(process.env.TUNNEL_CONNECT_MS) || 10_000; // dial deadline
// Idle deadline. Generous because an IMAP IDLE connection is legitimately
// silent for minutes at a time — cut this too short and you drop live mail
// connections. Dead-but-not-closed peers are caught by the ping reap instead.
const IDLE_MS = Number(process.env.TUNNEL_IDLE_MS) || 30 * 60_000;
const MAX_TUNNEL_MS = 12 * 60 * 60_000; // absolute lifetime; the client reconnects
const PING_MS = 30_000;
const perIp = new Map(); // client ip -> open connections

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
const allowedIps = new Map(); // "clientIp|resolvedIp" -> expiresAt (ms)

// Reachable-from-the-network + no allowlist = an open relay to every mail
// server's IMAP/SMTP ports for anyone who can reach the port. Refuse that
// combination outright; every other one is the operator's call. BlockList (as
// in unfurl.mjs) so IPv4-mapped forms of ::1/127.x count as loopback too; a
// bind that isn't an IP literal or 'localhost' is treated as public.
const HOST_FAMILY = isIP(HOST);
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
const BINDS_LOOPBACK_ONLY =
  HOST === 'localhost' ||
  (HOST_FAMILY !== 0 && LOOPBACK.check(HOST, HOST_FAMILY === 4 ? 'ipv4' : 'ipv6'));
if (!BINDS_LOOPBACK_ONLY && !ALLOWLIST.length) {
  console.error(
    `refusing to start: HOST=${HOST} is reachable from the network but CHATMAIL_ALLOWLIST is empty.\n` +
    "That is an open relay — anyone who reaches this port can tunnel to any host's IMAP/SMTP ports.\n" +
    'Either set CHATMAIL_ALLOWLIST=your.chatmail.example (comma-separated) to host a bridge,\n' +
    'or unset HOST to keep the loopback-only default (127.0.0.1, local use).'
  );
  process.exit(1);
}
const HOST_URL = HOST_FAMILY === 6 ? `[${HOST}]` : HOST; // IPv6 literals need brackets in a URL

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
// The allow-list is keyed per requesting client, not globally: one client
// resolving an allowlisted domain must not authorize that IP for everybody
// else. Allowlisted chatmail domains can share an address with unrelated
// services (CDN, shared hosting), and a global key would open 143/465/587/993
// at that address for every client on the bridge.
const allowIps = (client, ips) => {
  if (allowedIps.size > 10_000) allowedIps.clear(); // bounded; entries are TTL'd anyway
  const expires = Date.now() + ALLOW_TTL_MS;
  for (const ip of ips) allowedIps.set(`${client}|${ip}`, expires);
};
const ipAllowed = (client, ip) => {
  const key = `${client}|${ip}`;
  const expires = allowedIps.get(key);
  if (expires === undefined) return false;
  if (expires < Date.now()) {
    allowedIps.delete(key);
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
// maxPayload: ws defaults to 100 MiB per frame, which one client can make us
// allocate at will. IMAP/SMTP records are kilobytes.
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
// 'error' on a ws/http server or a socket is an unhandled throw with no
// listener, i.e. one bad client kills the bridge for every connected user.
wss.on('error', err => console.error('ws server error:', err.message));
server.on('clientError', (err, socket) => socket.destroy());

// Reap blackholed peers: a client that vanished (lid closed, NAT dropped the
// mapping) never sends a FIN, so without a heartbeat its tunnel — and the TCP
// connection behind it — would stay open forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, PING_MS).unref();

wss.on('connection', async (ws, req) => {
  // Attach before anything else, and before the first await below: a malformed
  // frame (an unmasked client frame => WS_ERR_EXPECTED_MASK) or a send on an
  // already-closed socket makes ws emit 'error' as soon as the next I/O tick
  // runs — which is while this handler is still suspended in DNS resolution.
  // ws has already closed the connection by then; we only clean up its tunnel.
  let socket = null;
  ws.on('error', err => {
    console.warn(`ws ${req.url}: ${err.message}`);
    socket?.destroy();
  });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  // Connection caps, counted per client and for the bridge as a whole. Checked
  // here rather than in the upgrade handshake: one close frame is cheap, and a
  // guard in the handler everyone already reads beats a second code path.
  // 1013 = "try again later".
  const client = clientIp(req);
  const open = (perIp.get(client) ?? 0) + 1;
  perIp.set(client, open);
  ws.on('close', () => {
    const n = perIp.get(client) - 1;
    if (n > 0) perIp.set(client, n);
    else perIp.delete(client);
  });
  if (
    wss.clients.size > MAX_CONNS ||
    open > MAX_CONNS_PER_IP ||
    rateLimited(`ws|${client}`, NEW_CONNS_PER_MIN)
  ) {
    console.warn(`ws ${req.url}: refused, ${client} over the connection limit`);
    ws.close(1013, 'busy');
    return;
  }
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
      if (ALLOWLIST.length && isAllowlisted(host)) allowIps(client, loopback);
      ws.send(JSON.stringify(loopback));
      ws.close();
      return;
    }
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      const ips = [...(v4.value ?? []), ...(v6.value ?? [])];
      // In allowlist mode, remember IPs resolved for an allowlisted domain so
      // the /tcp handler will let *this* client connect to them.
      if (ALLOWLIST.length && isAllowlisted(host)) allowIps(client, ips);
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
  if (ALLOWLIST.length && !ipAllowed(client, host)) {
    console.warn(`tcp ${host}:${port} blocked (not on the allowlist)`);
    ws.close(4003, 'forbidden');
    return;
  }
  console.log(`tcp ${host}:${port} open`);
  socket = connect(Number(port), host);
  // Deadlines. setTimeout's idle timer already runs during the dial (no bytes
  // flow yet), so the same timer is the connect deadline first and the idle
  // deadline once connected. Plus a hard lifetime cap, so a tunnel that stays
  // just-barely-active can't be held open indefinitely.
  socket.setTimeout(CONNECT_MS);
  socket.on('timeout', () => socket.destroy(new Error('timed out')));
  socket.on('connect', () => socket.setTimeout(IDLE_MS));
  const lifetime = setTimeout(() => socket.destroy(new Error('max lifetime')), MAX_TUNNEL_MS);

  // Backpressure, both directions: whichever side is slower must throttle the
  // other, or we buffer the difference in this process until it dies.
  //   tcp→ws: ws has no 'drain'. ws.bufferedAmount is the queue, and send()'s
  //     callback fires once that frame has left it — so pause the TCP socket
  //     when the queue passes the mark and resume from a callback that sees it
  //     drained. Callbacks run in order and a paused socket queues nothing new,
  //     so the last one always observes an empty queue: no missed resume.
  //   ws→tcp: write() returning false means the kernel buffer is full; ws.pause()
  //     stops reading further frames until the socket drains.
  socket.on('data', (data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(data, () => ws.bufferedAmount < MAX_BUFFERED && socket.resume());
    if (ws.bufferedAmount >= MAX_BUFFERED) socket.pause();
  });
  ws.on('message', (data) => {
    if (!socket.write(data)) ws.pause();
  });
  socket.on('drain', () => ws.resume());

  socket.on('close', () => {
    clearTimeout(lifetime);
    ws.close();
  });
  socket.on('error', (err) => {
    console.error(`tcp ${host}:${port}:`, err.message);
    ws.close(4004, err.code ?? 'tcp error');
  });
  ws.on('close', () => {
    console.log(`tcp ${host}:${port} closed`);
    clearTimeout(lifetime);
    socket.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ws-tcp proxy on ws://${HOST_URL}:${PORT}`);
  if (ALLOWLIST.length) console.log(`allowlist: ${ALLOWLIST.join(', ')}`);
  console.log(
    UNFURL
      ? `unfurl endpoint on http://${HOST_URL}:${PORT}/unfurl?url=...`
      : 'unfurl endpoint off (allowlist set; UNFURL=1 to enable)'
  );
});
