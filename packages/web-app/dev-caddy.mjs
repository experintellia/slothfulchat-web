// Webxdc dev harness: runs serve.mjs on 8643 and Caddy in front of it, so
// http://app.localhost:8642 and http://*.webxdc.app.localhost:8642 both work
// (the app plus per-origin webxdc test pages). `pnpm dev:webxdc` runs this.
// Without Caddy, plain `pnpm serve` still serves the app (no webxdc subdomains).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

const serve = spawn('node', ['serve.mjs'], {
  cwd: here,
  env: { ...process.env, PORT: '8643' },
  stdio: 'inherit',
})

const caddy = spawn('caddy', ['run', '--config', 'Caddyfile.dev', '--adapter', 'caddyfile'], {
  cwd: here,
  stdio: 'inherit',
})

caddy.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      '\ncaddy is not installed. Install a stock build from https://caddyserver.com\n' +
      '(any build works for local dev), or just run `pnpm serve` — the app works,\n' +
      'you only lose the webxdc subdomains.\n'
    )
  } else {
    console.error(err)
  }
  serve.kill()
  process.exit(1)
})

console.log('app:      http://app.localhost:8642')
console.log('xdc test: http://anything.webxdc.app.localhost:8642')

const shutdown = () => {
  serve.kill()
  caddy.kill()
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)

// If either child exits, tear down the other and mirror its exit code.
serve.on('exit', (code) => {
  caddy.kill()
  process.exit(code ?? 0)
})
caddy.on('exit', (code) => {
  serve.kill()
  process.exit(code ?? 0)
})
