// Local dev WebSocket→TCP proxy for the wasm core.
//
//   /tcp/{host}/{port} — raw byte tunnel to host:port (TLS terminates in the
//                        browser wasm, the proxy only ever sees ciphertext)
//   /dns/{host}        — one JSON message with resolved IPs, then close
//
// ponytail: local prototype only — no auth, port allowlist is the only guard.
// A production version would live on the chatmail relay and validate origins.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8641);
const ALLOWED_TCP_PORTS = new Set([143, 465, 587, 993]);

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const [, kind, host, port] = req.url.split('/');
  if (kind === 'dns') {
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      const ips = [...(v4.value ?? []), ...(v6.value ?? [])];
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

server.listen(PORT, () => console.log(`ws-tcp proxy on ws://localhost:${PORT}`));
