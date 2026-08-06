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

/** Alpha of a computed color — always rgb(...) or rgba(...), never a keyword. */
const alphaOf = c => (c.startsWith('rgba') ? Number(c.split(',')[3]) : 1)

/**
 * Assert one of our own modal <dialog> overlays is really on screen — not just
 * present in the DOM with the right words in it.
 *
 * The dialog gates assert text and structure, and both survive the styling
 * being lost entirely (#211): an unstyled pile of nodes in the corner has the
 * same text in the same elements and passes them green. So check the cheap
 * observable consequences of the styling instead — a fixed, viewport-covering
 * flex scrim with a centred, correctly sized, opaque card in it. All four
 * dialogs in runtime.ts are built to that one shape.
 *
 * Deliberately not a pixel baseline: no committed PNGs, and nothing to go
 * flaky when CI's font rendering differs from a dev machine.
 *
 * @param {import('playwright').Locator} dialog  the <dialog> element
 * @param {number} panelWidth  the card's `width: min(Npx, 92vw)` in px
 * @param {string} label       what failure messages call it
 */
export async function assertDialogRendered(dialog, panelWidth, label) {
  const fail = m => {
    throw new Error(`${label}: ${m}`)
  }
  const view = dialog.page().viewportSize()

  // The scrim. An unstyled <dialog> is a block box sized to its content and
  // placed by the UA — every one of these three is wrong for it.
  const scrim = await dialog.boundingBox()
  if (!scrim) fail('no box at all — the dialog is not rendered')
  // tolerance covers a classic scrollbar eating a few px of the layout viewport
  if (scrim.width < view.width - 20 || scrim.height < view.height - 20) {
    fail(
      `overlay is ${scrim.width}x${scrim.height}, does not cover the ` +
        `${view.width}x${view.height} viewport`
    )
  }
  const css = await dialog.evaluate(d => {
    const c = getComputedStyle(d)
    return { display: c.display, position: c.position, bg: c.backgroundColor }
  })
  if (css.display !== 'flex') fail(`overlay is display:${css.display} — nothing centres the card`)
  if (css.position !== 'fixed') fail(`overlay is position:${css.position}, not fixed`)
  if (alphaOf(css.bg) === 0) fail('overlay has no scrim — what is behind it is not dimmed')

  // The card: the outermost <div> in the overlay, in every one of these dialogs.
  const panel = dialog.locator('div').first()
  const box = await panel.boundingBox()
  if (!box) fail('the card inside the overlay is not rendered')
  const want = Math.min(panelWidth, view.width * 0.92)
  if (Math.abs(box.width - want) > 2) fail(`card is ${box.width}px wide, expected ${want}px`)
  if (box.height < 80) fail(`card is ${box.height}px tall — collapsed`)
  if (Math.abs(box.x + box.width / 2 - view.width / 2) > 2) fail('card is not centred horizontally')
  if (Math.abs(box.y + box.height / 2 - view.height / 2) > 2) fail('card is not centred vertically')
  // centred vertically, so overflowing the viewport is exactly being too tall
  if (box.height > view.height) fail(`card is ${box.height}px tall — taller than the screen`)
  const panelBg = await panel.evaluate(e => getComputedStyle(e).backgroundColor)
  if (alphaOf(panelBg) < 1) fail(`card background is ${panelBg} — the page shows through it`)
}
