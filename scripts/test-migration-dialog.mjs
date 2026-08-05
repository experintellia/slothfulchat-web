// Migration-error dialog e2e: an account whose database migration failed must
// stop the app with an explanation, not open as if nothing happened.
//
// Core does not fail such an open on purpose — it keeps the half-migrated
// account open so a backup can still be taken out of it, records the error and
// returns success (vendor/core/src/sql.rs). Only `get_migration_error` tells
// the UI, so nothing asking means a broken account looks healthy and misbehaves
// later somewhere unrelated.
//
// Covers:
//   - a recorded migration error opens the blocking dialog
//   - the sweep covers every account, not just the first one
//   - the copyable report carries core's error text (the only route from
//     "it broke" to a fix — see test-fatal-dialog.mjs)
//   - a healthy core shows nothing (or the checks above would pass vacuously)
//
// No proxy and no core boot: a stub worker answers the two jsonrpc calls,
// exactly as test-fatal-dialog.mjs stubs the worker's fatal messages.
import { chromium } from 'playwright'
import { startServers, freezeEval } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8657)

const { cleanup } = await startServers({ app: APP_PORT })

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const url = `http://localhost:${APP_PORT}/main.html`

// core's own wording for a failed migration, shortened
const CORE_ERROR = 'Updating Delta Chat failed. sql: no such column: key_contacts'

/** A worker that speaks just enough jsonrpc to answer the startup sweep.
 * `brokenAccount` = which account id reports a migration error (0 = none). */
const stubWorker = brokenAccount => `
  self.onmessage = e => {
    if (typeof e.data !== 'string') return           // fs side channel
    const m = JSON.parse(e.data)
    if (m.id == null) return                          // notification
    let result = null
    if (m.method === 'get_all_account_ids') result = [1, 2]
    else if (m.method === 'get_migration_error')
      result = m.params[0] === ${brokenAccount} ? ${JSON.stringify(CORE_ERROR)} : null
    self.postMessage(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
  }
`

async function run(brokenAccount) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await freezeEval(page)
  await page.route('**/core/worker.js', route =>
    route.fulfill({ contentType: 'text/javascript', body: stubWorker(brokenAccount) })
  )
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

// --- 1) the second account's migration error is caught too -----------------
// Deliberately account 2: a check that only ever looked at the first id would
// pass against a one-account fixture and ship a sweep that stops too early.
{
  const { ctx, page } = await run(2)
  const dialog = page.locator('#sc-migration-error-dialog')
  await dialog.waitFor({ state: 'attached', timeout: 20000 })
  console.log('OK: a recorded migration error opens the dialog, on any account')

  // --- 2) it says what happened and what to do ----------------------------
  const bodyText = await dialog.locator('p').first().innerText()
  for (const phrase of ['not safe', 'backup']) {
    if (!bodyText.includes(phrase)) {
      throw new Error(`migration dialog does not mention ${phrase}: ${bodyText}`)
    }
  }
  console.log('OK: the dialog explains the state and points at a backup')

  // --- 3) core's error text can leave the app -----------------------------
  const report = await dialog.locator('pre').innerText()
  if (!/^failure: migration-error$/m.test(report)) {
    throw new Error(`report is missing the failure kind: ${report}`)
  }
  if (!report.includes('no such column: key_contacts')) {
    throw new Error(`report does not carry core's error text: ${report}`)
  }
  console.log("OK: the report carries core's own error text")

  // --- 4) it blocks the app ------------------------------------------------
  const open = await dialog.evaluate(el => el.open)
  if (!open) throw new Error('the migration dialog is not a shown modal')
  await ctx.close()
}

// --- 5) a healthy core is left alone --------------------------------------
// Without this, every check above would also pass if the dialog were shown
// unconditionally.
{
  const { ctx, page } = await run(0)
  await page.waitForTimeout(4000)
  if (await page.locator('#sc-migration-error-dialog').count()) {
    throw new Error('the migration dialog opened without a migration error')
  }
  console.log('OK: no migration error, no dialog')
  await ctx.close()
}

await browser.close()
cleanup()
console.log('\nmigration-error dialog: all checks passed')
