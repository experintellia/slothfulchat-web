// Generates packages/core-wasm/wasm-dist/fresh_account.db.gz: the pre-migrated,
// unconfigured account database that `set_account_template` stamps every new
// account out of, so account creation is one bulk write instead of ~46
// migrations × one commit each (issue #14, ~1.7s per account on OPFS).
//
// It is produced BY the wasm artifact it ships next to — boot the freshly built
// core headless, create an account the normal way, take the database bytes back
// out — so it cannot describe a schema this build does not have. Nothing is
// checked in and there is no staleness gate to keep green: migrations are
// `dbversion < N` gated, so even a template built by an older core is correct,
// just slower by the migrations added since.
//
// Run after `pnpm --filter @slothfulchat/core-wasm build:wasm`.
//
// Two assertions guard the premise, both fatal:
//   1. two independently migrated accounts are byte-for-byte equivalent
//      (no per-account or non-deterministic state — the reason ONE template
//      can serve every account),
//   2. an account seeded from the template matches a migrated one.
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const PORT = 8655
const pkg = fileURLToPath(new URL('../packages/core-wasm', import.meta.url))
const out = join(pkg, 'wasm-dist/fresh_account.db.gz')

/** Creates `count` accounts in a fresh core booted from the built wasm, and
 * returns each one's database as base64, `{db, wal}`. `template` (base64) is
 * installed before init when given. */
async function makeAccounts(browser, count, template) {
  const page = await browser.newPage()
  page.on('pageerror', e => console.error('[pageerror]', e.message))
  await page.goto(`http://localhost:${PORT}/example/gen-template.html`)
  return page.evaluate(
    async ([count, template]) => {
      const wasm = await import(new URL('../wasm-dist/deltachat_wasm.js', location.href).href)
      await wasm.default()
      const b64 = bytes => {
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(s)
      }
      if (template)
        wasm.set_account_template(Uint8Array.from(atob(template), c => c.charCodeAt(0)))

      const pending = new Map()
      const dc = await wasm.init(
        msg => {
          const m = JSON.parse(msg)
          if (m.id != null && pending.has(m.id)) pending.get(m.id)(m)
        },
        undefined,
        false // persist=0: the in-memory VFS, so generation never touches OPFS
      )
      let seq = 0
      const call = method =>
        new Promise((resolve, reject) => {
          const id = ++seq
          pending.set(id, m => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
          dc.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }))
        })

      for (let i = 0; i < count; i++) await call('add_account')

      // An account's data dir name is its uuid; accounts.toml is the registry.
      const toml = new TextDecoder().decode(dc.fs_read('/accounts/accounts.toml'))
      const dirs = [...toml.matchAll(/^dir = "(.+)"$/gm)].map(m => m[1])
      if (dirs.length !== count) throw new Error(`expected ${count} accounts, registry has ${dirs.length}`)

      // Take the -wal too: the migrations committed into it and nothing has
      // checkpointed yet, so the main file alone is a pre-migration schema.
      // node:sqlite replays it on open.
      return dirs.map(dir => {
        const path = `/accounts/${dir}/dc.db`
        let wal = null
        try {
          wal = b64(wasm.take_db(`${path}-wal`))
        } catch {
          /* checkpointed already — everything is in the main file */
        }
        return { db: b64(wasm.take_db(path)), wal }
      })
    },
    [count, template ?? null]
  )
}

/** Writes one taken account to `dir/<name>.db` (+ its wal) and returns the path. */
async function land(tmp, name, account) {
  const path = join(tmp, `${name}.db`)
  await writeFile(path, Buffer.from(account.db, 'base64'))
  if (account.wal) await writeFile(`${path}-wal`, Buffer.from(account.wal, 'base64'))
  return path
}

/** Everything the database says about itself: schema plus the full contents of
 * every table. A fresh account holds only static seed rows, so two of them
 * compare equal — anything per-account or time-dependent shows up here. */
function fingerprint(path) {
  const db = new DatabaseSync(path)
  const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()
  const rows = {}
  for (const { type, name } of schema)
    if (type === 'table') rows[name] = db.prepare(`SELECT * FROM "${name}"`).all()
  db.close()
  return JSON.stringify({ schema, rows }, (_, v) => (typeof v === 'bigint' ? String(v) : v), 1)
}

const { cleanup, watchdog } = await startServers({
  app: PORT,
  appRoot: pkg,
  appIndex: 'example/gen-template.html',
  watchdogMs: 5 * 60_000,
  label: 'account template generation',
})
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const tmp = await mkdtemp(join(tmpdir(), 'account-template-'))
let failed = false
try {
  const [first, second] = await makeAccounts(browser, 2)

  const a = fingerprint(await land(tmp, 'a', first))
  const b = fingerprint(await land(tmp, 'b', second))
  if (a !== b) {
    await writeFile(join(tmp, 'a.json'), a)
    await writeFile(join(tmp, 'b.json'), b)
    throw new Error(
      `two freshly migrated accounts differ — a fresh account is no longer\n` +
        `identical across accounts, so ONE template cannot serve all of them.\n` +
        `Diff ${join(tmp, 'a.json')} against ${join(tmp, 'b.json')}.`
    )
  }
  console.log('OK: two freshly migrated accounts are identical')

  // VACUUM INTO: checkpoints the wal, repacks the pages and drops free space,
  // so the shipped template is the smallest correct file — and the copy the
  // browser writes back is that much smaller.
  const templatePath = join(tmp, 'template.db')
  const src = new DatabaseSync(join(tmp, 'a.db'))
  src.exec(`VACUUM INTO '${templatePath}'`)
  src.close()
  const template = await readFile(templatePath)

  const seeded = await makeAccounts(browser, 1, template.toString('base64'))
  const seededPage = fingerprint(await land(tmp, 'seeded', seeded[0]))
  if (seededPage !== a) throw new Error('an account seeded from the template differs from a migrated one')
  console.log('OK: an account seeded from the template matches a migrated one')

  const gz = gzipSync(template, { level: 9 })
  await writeFile(out, gz)
  console.log(
    `wrote wasm-dist/fresh_account.db.gz — ${template.length} bytes of database, ${gz.length} over the wire`
  )
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  await browser.close()
  if (!failed) await rm(tmp, { recursive: true, force: true })
  if (watchdog) clearTimeout(watchdog)
  cleanup()
}
process.exit(failed ? 1 : 0)
