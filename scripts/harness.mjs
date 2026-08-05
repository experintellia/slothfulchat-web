// Boot and teardown for the browser-driven scripts in this directory.
//
// Nineteen of them opened the same way: spawn packages/web-app/serve.mjs
// and/or packages/ws-tcp-proxy on fixed ports, collect the children, kill them
// from a process 'exit' handler, arm a global watchdog so a hung page fails the
// run instead of sitting there, and sleep briefly to let the sockets bind.
// That is what lives here. What each script then *does* with the browser is
// its own business and stays in its own file.
//
// Deliberately NOT here: the login-via-UI flow. Only four scripts have one and
// two of those drive a different onboarding path, so a shared version would be
// a parameter per caller.
//
// Self-check: node --test scripts/harness.test.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Absolute path for a repo path written relative to scripts/. */
export const script = rel => fileURLToPath(new URL(rel, import.meta.url))

/**
 * Start the servers a script needs and wire their teardown.
 *
 * @param {object}  [o]
 * @param {number}  [o.app]        port for packages/web-app/serve.mjs; omit to skip
 * @param {string}  [o.appRoot]    SERVE_ROOT for it (serve a temp dir instead of dist/)
 * @param {string}  [o.appIndex]   SERVE_INDEX for it
 * @param {number}  [o.proxy]      port for the WS-TCP proxy; omit to skip
 * @param {object}  [o.proxyEnv]   extra env for the proxy (CHATMAIL_ALLOWLIST etc.)
 * @param {string}  [o.proxyStdio] 'inherit' (default) or 'pipe' to read its output
 * @param {number}  [o.settleMs]   pause before returning, letting sockets bind
 * @param {number}  [o.watchdogMs] arm a global watchdog; omit for none
 * @param {string}  [o.label]      what the watchdog message calls this run
 * @returns {Promise<{
 *   appServer: import('node:child_process').ChildProcess | null,
 *   proxy: import('node:child_process').ChildProcess | null,
 *   procs: import('node:child_process').ChildProcess[],
 *   cleanup: () => void,
 *   watchdog: NodeJS.Timeout | null,
 * }>}
 */
export async function startServers({
  app,
  appRoot,
  appIndex,
  proxy,
  proxyEnv,
  proxyStdio = 'inherit',
  settleMs = 500,
  watchdogMs,
  label = 'test',
} = {}) {
  const procs = []

  // Proxy first: the app server is what the page talks to, so having the proxy
  // already listening avoids a first-load race in the scripts that use both.
  let proxyProc = null
  if (proxy) {
    proxyProc = spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
      env: { ...process.env, PORT: String(proxy), ...proxyEnv },
      stdio: proxyStdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    procs.push(proxyProc)
  }

  let appServer = null
  if (app) {
    appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
      env: {
        ...process.env,
        PORT: String(app),
        ...(appRoot ? { SERVE_ROOT: appRoot } : {}),
        ...(appIndex ? { SERVE_INDEX: appIndex } : {}),
      },
      stdio: 'inherit',
    })
    procs.push(appServer)
  }

  const cleanup = () => procs.forEach(p => p.kill())
  process.on('exit', cleanup)

  // A hung page would otherwise keep the job alive until the CI job timeout,
  // burning the whole budget and reporting nothing useful.
  const watchdog = watchdogMs
    ? setTimeout(() => {
        console.error(
          `FAIL: global watchdog (${Math.round(watchdogMs / 60000)} min) — ${label} hung`
        )
        cleanup()
        process.exit(1)
      }, watchdogMs)
    : null

  if (settleMs) await new Promise(r => setTimeout(r, settleMs))
  return { appServer, proxy: proxyProc, procs, cleanup, watchdog }
}

/**
 * Upstream's avoid-eval.js replaces window.eval, which breaks page.evaluate.
 * Pin the real one before any page script runs. Takes a Page or a
 * BrowserContext — addInitScript exists on both.
 */
export const freezeEval = target =>
  target.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })

/** Surface wasm panics, which otherwise scroll past in the page's console. */
export const logPanics = page =>
  page.on('console', m => {
    if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
  })
