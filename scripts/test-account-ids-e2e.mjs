// Regression e2e for issue #75: chatmail core writes accounts.toml via
// write-tmp-then-rename. Pre-fix, that rename produced a trailing-slash OPFS
// key that dodged the synchronous write-through guard, and the async
// fallback always failed (a second createSyncAccessHandle on a file whose
// exclusive handle the worker itself holds -> NoModificationAllowedError).
// Net effect: OPFS accounts.toml stayed 0 bytes, and the NEXT boot's wasm
// self-heal fired ("accounts.toml is corrupt" in the console), rebuilding the
// account registry from the account dirs in uuid-sorted order — renumbering
// every account's id.
//
// This test creates several accounts, fingerprints each id via per-account
// config (which lives in per-account sqlite via opfs-sahpool and persists
// independently of the accounts.toml bug, making the fingerprint trustworthy),
// reloads, and asserts: no heal fired, and every id/fingerprint/selection
// survived. It also covers a *second*, later accounts.toml write (adding a
// 4th account after the first reload) through the same held OPFS handles.
//
// Modeled on scripts/smoke-core-wasm.mjs (server + example page) and
// scripts/test-persistence.mjs (console capture, watchdog, reload pattern).
// No networking/ws-proxy needed: add_account works without configuring.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../packages/core-wasm', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const path = normalize(join(root, urlPath))
    if (!path.startsWith(root)) throw new Error('traversal')
    const data = await readFile(path)
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise(resolve => server.listen(0, resolve))
const port = server.address().port

const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (3 min) — test hung')
  server.close()
  process.exit(1)
}, 180_000)

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => {
  const t = m.text()
  consoleTail.push(t.slice(0, 500))
  if (/panicked at/.test(t)) console.error('[page PANIC]', t)
})
page.on('pageerror', e => console.error('[pageerror]', e.message))

// raw JSON-RPC helper (snake_case method names, positional params array)
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.rpc.request(m, a), [method, args])

const url = `http://localhost:${port}/example/index.html` // persistence ON (default)

let failed = false
const fail = msg => {
  console.error('FAIL:', msg)
  failed = true
}

const bootAndWait = async () => {
  await page.waitForFunction(() => window.__systemInfo, null, { timeout: 120_000 })
}

const noHealFired = () =>
  !consoleTail.some(l => l.includes('accounts.toml is corrupt'))

const assertState = async (label, expected) => {
  // expected: { ids: number[], fingerprints: Map<id,string>, selected: number }
  const ids = await rpc('get_all_account_ids')
  const gotSorted = [...ids].sort((a, b) => a - b)
  const wantSorted = [...expected.ids].sort((a, b) => a - b)
  if (JSON.stringify(gotSorted) !== JSON.stringify(wantSorted)) {
    fail(`${label}: account id set changed. want [${wantSorted}], got [${gotSorted}]`)
    return
  }
  for (const id of expected.ids) {
    const displayname = await rpc('get_config', id, 'displayname')
    const want = expected.fingerprints.get(id)
    if (displayname !== want) {
      fail(`${label}: account ${id} fingerprint mismatch. want "${want}", got "${displayname}"`)
    }
  }
  const selected = await rpc('get_selected_account_id')
  if (selected !== expected.selected) {
    fail(`${label}: selected account changed. want ${expected.selected}, got ${selected}`)
  }
  if (!noHealFired()) {
    fail(`${label}: self-heal fired ("accounts.toml is corrupt" seen in console) — accounts.toml write-through was lost`)
    const line = consoleTail.find(l => l.includes('accounts.toml is corrupt'))
    console.error('  offending console line:', line)
  }
}

try {
  // -- boot 1: create 3 accounts, fingerprint each, select one --
  await page.goto(url)
  await bootAndWait()
  console.log('OK: core booted (persistence on)')

  const ids = []
  const fingerprints = new Map()
  for (let n = 1; n <= 3; n++) {
    const id = await rpc('add_account')
    const name = `acct-${n}`
    await rpc('set_config', id, 'displayname', name)
    ids.push(id)
    fingerprints.set(id, name)
    console.log(`OK: created account ${id} (${name})`)
  }
  // select account 2 (not the first) so selection-preservation is covered
  const selected = ids[1]
  await rpc('select_account', selected)
  console.log(`OK: selected account ${selected}`)

  if (!noHealFired()) {
    fail('self-heal fired during boot 1 — unexpected before any reload')
  }

  // -- reload 1: accounts.toml write-through must have landed in OPFS --
  await page.reload()
  await bootAndWait()
  console.log('OK: page reloaded (1st time)')

  await assertState('after reload 1', { ids, fingerprints, selected })
  if (!failed) {
    console.log(`OK: all ${ids.length} accounts + fingerprints + selection survived reload 1, no heal fired`)
  }

  // -- late-write coverage: a 4th account added AFTER the reload exercises a
  // LATER accounts.toml write through the same held OPFS sync-access handles
  // (the exact scenario the NoModificationAllowedError fallback used to hit)
  const id4 = await rpc('add_account')
  await rpc('set_config', id4, 'displayname', 'acct-4')
  ids.push(id4)
  fingerprints.set(id4, 'acct-4')
  // add_account auto-selects the new account; re-select the original one so
  // the assertion below still covers an explicit select_account write (one
  // more late accounts.toml write, too)
  await rpc('select_account', selected)
  console.log(`OK: created account ${id4} (acct-4) after reload 1, re-selected ${selected}`)

  // -- reload 2 --
  await page.reload()
  await bootAndWait()
  console.log('OK: page reloaded (2nd time)')

  await assertState('after reload 2', { ids, fingerprints, selected })
  if (!failed) {
    console.log(`OK: all ${ids.length} accounts + fingerprints + selection survived reload 2, no heal fired`)
  }

  if (!failed) console.log('PASS: account ids/fingerprints/selection survive reloads (issue #75)')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-80).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
