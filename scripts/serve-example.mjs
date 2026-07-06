// Serves packages/core-wasm (example, dist, wasm-dist, and linked deps) for
// manual browser exploration: pnpm --filter @slothfulchat/core-wasm example
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // follow pnpm symlinks (node_modules/@deltachat/...) but stay inside the repo
    const repoRoot = await realpath(join(root, '..', '..'));
    const path = await realpath(normalize(join(root, urlPath)));
    if (!path.startsWith(repoRoot)) throw new Error('traversal');
    const data = await readFile(path);
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
server.listen(8642, () => {
  console.log('example: http://localhost:8642/example/index.html');
});
