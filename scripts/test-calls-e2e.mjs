// Calls Playwright smoke test (docs/calls.md M5): load the REAL web-app (not
// just the core-wasm example), place a real outgoing audio call from one
// account against a second local wasm core acting as the callee ("local
// echo"), and assert the call reaches `connected` — i.e. both sides'
// `RTCPeerConnection.connectionState` becomes `'connected'` (see below for why
// the UI's "In call" text *is* that assertion, not a proxy for it).
//
// FULLY OFFLINE, no chatmail relay, no ws-tcp-proxy: two accounts are
// provisioned against a local mock "webimap" mail server (same technique as
// scripts/test-webimap.mjs) so this runs with zero network access — required
// here since `ice_servers()`'s STUN/TURN can't be reached from a sandboxed CI
// runner either, and isn't needed: both peers run on the SAME machine, so the
// non-trickle ICE gather (docs/calls.md: gather-until-relay-or-timeout) times
// out with only host candidates, which connect fine loopback-to-loopback.
//
// Design notes:
//  - Two SEPARATE BrowserContexts (== two separate wasm cores/workers/OPFS
//    origins), not two accounts in one page/core: `CallManager` in
//    packages/web-app/src/runtime.ts holds exactly one active call slot
//    PAGE-WIDE (`this.call`), so a single page cannot be both the caller's
//    outgoing leg and the callee's incoming leg at once (`openIncomingCall`
//    declines as busy while `this.call` is occupied). Two contexts == two
//    independent CallManagers, exactly like two real devices.
//  - Account provisioning + chat setup use the `window.exp.rpc` devmode
//    escape hatch (upstream's experimental.ts; same technique as
//    scripts/test-web-app-e2e.mjs and scripts/test-webimap.mjs) — this is
//    incidental setup, not the thing under test. The CALL ITSELF is driven
//    through the real UI: the ChatView call button's context menu (caller)
//    and the IncomingCallRing's Accept button (callee) — see
//    packages/calls/ui/CallOverlay.tsx / IncomingCallRing.tsx and the
//    un-gate patch (patches/desktop/0047-*.patch) that exposes the call
//    button for target === 'browser'.
//  - "assert connected": AudioCallEngine's `connectionstatechange` listener
//    (packages/calls/engine/audio-call.ts) transitions the call's state
//    machine to `'connected'` if-and-only-if `pc.connectionState ===
//    'connected'`; CallOverlay renders "In call" if-and-only-if `state ===
//    'connected'`. So waiting for the "In call" text in the real DOM *is*
//    asserting `RTCPeerConnection.connectionState === 'connected'`, just
//    observed the same way a user would — no debug hook into engine
//    internals needed.
//
// Requires packages/web-app/dist to be built first (pnpm assemble && pnpm
// build in packages/web-app, which also needs packages/core-wasm built) —
// same prerequisite as scripts/smoke-web-app.mjs / test-web-app-e2e.mjs. Not
// wired into CI (same reason test-web-app-e2e.mjs/test-webimap.mjs aren't:
// meant to be run locally / by a human with the wasm toolchain built) — see
// FINDINGS.md.
//
// Run:  node scripts/test-calls-e2e.mjs        (VERBOSE=1 for full page logs)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8644)
const verbose = !!process.env.VERBOSE

// ---------------------------------------------------------------------------
// mock "madmail" webimap server — fully offline, no TLS, no real network.
// Trimmed down from scripts/test-webimap.mjs (no 404-tolerance probes; this
// test isn't about the webimap transport, just needs two accounts that can
// message each other so `place_outgoing_call`/`accept_incoming_call`'s
// DeltaChat-message signaling actually round-trips).
// ---------------------------------------------------------------------------
const users = new Map() // email -> { password, nextUid, msgs: Map<uid, raw>, waiters: [] }
let userSeq = 0
const readBody = req =>
  new Promise(resolve => {
    let b = ''
    req.on('data', c => (b += c))
    req.on('end', () => resolve(b))
  })
const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}
const meta = (uid, raw) => ({
  uid,
  seq_num: uid,
  flags: [],
  size: Buffer.byteLength(raw),
  date: new Date().toISOString(),
  envelope: {},
})
const respondMessages = (res, user, sinceUid) => {
  const out = []
  for (const [uid, raw] of user.msgs) if (uid > sinceUid) out.push(meta(uid, raw))
  json(res, 200, out)
}

const mock = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  const url = new URL(req.url, 'http://mock')
  const path = url.pathname

  if (req.method === 'POST' && path === '/new') {
    const email = `u${++userSeq}@webimap.example`
    const password = randomBytes(9).toString('hex')
    users.set(email, { password, nextUid: 2, msgs: new Map(), waiters: [] })
    json(res, 200, { email, password, dclogin_url: '' })
    return
  }

  if (path.startsWith('/webimap/')) {
    const email = req.headers['x-email']
    const password = req.headers['x-password']
    const user = email && users.get(email)
    if (!user || user.password !== password) {
      json(res, 401, { error: 'bad credentials' })
      return
    }
    if (req.method === 'GET' && path === '/webimap/mailboxes') {
      const n = user.msgs.size
      json(res, 200, [{ name: 'INBOX', messages: n, unseen: n }])
      return
    }
    if (req.method === 'GET' && path === '/webimap/messages') {
      const sinceUid = Number(url.searchParams.get('since_uid') ?? '0') || 0
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 120)
      const hasNew = [...user.msgs.keys()].some(uid => uid > sinceUid)
      if (hasNew || wait <= 0) {
        respondMessages(res, user, sinceUid)
        return
      }
      const waiter = {
        timer: setTimeout(() => {
          user.waiters = user.waiters.filter(w => w !== waiter)
          respondMessages(res, user, sinceUid)
        }, wait * 1000),
        respond: () => respondMessages(res, user, sinceUid),
      }
      user.waiters.push(waiter)
      return
    }
    const m = path.match(/^\/webimap\/message\/(\d+)$/)
    if (m) {
      const uid = Number(m[1])
      if (req.method === 'GET') {
        const raw = user.msgs.get(uid)
        if (raw === undefined) {
          json(res, 404, { error: 'no such message' })
          return
        }
        json(res, 200, { ...meta(uid, raw), body: raw })
        return
      }
      if (req.method === 'DELETE') {
        user.msgs.delete(uid)
        json(res, 200, { status: 'ok' })
        return
      }
    }
    if (req.method === 'POST' && path === '/webimap/send') {
      let payload = {}
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        /* tolerate */
      }
      const recipients = []
        .concat(payload.to ?? [])
        .flatMap(r => (typeof r === 'string' ? r.split(/[,\s]+/) : []))
        .map(r => r.trim())
        .filter(Boolean)
      const body = payload.body ?? ''
      for (const rcpt of recipients) {
        const dest = users.get(rcpt)
        if (!dest) continue
        const uid = dest.nextUid++
        dest.msgs.set(uid, body)
        const waiters = dest.waiters
        dest.waiters = []
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.respond()
        }
      }
      json(res, 200, { status: 'sent' })
      return
    }
  }
  json(res, 404, { error: 'not found' })
})
await new Promise(r => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port
console.log(`mock madmail server on 127.0.0.1:${mockPort} (fully offline)`)
const qr = `webimapaccount:localhost:${mockPort}`

// ---------------------------------------------------------------------------
// serve the built web-app (pnpm assemble && pnpm build must have run already)
// ---------------------------------------------------------------------------
const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const procs = [appServer]
const cleanup = () => procs.forEach(p => p.kill())
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min) — test hung')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise(r => setTimeout(r, 500)) // let the static server bind

let failed = false
let browser
try {
  // Standard headless-WebRTC-testing flags: synthetic mic/camera, no
  // permission-prompt UI (both peers are same-machine loopback anyway).
  browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-permissions',
      '--use-fake-ui-for-fake-video-capture',
    ],
  })

  // Two independent contexts == two independent wasm cores/OPFS origins == two
  // independent devices, each with exactly one account (see design notes above
  // for why this can't be one page with two accounts).
  const makeCallerCallee = async label => {
    const context = await browser.newContext()
    await context.grantPermissions(['microphone', 'camera'])
    const page = await context.newPage()
    page.on('console', m => {
      const t = m.text()
      if (verbose || /error|warn|panic|failed|Failed/i.test(t)) {
        console.log(`[${label}]`, t.slice(0, 500))
      }
    })
    page.on('pageerror', e => console.error(`[${label} pageerror]`, e.message))
    // upstream's avoid-eval.js breaks page.evaluate; freeze the real eval first
    // (same workaround as scripts/smoke-web-app.mjs / test-web-app-e2e.mjs).
    await page.addInitScript(() => {
      Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
    })
    return { context, page }
  }
  const alice = await makeCallerCallee('alice')
  const bob = await makeCallerCallee('bob')

  const rpcOn = page => (method, ...args) =>
    page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

  // -- boot both cores + provision one webimap account each --------------
  const provision = async ({ page }) => {
    await page.goto(`http://localhost:${APP_PORT}/main.html`)
    await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
    const accountId = await page.evaluate(async qrStr => {
      const rpc = window.exp.rpc
      const id = await rpc.addAccount()
      await rpc.addTransportFromQr(id, qrStr)
      await rpc.startIo(id)
      return id
    }, qr)
    // The frontend's account list doesn't know about an account provisioned
    // behind its back via the devmode rpc escape hatch — reload so the
    // normal boot sequence lists it from the core, exactly like a returning
    // user (same technique as scripts/test-web-app-imex.mjs's restore flow).
    await page.reload()
    await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 60_000 })
    return accountId
  }
  const aliceId = await provision(alice)
  const bobId = await provision(bob)
  console.log(`OK: two webimap accounts provisioned (alice=${aliceId}, bob=${bobId})`)

  // -- key exchange + chat (RPC — incidental setup, not the call under test) --
  const bobVcard = await rpcOn(bob.page)('makeVcard', bobId, [1]) // 1 = ContactId::SELF
  const [bobContactId] = await rpcOn(alice.page)('importVcardContents', aliceId, bobVcard)
  await rpcOn(alice.page)('createChatByContactId', aliceId, bobContactId)
  console.log('OK: rpc — key exchange + 1:1 encrypted chat created')

  // M4 (docs/calls.md §Windowing): the active call PREFERS a detached
  // same-origin popup (`window.open`, allowed here because it runs
  // synchronously inside the real click gesture below) and falls back to the
  // in-page overlay only if the popup is blocked/unavailable. Both host the
  // SAME `CallOverlay`/`IncomingCallRing` components (packages/calls/ui), so
  // the dialog selectors below work unchanged either way — this helper just
  // finds out where the call UI actually landed.
  async function clickAndFollowPopup(context, mainPage, click) {
    const popupPromise = context.waitForEvent('page', { timeout: 5_000 }).catch(() => null)
    await click()
    const popup = await popupPromise
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      return popup
    }
    return mainPage
  }

  // -- CALLER: real UI — open the chat, click Call, choose Audio Call -----
  await alice.page.reload() // pick up the chat just created out-of-band
  const bobChat = alice.page.locator('.chat-list .chat-list-item').first()
  await bobChat.waitFor({ state: 'visible', timeout: 30_000 })
  await bobChat.click()
  await alice.page.getByRole('button', { name: 'Call' }).click()
  const aliceCallPage = await clickAndFollowPopup(alice.context, alice.page, () =>
    alice.page.getByRole('menuitem', { name: 'Audio Call' }).click()
  )
  console.log(
    `OK: alice placed an outgoing audio call via the real ChatView UI (${aliceCallPage === alice.page ? 'main-window overlay' : 'detached popup'})`
  )

  // -- CALLEE ("local echo"/second core): real UI — accept the ring ------
  // Ringing always renders in the main window (docs/calls.md §Windowing) —
  // only the Accept gesture may hand off to a popup.
  // Generous timeout: non-trickle ICE gathers for up to
  // DEFAULT_GATHER_TIMEOUT_MS (10s, packages/calls/bridge/index.ts) with no
  // relay configured in this offline setup, so it always runs to the full
  // timeout before the offer is even sent.
  const ring = bob.page.getByRole('dialog', { name: 'Incoming call' })
  await ring.waitFor({ state: 'visible', timeout: 60_000 })
  const bobCallPage = await clickAndFollowPopup(bob.context, bob.page, () =>
    ring.getByRole('button', { name: 'Accept' }).click()
  )
  console.log(
    `OK: bob (second core) accepted the incoming call via the real ring UI (${bobCallPage === bob.page ? 'main-window overlay' : 'detached popup'})`
  )

  // -- assert both RTCPeerConnections reached 'connected' -----------------
  // CallOverlay renders the literal text "In call" iff the engine's state
  // machine is 'connected', which itself only happens on
  // `pc.connectionState === 'connected'` (packages/calls/engine/audio-call.ts
  // `connectionListener`) — see the design note at the top of this file.
  const callDialog = page => page.getByRole('dialog', { name: 'Call' })
  // Another up-to-10s ICE gather on the answer side, then the answer travels
  // back through the mock mail transport before the two peers can actually
  // connect — budget generously.
  await callDialog(aliceCallPage)
    .filter({ hasText: 'In call' })
    .waitFor({ state: 'visible', timeout: 60_000 })
  console.log("OK: alice's RTCPeerConnection reached 'connected' (\"In call\" shown)")
  await callDialog(bobCallPage)
    .filter({ hasText: 'In call' })
    .waitFor({ state: 'visible', timeout: 60_000 })
  console.log("OK: bob's RTCPeerConnection reached 'connected' (\"In call\" shown)")

  console.log('PASS: calls e2e — outgoing call against a local second core reached connected')
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser?.close()
  cleanup()
  mock.close()
}
process.exit(failed ? 1 : 0)
