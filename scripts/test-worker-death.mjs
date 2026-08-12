// A core worker that dies AFTER boot must not leave the app hanging.
//
// Without the transport's error/messageerror handling every in-flight JSON-RPC
// call and every fs side-channel call waits for a response that can never
// arrive: a spinner forever, no error, no way forward. Two phases:
//
//   1) transport level — a stub worker that boots and then dies, in both
//      shapes a death takes: a sync uncaught throw (fires worker.onerror) and
//      a self-reported fatal-worker-died message (what worker.ts posts for a
//      panic in its async onmessage, a rejection the browser never propagates
//      to onerror). Every pending call must reject, later calls must reject
//      too, and the failure must reach the page as a fatal-* message.
//   2) app level — the same death behind the real frontend must put the
//      blocking reload dialog on screen.
//
// Offline, and no wasm core is booted: the stub worker never loads one. Needs
// packages/core-wasm/dist/index.js and the assembled web-app dist/ (both built
// by .github/actions/build-web-app). Modeled on scripts/test-fatal-dialog.mjs.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServers, script, freezeEval } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8649)

// esbuild bundle of packages/core-wasm/src/index.ts — served into the app's
// origin below so phase 1 can drive startCore directly.
const coreBundle = readFileSync(script('../packages/core-wasm/dist/index.js'), 'utf8')

// Boots, answers nothing, then dies of an uncaught error — the shape of a Rust
// panic or an OOM kill: whatever was in flight simply never gets a reply.
const DYING_WORKER = `setTimeout(() => { throw new Error('simulated core panic') }, 300)`
// The shape onerror can't see: a panic inside the worker's async onmessage is
// an unhandled rejection in the worker, so worker.ts reports it itself. This
// stub posts that exact report, proving startCore turns it into rejections and
// the fatal message. (The reporter in worker.ts is a direct postMessage; its
// wiring can't run here without booting the real wasm core.)
const REPORTING_WORKER = `setTimeout(() => postMessage({ type: 'fatal-worker-died', message: 'simulated async panic' }), 300)`

const { cleanup } = await startServers({ app: APP_PORT })

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const url = `http://localhost:${APP_PORT}/main.html`

// --- phase 1: pending calls reject instead of hanging ----------------------
for (const [death, workerBody] of [
  ['sync throw', DYING_WORKER],
  ['self-reported async panic', REPORTING_WORKER],
]) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await freezeEval(page)
  page.on('pageerror', e => console.error('[pageerror]', e.message))

  await page.route('**/core-transport.js', route =>
    route.fulfill({ contentType: 'text/javascript', body: coreBundle })
  )
  await page.route('**/worker-death-transport.html', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset=utf-8>' })
  )
  await page.goto(`http://localhost:${APP_PORT}/worker-death-transport.html`)

  const result = await page.evaluate(async workerBody => {
    // the event loop BaseDeltaChat starts is pending too, so its rejection
    // lands here; swallow it rather than let it fail the run as page noise
    addEventListener('unhandledrejection', e => e.preventDefault())
    const { startCore } = await import('/core-transport.js')
    const stub = URL.createObjectURL(new Blob([workerBody], { type: 'text/javascript' }))
    const core = startCore({ persist: false }, stub)

    const fatals = []
    core.worker.addEventListener('message', e => {
      if (e.data && e.data.type) fatals.push(e.data.type)
    })
    // a hang is the bug under test, so time it out into a verdict instead of
    // letting the whole run wedge
    const settle = (p, label) =>
      Promise.race([
        p.then(
          () => `${label}: RESOLVED`,
          err => `${label}: rejected (${err && err.message})`
        ),
        new Promise(r => setTimeout(() => r(`${label}: HUNG`), 5000)),
      ])

    const inFlight = [
      settle(core.transport.request('get_system_info', []), 'pending rpc'),
      settle(core.fsRead('/never-answered'), 'pending fs'),
    ]
    const before = await Promise.all(inFlight)
    // and anything started after the death, which would otherwise be posted
    // into a terminated worker and wait forever
    const after = await Promise.all([
      settle(core.transport.request('get_system_info', []), 'later rpc'),
      settle(core.fsRead('/after'), 'later fs'),
    ])
    return { verdicts: [...before, ...after], fatals }
  }, workerBody)

  for (const verdict of result.verdicts) {
    if (!verdict.includes('rejected')) {
      throw new Error(`a call did not fail after the worker died (${death}) — ${verdict}`)
    }
    console.log(`OK (${death}): ${verdict}`)
  }
  if (!result.fatals.includes('fatal-worker-died')) {
    throw new Error(`no fatal-worker-died reached the page: ${JSON.stringify(result.fatals)}`)
  }
  console.log(`OK (${death}): the death is reported to the page as a fatal message`)
  await context.close()
}

// --- phase 2: the user gets a blocking reload dialog -----------------------
{
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await freezeEval(page)
  await page.route('**/core/worker.js', route =>
    route.fulfill({ contentType: 'text/javascript', body: DYING_WORKER })
  )
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  const dialog = page.locator('#sc-worker-died-dialog')
  await dialog.waitFor({ state: 'attached', timeout: 20000 })
  if (!(await dialog.evaluate(d => d.open))) {
    throw new Error('the worker-died dialog exists but is not shown')
  }
  const body = await dialog.locator('p').first().innerText()
  if (!/reload/i.test(body)) {
    throw new Error(`the dialog does not tell the user to reload: ${body}`)
  }
  if ((await dialog.locator('button', { hasText: 'Retry' }).count()) !== 1) {
    throw new Error('the dialog has no Retry button — no way forward from a dead app')
  }
  const report = await dialog.locator('pre').innerText()
  if (!/^failure: worker-died$/m.test(report) || !/simulated core panic/.test(report)) {
    throw new Error(`the report does not carry the failure kind and cause: ${report}`)
  }
  console.log('OK: a post-boot worker death shows the blocking reload dialog')
  await context.close()
}

await browser.close()
cleanup()
console.log('\nworker death: all checks passed')
