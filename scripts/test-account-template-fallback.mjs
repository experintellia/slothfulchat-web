// The account template is an optimization, and it has to fail like one.
//
// A template that the VFS accepts (right header, 512-multiple length) but
// sqlite cannot read is the dangerous case: the account would be created
// around a database that never opens, and it would never heal — the file
// exists, so it is never seeded again. Core must therefore undo the seed and
// let sqlite build a real database instead.
//
// Feeds the real template with page 1's b-tree zeroed and checks that the
// account comes out working anyway, that the template is dropped rather than
// retried, and that the fallback is used only where it is needed.
import { gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const PORT = 8659
const pkg = fileURLToPath(new URL('../packages/core-wasm', import.meta.url))

const template = join(pkg, 'wasm-dist/fresh_account.db.gz')
let good
try {
  good = gunzipSync(readFileSync(template))
} catch {
  console.error(
    `SKIP: no ${template} — run \`pnpm --filter @slothfulchat/core-wasm gen-template\` first`
  )
  process.exit(0)
}
const bad = Buffer.from(good)
bad.fill(0, 100, 4096) // keep the 100-byte file header, destroy the schema page

// The corruption has to actually be corruption, or the test proves nothing.
const probe = join(tmpdir(), 'account-template-probe.db')
writeFileSync(probe, bad)
try {
  new DatabaseSync(probe).prepare('SELECT count(*) FROM sqlite_master').get()
  console.error('FAIL: the crafted template still opens — this test would be vacuous')
  process.exit(1)
} catch {
  /* unreadable, as intended */
}

const { cleanup, watchdog } = await startServers({
  app: PORT,
  appRoot: pkg,
  appIndex: 'example/gen-template.html',
  watchdogMs: 3 * 60_000,
  label: 'account template fallback',
})
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
let failed = false
try {
  const page = await browser.newPage()
  page.on('pageerror', e => console.error('[pageerror]', e.message))
  let seeded = 0
  let discarded = 0
  page.on('console', m => {
    if (m.text().includes('from the account template')) seeded++
    if (m.text().includes('discarded it')) discarded++
  })
  await page.goto(`http://localhost:${PORT}/example/gen-template.html`)

  const out = await page.evaluate(async template => {
    const wasm = await import(new URL('../wasm-dist/deltachat_wasm.js', location.href).href)
    await wasm.default()
    wasm.set_account_template(Uint8Array.from(atob(template), c => c.charCodeAt(0)))
    const pending = new Map()
    const dc = await wasm.init(
      msg => {
        const m = JSON.parse(msg)
        if (m.id != null && pending.has(m.id)) pending.get(m.id)(m)
      },
      undefined,
      false // in-memory VFS: the fallback is VFS-agnostic and this keeps it quick
    )
    let seq = 0
    const call = (method, params = []) =>
      new Promise(res => {
        const id = ++seq
        pending.set(id, res)
        dc.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    const ids = [(await call('add_account')).result, (await call('add_account')).result]
    // an account left around an unopenable database fails here with "no SQL
    // connection" — this is the assertion that would have caught it
    const chats = await call('get_chatlist_entries', [ids[0], 0, null, null])
    const info = await call('get_account_info', [ids[0]])
    return { ids, chats: chats.result ?? chats.error, kind: info.result?.kind ?? info.error }
  }, bad.toString('base64'))

  const problems = []
  if (JSON.stringify(out.ids) !== '[1,2]') problems.push(`accounts not created: ${out.ids}`)
  if (!Array.isArray(out.chats)) problems.push(`account unusable: ${JSON.stringify(out.chats)}`)
  if (out.kind !== 'Unconfigured') problems.push(`unexpected account kind: ${out.kind}`)
  if (seeded !== 1) problems.push(`seeded ${seeded} times, expected exactly the first attempt`)
  if (discarded !== 1) problems.push(`discarded ${discarded} times, expected 1`)
  if (problems.length) {
    console.error(`FAIL: ${problems.join('; ')}`)
    failed = true
  } else {
    console.log(
      'OK: an unreadable template is discarded after one attempt and both accounts work'
    )
  }
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  await browser.close()
  if (watchdog) clearTimeout(watchdog)
  cleanup()
}
process.exit(failed ? 1 : 0)
