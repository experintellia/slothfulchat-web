// Bridge picker e2e: serve the built web-app, inject a synthetic instance
// config (default bridge + two public bridges, as SLOTHFUL_DEFAULT_PROXY /
// SLOTHFUL_PUBLIC_BRIDGES would bake into config.js), and drive the bridge
// dialog: option list + preselection, picking localhost/default/custom, and
// the localStorage persistence semantics across reloads. Also regression-tests
// that resolveBridgeUrl() honors the instance default (it used to skip it).
// No ws-tcp-proxy and no core boot needed — the dialog lives in runtime.js.
// Modeled on scripts/smoke-web-app.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8642)

const DEFAULT_BRIDGE = 'wss://default.example/bridge'
const PUBLIC_BRIDGES = [
  { url: 'wss://a.example/bridge', description: 'Community bridge, for testing' },
  { url: 'wss://b.example/bridge', description: 'Backup bridge' },
]
const LOCALHOST = 'ws://localhost:8641'
const PROXY_KEY = 'slothfulchat.proxyUrl'

const server = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => server.kill()
process.on('exit', cleanup)
await new Promise(r => setTimeout(r, 500)) // let the server bind

// CHROMIUM_BIN overrides the browser binary (e.g. a preinstalled system
// chromium when the playwright-managed download is unavailable)
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))

// upstream's avoid-eval.js replaces window.eval with a throwing stub, which
// breaks playwright's evaluate/waitForFunction. Freeze the real eval first.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

// Serve a synthetic instance config instead of the build's config.js — an
// init script would not work, the real config.js would overwrite it.
const config = {
  instanceName: 'BridgeTest',
  defaultProxyUrl: DEFAULT_BRIDGE,
  publicBridges: PUBLIC_BRIDGES,
}
await page.route('**/config.js', route =>
  route.fulfill({
    contentType: 'text/javascript',
    body: `window.__slothfulConfig=${JSON.stringify(config)}\n`,
  })
)

const waitForBridgeHook = () =>
  page.waitForFunction(() => window.__slothfulchatBridge, null, {
    timeout: 60_000,
    polling: 100,
  })

/** Click "Use this bridge" and wait until the resulting reload finished
 * (marker vanishes with the old document). */
async function useAndReload() {
  await page.evaluate(() => (window.__scPreReload = true))
  await page.getByRole('button', { name: 'Use this bridge' }).click()
  await page.waitForFunction(
    () => !window.__scPreReload && window.__slothfulchatBridge,
    null,
    { timeout: 60_000, polling: 100 }
  )
}

const dialogState = () =>
  page.evaluate(() => {
    const radios = [
      ...document.querySelectorAll('#sc-bridge-dialog input[type=radio]'),
    ]
    return {
      urls: radios.map(r => r.value),
      checked: radios.findIndex(r => r.checked),
      text: document.getElementById('sc-bridge-dialog').innerText,
    }
  })

const selectRadio = index =>
  page.evaluate(i => {
    document.querySelectorAll('#sc-bridge-dialog input[type=radio]')[i].click()
  }, index)

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html?persist=0`)
  await waitForBridgeHook()

  // resolveBridgeUrl regression: no override saved -> the instance default,
  // not localhost
  let url = await page.evaluate(() => window.__slothfulchatBridge.url())
  if (url !== DEFAULT_BRIDGE) {
    throw new Error(`expected instance default ${DEFAULT_BRIDGE}, got ${url}`)
  }
  console.log('OK: unconfigured resolution uses the instance default')

  // dialog: localhost + default + 2 public + custom, default preselected
  await page.evaluate(() => window.__slothfulchatBridge.openDialog())
  let state = await dialogState()
  const wantUrls = [LOCALHOST, DEFAULT_BRIDGE, ...PUBLIC_BRIDGES.map(b => b.url)]
  // the last radio is Custom… (value "on": no URL assigned)
  if (
    state.urls.length !== 5 ||
    !wantUrls.every((u, i) => state.urls[i] === u)
  ) {
    throw new Error(`unexpected option list: ${JSON.stringify(state.urls)}`)
  }
  if (state.urls[state.checked] !== DEFAULT_BRIDGE) {
    throw new Error(`expected default preselected, got index ${state.checked}`)
  }
  for (const want of [
    'most private and secure',
    'Default bridge of this instance',
    PUBLIC_BRIDGES[0].description,
    PUBLIC_BRIDGES[1].description,
    'Custom…',
    'npx @slothfulchat/ws-tcp-proxy',
    'encrypted by default',
  ]) {
    if (!state.text.includes(want)) {
      throw new Error(`dialog text missing ${JSON.stringify(want)}`)
    }
  }
  console.log('OK: dialog lists localhost + default + public bridges + custom')

  // picking localhost on an instance WITH a default must WRITE the key
  // (removal would snap back to the instance default)
  await selectRadio(0)
  await useAndReload()
  let stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== LOCALHOST) {
    throw new Error(`expected ${LOCALHOST} stored, got ${JSON.stringify(stored)}`)
  }
  url = await page.evaluate(() => window.__slothfulchatBridge.url())
  if (url !== LOCALHOST) throw new Error(`expected ${LOCALHOST}, got ${url}`)
  console.log('OK: explicit localhost pick is persisted')

  // reopening preselects the stored choice
  await page.evaluate(() => window.__slothfulchatBridge.openDialog())
  state = await dialogState()
  if (state.checked !== 0) {
    throw new Error(`expected localhost preselected, got index ${state.checked}`)
  }
  console.log('OK: reopened dialog preselects the stored choice')

  // picking the instance default clears the key (follow future default changes)
  await selectRadio(1)
  await useAndReload()
  stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== null) {
    throw new Error(`expected no stored key, got ${JSON.stringify(stored)}`)
  }
  console.log('OK: picking the instance default clears the override')

  // custom entry: typed URL is stored and preselected as Custom on reopen
  const CUSTOM = 'wss://custom.example/bridge'
  await page.evaluate(() => window.__slothfulchatBridge.openDialog())
  await page.fill('#sc-bridge-dialog input[type=text]', CUSTOM)
  state = await dialogState()
  if (state.checked !== state.urls.length - 1) {
    throw new Error('typing a custom URL should select the Custom option')
  }
  await useAndReload()
  stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== CUSTOM) {
    throw new Error(`expected ${CUSTOM} stored, got ${JSON.stringify(stored)}`)
  }
  await page.evaluate(() => window.__slothfulchatBridge.openDialog())
  state = await dialogState()
  if (state.checked !== state.urls.length - 1) {
    throw new Error('custom URL should preselect the Custom option on reopen')
  }
  console.log('OK: custom bridge URL round-trips')

  // unconfigured instance (empty config.js): only localhost + custom, and
  // picking localhost clears the key (localhost IS the default then)
  await page.unroute('**/config.js')
  await page.route('**/config.js', route =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'window.__slothfulConfig={}\n',
    })
  )
  await page.evaluate(k => localStorage.removeItem(k), PROXY_KEY)
  await page.reload()
  await waitForBridgeHook()
  await page.evaluate(() => window.__slothfulchatBridge.openDialog())
  state = await dialogState()
  if (state.urls.length !== 2 || state.urls[0] !== LOCALHOST) {
    throw new Error(`expected localhost + custom only, got ${JSON.stringify(state.urls)}`)
  }
  if (state.checked !== 0) {
    throw new Error(`expected localhost preselected, got index ${state.checked}`)
  }
  await selectRadio(0)
  await useAndReload()
  stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== null) {
    throw new Error(`expected no stored key on unconfigured instance, got ${JSON.stringify(stored)}`)
  }
  console.log('OK: unconfigured instance offers localhost + custom, stores nothing')
} catch (err) {
  failed = true
  console.error('FAIL:', err)
} finally {
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
