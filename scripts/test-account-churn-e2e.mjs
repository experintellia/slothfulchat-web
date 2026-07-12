// Regression e2e for the post-#75 boot CANTOPEN incident (fixed in
// e01d820, "opfs: reclaim sahpool slots of removed accounts; gate the
// self-heal"): `remove_account` removed only the memfs keys, never the
// account's sqlite files -- those live SOLELY in the opfs-sahpool VFS and
// never touch the memfs -- so every removed account permanently burned one
// of the pool's fixed 32 slots. Enough add+remove churn (a handful of users
// trying an account then deleting it, or an account removed after a bad
// login) filled the pool; the next database open failed
// "unable to open database file" (SQLITE_CANTOPEN, "Error code 14"), at
// BOOT too, and the self-heal made it worse -- quarantining a perfectly
// valid accounts.toml and rebuilding it identically (a boot loop).
//
// This test churns ~32 add+remove cycles (enough to have saturated the
// pre-fix 32-slot ceiling well before the last cycle -- the repro this test
// supersedes, scripts/repro-pool-leak-on-remove.mjs, broke around cycle 29
// with only 3 live accounts) around 3 permanently-live accounts, then adds a
// 4th keeper, reloads, and asserts:
//   (a) no CANTOPEN/"Error code 14" anywhere in the console
//   (b) no "accounts.toml is corrupt" self-heal line
//   (c) all 4 keeper accounts + their displayname fingerprints survive reload
//   (d) pool forensics stay bounded: named sahpool slots don't grow with the
//       cycle count -- they track live accounts plus a small constant
//       (asserted as named <= live + 6), where pre-fix every cycle leaked
//       one more slot forever.
//
// Modeled on scripts/test-account-ids-e2e.mjs (rpc/boot/reload harness,
// fingerprint-via-displayname pattern) and the pool-forensics helpers in the
// uncommitted scripts/repro-pool-leak-on-remove.mjs (which first isolated
// this failure mode and is superseded by this committed test).
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

const CHURN_CYCLES = Number(process.argv[2] ?? 32) // add+remove cycles

const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min) — test hung')
  server.close()
  process.exit(1)
}, 360_000)

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const consoleTail = []
page.on('console', m => {
  const t = m.text()
  consoleTail.push(t.slice(0, 1000))
  if (/panicked at/.test(t)) console.error('[page PANIC]', t)
})
page.on('pageerror', e => console.error('[pageerror]', e.message))

const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.rpc.request(m, a), [method, args])

const url = `http://localhost:${port}/example/index.html` // persistence ON (default)

let failed = false
const fail = msg => {
  console.error('FAIL:', msg)
  failed = true
}

const bootAndWait = async (timeout = 60_000) => {
  await page.waitForFunction(
    () => !!window.__systemInfo || document.getElementById('fatal-hint')?.style.display === 'block',
    null, { timeout }
  )
}
const readFatalHint = () =>
  page.evaluate(() => document.getElementById('fatal-hint')?.innerText || null)

// Pool forensics: read the sahpool opaque-file headers from the main thread
// (OPFS is origin-scoped; directory listing + reading a file's bytes doesn't
// need the worker's exclusive sync-access-handle lock on most engines, though
// a file the worker currently holds open may throw -- ignored here, we only
// count what we CAN name).
const enumeratePool = async () => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  let sahpoolDir
  try { sahpoolDir = await root.getDirectoryHandle('.opfs-sahpool') }
  catch { return { fileCount: 0, named: [] } }
  const opaque = await sahpoolDir.getDirectoryHandle('.opaque')
  const named = []
  let fileCount = 0
  for await (const [, handle] of opaque.entries()) {
    fileCount++
    try {
      const file = await handle.getFile()
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf, 0, Math.min(512, buf.byteLength))
      let end = bytes.indexOf(0)
      if (end === -1) end = bytes.length
      const name = new TextDecoder('utf-8', { fatal: false })
        .decode(bytes.subarray(0, end)).replace(/[^\x20-\x7e]/g, '')
      if (name) named.push(name)
    } catch { /* held by worker; ignore for this coarse pass */ }
  }
  return { fileCount, named }
})

const PROD_ERRORS = ['unable to open database file', 'Error code 14', 'accounts.toml is corrupt', 'self-heal failed']
const findProdErrors = () => PROD_ERRORS.filter(needle => consoleTail.some(l => l.includes(needle)))

try {
  await page.goto(url)
  await bootAndWait()
  console.log('OK: core booted fresh (persistence on, empty origin)')

  // 3 permanently-live accounts, fingerprinted via displayname (survives
  // independently of accounts.toml, per test-account-ids-e2e.mjs's rationale).
  const ids = []
  const fingerprints = new Map()
  for (let n = 1; n <= 3; n++) {
    const id = await rpc('add_account')
    const name = `keeper-${n}`
    await rpc('set_config', id, 'displayname', name)
    ids.push(id)
    fingerprints.set(id, name)
  }
  console.log(`OK: 3 permanently-live accounts created: ${JSON.stringify(ids)}`)

  // ~32 add+remove churn cycles -- each permanently leaked a pool slot
  // pre-fix. 3 live accounts stay untouched throughout.
  let brokeAt = null
  for (let c = 1; c <= CHURN_CYCLES; c++) {
    let churnId
    let stageErr = null
    try {
      churnId = await rpc('add_account')
      await rpc('set_config', churnId, 'displayname', `churn-${c}`)
    } catch (e) {
      stageErr = `create failed: ${e.message}`
    }
    if (!stageErr) {
      try {
        await rpc('remove_account', churnId)
      } catch (e) {
        stageErr = `remove failed: ${e.message}`
      }
    }
    const prodErrs = findProdErrors()
    if (stageErr || prodErrs.length > 0) {
      brokeAt = { cycle: c, stageErr, prodErrs }
      console.error(`FAIL: churn cycle ${c} broke: ${JSON.stringify(brokeAt)}`)
      for (const l of consoleTail) if (PROD_ERRORS.some(n => l.includes(n))) console.error('  |', l)
      fail(`churn cycle ${c} hit a production-error symptom or an RPC failure — pool slot leak regressed`)
      break
    }
  }
  if (!brokeAt) console.log(`OK: ${CHURN_CYCLES} add+remove churn cycles completed with no CANTOPEN/heal symptoms`)

  // 4th keeper account, created AFTER the churn (mirrors the late-write
  // coverage in test-account-ids-e2e.mjs, and exercises add_account right
  // after the pool has absorbed the churn).
  if (!failed) {
    const id4 = await rpc('add_account')
    const name4 = 'keeper-4'
    await rpc('set_config', id4, 'displayname', name4)
    ids.push(id4)
    fingerprints.set(id4, name4)
    console.log(`OK: 4th keeper account created after churn: ${id4}`)
  }

  const poolBeforeReload = await enumeratePool()
  console.log(`pool before reload: fileCount=${poolBeforeReload.fileCount} namedSlots=${poolBeforeReload.named.length}`)

  // -- reload: this is where boot re-opens every account in accounts.toml,
  // and where the pre-fix incident's CANTOPEN + heal-quarantine-loop fired --
  console.log('\n--- reload after churn ---')
  await page.reload()
  let bootOk = true
  try { await bootAndWait(60_000) } catch { bootOk = false }
  await page.waitForTimeout(500)
  const sysInfo = await page.evaluate(() => window.__systemInfo ?? null).catch(() => null)
  const fatalHint = await readFatalHint().catch(() => null)
  console.log(`post-churn reload: bootOk=${bootOk} systemInfo=${!!sysInfo} fatalHint=${JSON.stringify(fatalHint)}`)

  if (!failed) {
    if (!bootOk || !sysInfo) {
      fail(`boot failed after churn reload (bootOk=${bootOk} systemInfo=${!!sysInfo} fatalHint=${JSON.stringify(fatalHint)})`)
    }
  }

  // (a) no CANTOPEN/"Error code 14" anywhere in the console
  const cantopen = consoleTail.filter(l => l.includes('Error code 14') || l.includes('unable to open database file'))
  if (cantopen.length > 0) {
    fail(`SQLITE_CANTOPEN symptom seen in console (${cantopen.length} line(s)) — pool slot leak regressed`)
    for (const l of cantopen) console.error('  |', l)
  } else {
    console.log('OK: no "Error code 14" / CANTOPEN anywhere in console')
  }

  // (b) no "accounts.toml is corrupt" heal line
  const healLines = consoleTail.filter(l => l.includes('accounts.toml is corrupt'))
  if (healLines.length > 0) {
    fail(`self-heal fired ("accounts.toml is corrupt") on a valid config — heal gating regressed`)
    for (const l of healLines) console.error('  |', l)
  } else {
    console.log('OK: no "accounts.toml is corrupt" self-heal line (config was never bogusly quarantined)')
  }

  // (c) all 4 keeper accounts present with fingerprints after reload
  if (!failed) {
    const gotIds = await rpc('get_all_account_ids')
    const gotSorted = [...gotIds].sort((a, b) => a - b)
    const wantSorted = [...ids].sort((a, b) => a - b)
    if (JSON.stringify(gotSorted) !== JSON.stringify(wantSorted)) {
      fail(`account id set changed across churn+reload. want [${wantSorted}], got [${gotSorted}]`)
    } else {
      for (const id of ids) {
        const displayname = await rpc('get_config', id, 'displayname')
        const want = fingerprints.get(id)
        if (displayname !== want) {
          fail(`account ${id} fingerprint mismatch after churn+reload. want "${want}", got "${displayname}"`)
        }
      }
      if (!failed) console.log(`OK: all ${ids.length} keeper accounts + fingerprints survived churn + reload`)
    }
  }

  // (d) pool forensics: named slots stay bounded, not growing with cycle
  // count. Pre-fix, every churn cycle leaked one more named slot forever;
  // fixed, named tracks live accounts (ids.length) plus a small constant
  // (transient wal/journal + in-flight opens) regardless of CHURN_CYCLES.
  const finalPool = await enumeratePool()
  const liveAccounts = ids.length
  const boundedLimit = liveAccounts + 6
  console.log(`final pool: fileCount=${finalPool.fileCount} namedSlots=${finalPool.named.length} liveAccounts=${liveAccounts} boundedLimit=${boundedLimit}`)
  if (finalPool.named.length > boundedLimit) {
    fail(
      `pool forensics: named slots (${finalPool.named.length}) exceed live accounts + 6 (${boundedLimit}) ` +
      `after ${CHURN_CYCLES} churn cycles — looks like the pre-fix per-removal leak (named slot count should ` +
      `track live accounts, not churn cycles)`
    )
  } else {
    console.log(`OK: pool forensics bounded (named=${finalPool.named.length} <= live+6=${boundedLimit}), not growing with churn cycle count`)
  }

  console.log('\n--- console lines matching corruption/heal/CANTOPEN (verbatim) ---')
  for (const l of consoleTail) {
    if (/corrupt|quarantin|rebuil|heal|CANTOPEN|Error code 14|unable to open database|reclaimed.*orphan/i.test(l)) {
      console.log('  |', l)
    }
  }

  if (!failed) console.log(`\nPASS: ${CHURN_CYCLES} add+remove churn cycles left no CANTOPEN/heal symptoms, pool stayed bounded, all keeper accounts survived reload`)
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-150).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
