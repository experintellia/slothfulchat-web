// Bridge picker e2e: serve the built web-app, inject a synthetic instance
// config (default bridge + two public bridges, as SLOTHFUL_DEFAULT_PROXY /
// SLOTHFUL_PUBLIC_BRIDGES would bake into config.js), and drive the bridge
// dialog: option list + preselection, picking localhost/default/custom, and
// the localStorage persistence semantics across reloads. Also regression-tests
// that resolveBridgeUrl() honors the instance default (it used to skip it),
// and that the dialog renders as a dialog rather than merely carrying the
// right text (#211).
// No ws-tcp-proxy and no core boot needed — the dialog lives in runtime.js.
// Modeled on scripts/smoke-web-app.mjs.
import { chromium } from 'playwright'
import { assertDialogRendered, startServers } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8642)

const DEFAULT_BRIDGE = 'wss://default.example/bridge'
const PUBLIC_BRIDGES = [
  { url: 'wss://a.example/bridge', description: 'Community bridge, for testing' },
  { url: 'wss://b.example/bridge', description: 'Backup bridge' },
]
const LOCALHOST = 'ws://localhost:8641'
const PROXY_KEY = 'slothfulchat.proxyUrl'

const { cleanup } = await startServers({ app: APP_PORT })

// CHROMIUM_BIN overrides the browser binary (e.g. a preinstalled system
// chromium when the playwright-managed download is unavailable)
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
// The app's blobs-sw registration may location.reload() the page on its own
// (uncontrolled-page recovery / update activation in runtime.ts), which
// destroys the evaluate context mid-test on slow runners (#72). This test
// never needs the SW — the dialog lives in runtime.js — so block it.
const context = await browser.newContext({ serviceWorkers: 'block' })
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))

// upstream's avoid-eval.js replaces window.eval with a throwing stub, which
// breaks playwright's evaluate/waitForFunction. Freeze the real eval first.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
// This test's acknowledgement of the throwaway-session gate (?persist=0 below):
// the same per-tab marker the gate dialog's "Start throwaway session" sets.
await page.addInitScript(() =>
  sessionStorage.setItem('slothfulchat.throwawayConfirmed', '1')
)

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
    'One exception: link previews',
  ]) {
    if (!state.text.includes(want)) {
      throw new Error(`dialog text missing ${JSON.stringify(want)}`)
    }
  }
  console.log('OK: dialog lists localhost + default + public bridges + custom')

  // ...and it is on screen as a dialog, not just as the right text in the DOM:
  // every other check here reads innerText or radio state, which an unstyled
  // pile of nodes in the corner satisfies just as well (#211). The teeth of
  // this assertion are proven in test-fatal-dialog.mjs, on the same helper.
  await assertDialogRendered(page.locator('#sc-bridge-dialog'), 460, 'bridge dialog')
  console.log('OK: the bridge dialog is a centred, styled modal')

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

  // --- M-07: a ?proxy= in the page URL must be confirmed --------------------
  await page.unroute('**/config.js')
  await page.route('**/config.js', route =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.__slothfulConfig=${JSON.stringify(config)}\n`,
    })
  )

  const EVIL = 'wss://evil.example/bridge'
  const confirmState = () =>
    page.evaluate(() => {
      const dlg = document.getElementById('sc-bridge-confirm-dialog')
      return { open: !!dlg, text: dlg?.innerText ?? '', search: location.search }
    })

  // The prompt is deliberately opened at idle AFTER the frontend's startup —
  // a <dialog> shown earlier would sit under the welcome screen's own modal —
  // so both the "asks" and the "stays silent" cases have to wait for it.
  const gotoWithProxy = async proxy => {
    await page.evaluate(k => localStorage.removeItem(k), PROXY_KEY)
    await page.goto(
      `http://localhost:${APP_PORT}/main.html?persist=0&proxy=${encodeURIComponent(proxy)}`
    )
    await waitForBridgeHook()
  }
  const waitForConfirm = (state = 'attached') =>
    page.waitForSelector('#sc-bridge-confirm-dialog', { state, timeout: 30_000 })

  await gotoWithProxy(EVIL)
  await waitForConfirm()
  let confirm = await confirmState()
  if (!confirm.text.includes(EVIL)) {
    throw new Error(`confirmation does not show the URL: ${JSON.stringify(confirm.text)}`)
  }
  if (confirm.search.includes('proxy=')) {
    throw new Error(`?proxy= was not scrubbed from the URL: ${confirm.search}`)
  }
  url = await page.evaluate(() => window.__slothfulchatBridge.url())
  if (url !== DEFAULT_BRIDGE) {
    throw new Error(`unconfirmed bridge was used: got ${url}`)
  }
  console.log('OK: untrusted ?proxy= is ignored and confirmed instead')

  // declining leaves the app on the bridge it resolved to anyway
  await page.getByRole('button', { name: 'Keep current bridge' }).click()
  if ((await confirmState()).open) throw new Error('declining left the dialog open')
  stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== null) throw new Error(`declining stored ${JSON.stringify(stored)}`)
  console.log('OK: declining keeps the current bridge and stores nothing')

  // accepting stores it like any other pick and reloads onto it
  await gotoWithProxy(EVIL)
  await waitForConfirm()
  await page.evaluate(() => (window.__scPreReload = true))
  await page
    .locator('#sc-bridge-confirm-dialog')
    .getByRole('button', { name: 'Use this bridge' })
    .click()
  await page.waitForFunction(
    () => !window.__scPreReload && window.__slothfulchatBridge,
    null,
    { timeout: 60_000, polling: 100 }
  )
  stored = await page.evaluate(k => localStorage.getItem(k), PROXY_KEY)
  if (stored !== EVIL) throw new Error(`expected ${EVIL} stored, got ${JSON.stringify(stored)}`)
  url = await page.evaluate(() => window.__slothfulchatBridge.url())
  if (url !== EVIL) throw new Error(`expected ${EVIL} after confirming, got ${url}`)
  console.log('OK: confirming adopts the bridge')

  // already-trusted URLs stay silent: a bridge on this device (every dev/test
  // setup passes one on a random port) and one the instance itself offers
  for (const trusted of ['ws://localhost:9999', 'ws://127.0.0.1:9999', PUBLIC_BRIDGES[0].url]) {
    await gotoWithProxy(trusted)
    // the prompt fires at idle after startup: wait past that point, then give
    // the idle callback a moment, before concluding it stayed silent
    await page.waitForFunction(
      () => performance.getEntriesByName('sc:ui-fully-ready').length > 0,
      null,
      { timeout: 60_000, polling: 100 }
    )
    await page.waitForTimeout(2000)
    confirm = await confirmState()
    if (confirm.open) throw new Error(`trusted ${trusted} asked for confirmation`)
    url = await page.evaluate(() => window.__slothfulchatBridge.url())
    if (url !== trusted) throw new Error(`expected ${trusted} honored, got ${url}`)
  }
  console.log('OK: loopback and instance-offered ?proxy= are honored silently')
} catch (err) {
  failed = true
  console.error('FAIL:', err)
} finally {
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
