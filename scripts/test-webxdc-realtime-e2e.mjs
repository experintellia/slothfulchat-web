// webxdc realtime channels (joinRealtimeChannel) at the core level — fully
// offline: real wasm core, two accounts in one tab, a webxdc sent between them
// over the mock madmail server, and a local iroh-relay in dev mode (plain http
// on 127.0.0.1) as both accounts' home relay. Drives the same RPCs the webxdc
// bridge does (sendWebxdcRealtimeAdvertisement / sendWebxdcRealtimeData,
// WebxdcRealtimeData events), then:
//
//   1. both advertise; Alice sends until Bob hears one (= join latency)
//   2. N round trips Alice -> Bob -> Alice, echoed inside the page so the
//      numbers are core+relay+event loop, not Playwright overhead
//   3. payload bytes arrive unchanged both ways; leaving stops delivery
//   4. the same through the app API: both open a webxdc app in the real UI
//      runtime, which joins with webxdc.joinRealtimeChannel(); Bob's app
//      echoes, Alice's app times round trips from inside its own frame
//      (app -> bridge -> core -> relay -> core -> bridge -> app and back)
//
// The relay is named per account with the `iroh_relay` config (core/1027):
// webimap has no IMAP METADATA, where chatmail servers advertise theirs.
//
// Needs the iroh-relay binary (same version as iroh in
// packages/core-wasm/rust/Cargo.lock), else it SKIPS:
//   cargo install iroh-relay --version 0.35.0 --features server --locked
// IROH_RELAY_BIN overrides the path. Ports: app 8695, relay 8697.
// Run:  node scripts/test-webxdc-realtime-e2e.mjs      (N=200 for more samples)
import { crc32 } from 'node:zlib'
import { chromium } from 'playwright'
import { freezeEval, logPanics, startIrohRelay, startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const PORT = Number(process.env.APP_PORT ?? 8695)
const RELAY_PORT = 8697
const N = Number(process.env.N ?? 50)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const relay = await startIrohRelay(RELAY_PORT)
if (!relay) {
  console.log(
    'SKIP: no iroh-relay binary (IROH_RELAY_BIN overrides the path). Install it with\n' +
      '  cargo install iroh-relay --version 0.35.0 --features server --locked'
  )
  process.exit(0)
}
const RELAY = relay.url

// ponytail: one-entry stored zip (the multi-file one lives in test-webxdc-e2e.mjs)
function storedZip(name, content) {
  const n = Buffer.from(name)
  const d = Buffer.from(content)
  const crc = crc32(d)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(d.length, 18)
  local.writeUInt32LE(d.length, 22)
  local.writeUInt16LE(n.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(d.length, 20)
  central.writeUInt32LE(d.length, 24)
  central.writeUInt16LE(n.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + n.length, 12)
  end.writeUInt32LE(30 + n.length + d.length, 16)
  return Buffer.concat([local, n, d, central, n, end])
}
// manifest.toml is optional; index.html alone is a valid webxdc
const XDC = storedZip('index.html', '<!doctype html><title>Realtime</title>')
// 4.: a real app on webxdc.js
const APP_XDC = storedZip(
  'index.html',
  `<!doctype html><title>Realtime App</title><script src="webxdc.js"></script><script>
  window.got = []
  const waiters = new Map()
  const rt = webxdc.joinRealtimeChannel()
  rt.setListener(d => {
    window.got.push(Array.from(d))
    if (webxdc.selfName === 'Bob') rt.send(d) // echo
    else waiters.get(d.join(','))?.(performance.now())
  })
  window.rt = rt
  window.ping = (data, timeout = 5000) => new Promise((resolve, reject) => {
    const key = data.join(','), t0 = performance.now()
    const timer = setTimeout(() => (waiters.delete(key), reject(new Error('timeout'))), timeout)
    waiters.set(key, t1 => (clearTimeout(timer), waiters.delete(key), resolve(t1 - t0)))
    rt.send(new Uint8Array(data))
  })
  </script>`
)

const mock = await startMockMadmail()
const { cleanup: stopServers, watchdog } = await startServers({
  app: PORT,
  appRoot: process.env.SERVE_ROOT,
  watchdogMs: 300_000,
  label: 'webxdc realtime e2e',
})
const cleanup = () => (stopServers(), mock.close(), relay.kill())
process.on('exit', cleanup)

let failed = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed++
}
const until = async (what, fn, ms = 60_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(300)
  }
}

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))
logPanics(page)
if (process.env.VERBOSE) page.on('console', m => m.text().startsWith('[core ') && console.log(m.text()))
await freezeEval(page)
const rpc = (method, ...args) =>
  page.evaluate(
    ([m, a]) =>
      window.exp.rpc[m](...a).catch(e => {
        throw new Error(`${m}: ${e?.message ?? JSON.stringify(e)}`)
      }),
    [method, args]
  )

try {
  await page.goto(`http://localhost:${PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, `webimapaccount:127.0.0.1:${mock.port}`)
    await rpc('setConfig', id, 'displayname', name)
    // before the first realtime call: core binds its iroh endpoint once, lazily
    await rpc('setConfig', id, 'iroh_relay', RELAY)
    await rpc('startIo', id)
    return id
  }
  const alice = await setup('Alice')
  const bob = await setup('Bob')
  const [bobContact] = await rpc('importVcardContents', alice, await rpc('makeVcard', bob, [1]))
  await rpc('importVcardContents', bob, await rpc('makeVcard', alice, [1]))
  const chat = await rpc('createChatByContactId', alice, bobContact)
  const file = await page.evaluate(
    b64 => window.exp.runtime.writeTempFileFromBase64('rt.xdc', b64),
    XDC.toString('base64')
  )
  const aliceXdc = await rpc('sendMsg', alice, chat, { file, filename: 'rt.xdc', viewtype: 'Webxdc' })
  const bobXdc = await until('the webxdc reaches Bob', async () => {
    for (const c of await rpc('getChatlistEntries', bob, 0, null, null))
      for (const id of await rpc('getMessageIds', bob, c, false, false))
        if ((await rpc('getMessage', bob, id)).viewType === 'Webxdc') return id
  })
  // advertising sends a (hidden) message, which a contact request refuses
  await rpc('acceptChat', bob, (await rpc('getMessage', bob, bobXdc)).chatId)

  // Tap both accounts' WebxdcRealtimeData events. Bob echoes every payload
  // straight back from inside the page; Alice resolves the waiter for it.
  // The UI creates the per-account emitters (TinyEmitter) as accounts appear,
  // so borrow the class from one of them.
  await until('an account emitter', () =>
    page.evaluate(() => Object.keys(window.exp.getContextEmitters()).length > 0)
  )
  await page.evaluate(
    ([alice, bob, aliceXdc, bobXdc]) => {
      const ems = window.exp.getContextEmitters()
      const Emitter = Object.values(ems)[0].constructor
      const rt = (window.__rt = { got: { [alice]: [], [bob]: [] }, waiters: new Map(), sent: {}, ads: {} })
      for (const id of [alice, bob]) {
        ems[id] ??= new Emitter()
        ems[id].on('WebxdcRealtimeData', ev => {
          rt.got[id].push({ ...ev, t: performance.now() })
          if (id === bob) window.exp.rpc.sendWebxdcRealtimeData(bob, bobXdc, ev.data)
          else rt.waiters.get(ev.data.join(','))?.(performance.now())
        })
        // VERBOSE=1: core's realtime log lines, which say where a join stalls
        ems[id].on('WebxdcRealtimeAdvertisementReceived', () => (rt.ads[id] = (rt.ads[id] ?? 0) + 1))
        ems[id].on('ALL', ev => /IROH|iroh|gossip|relay/i.test(ev.msg ?? '') && console.log(`[core ${id}] ${ev.kind} ${ev.msg}`))
      }
      // one round trip: Alice sends `data`, resolves with the RTT in ms
      rt.ping = (data, timeout = 5000) =>
        new Promise((resolve, reject) => {
          const key = data.join(',')
          const t0 = (rt.sent[key] = performance.now())
          const timer = setTimeout(() => (rt.waiters.delete(key), reject(new Error('timeout'))), timeout)
          rt.waiters.set(key, t1 => (clearTimeout(timer), rt.waiters.delete(key), resolve(t1 - t0)))
          window.exp.rpc.sendWebxdcRealtimeData(alice, aliceXdc, data).catch(reject)
        })
    },
    [alice, bob, aliceXdc, bobXdc]
  )

  // 1. join: Alice opens the app (advertises), Bob gets her advertisement,
  // then Bob opens it too — the usual order. Then Alice sends every 100 ms
  // until Bob hears one. There is no "joined" event, so a send before the
  // swarm forms is silently dropped — this is that window.
  // ponytail: not both at once — when both advertise together, each side
  // dials the other and iroh-gossip 0.35 can drop both connections; ~1 run in
  // 5 then never joins (no recovery within 60 s; re-advertising does recover
  // it). Upstream gossip behaviour, not wasm; revisit with the iroh bump.
  await rpc('sendWebxdcRealtimeAdvertisement', alice, aliceXdc)
  await until('Bob gets Alice\'s advertisement', () => page.evaluate(b => window.__rt.ads[b], bob))
  const t0 = Date.now()
  await rpc('sendWebxdcRealtimeAdvertisement', bob, bobXdc)
  for (let i = 0; !(await page.evaluate(b => window.__rt.got[b].length, bob)); i++) {
    if (Date.now() - t0 > 60_000) throw new Error('Bob never heard Alice: the gossip did not join')
    await rpc('sendWebxdcRealtimeData', alice, aliceXdc, [0, i & 255, i >> 8])
    await sleep(100)
  }
  const joinMs = Date.now() - t0
  check(true, `the realtime channel joins via the local relay (${joinMs} ms after Bob advertises)`)
  await sleep(500) // let the join probes' echoes drain

  // 2. round trips; payloads carry spread byte values to catch encoding slips
  const rtts = await page.evaluate(async n => {
    const out = []
    for (let i = 0; i < n; i++) {
      const data = [1, i & 255, i >> 8, ...Array.from({ length: 32 }, (_, k) => (i + k * 8) & 255)]
      out.push(await window.__rt.ping(data))
    }
    return out
  }, N)
  check(rtts.length === N, `${N} of ${N} round trips Alice -> Bob -> Alice delivered`)
  const bytesOk = await page.evaluate(
    ([a, b]) => {
      const sent = window.__rt.got[b].filter(e => e.data[0] === 1).map(e => e.data.join(','))
      const back = window.__rt.got[a].filter(e => e.data[0] === 1).map(e => e.data.join(','))
      return sent.length > 0 && sent.join('|') === back.join('|')
    },
    [alice, bob]
  )
  check(bytesOk, 'payloads arrive byte-for-byte, as number[], in order')
  const s = [...rtts].sort((x, y) => x - y)
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1)
  console.log(`round trip ms (n=${N}): min ${q(0)}  median ${q(0.5)}  p95 ${q(0.95)}  max ${q(1)}`)
  const oneWay = await page.evaluate(b => {
    const rt = window.__rt
    const d = rt.got[b].filter(e => e.data[0] === 1).map(e => e.t - rt.sent[e.data.join(',')])
    return d.sort((x, y) => x - y)[d.length >> 1].toFixed(1)
  }, bob)
  console.log(`one way Alice -> Bob ms: median ${oneWay}`)

  // 3. after Bob leaves, nothing reaches him
  await rpc('leaveWebxdcRealtime', bob, bobXdc)
  const before = await page.evaluate(b => window.__rt.got[b].length, bob)
  for (let i = 0; i < 5; i++) await rpc('sendWebxdcRealtimeData', alice, aliceXdc, [2, i])
  await sleep(1500)
  check((await page.evaluate(b => window.__rt.got[b].length, bob)) === before, 'leaving stops delivery')

  // 4. the app API, through the real runtime (webxdc.ts) and webxdc.js
  await page.evaluate(() => window.exp.runtime.setDesktopSetting('webxdcWarning', false))
  const appFile = await page.evaluate(
    b64 => window.exp.runtime.writeTempFileFromBase64('rtapp.xdc', b64),
    APP_XDC.toString('base64')
  )
  const aliceApp = await rpc('sendMsg', alice, chat, { file: appFile, filename: 'rtapp.xdc', viewtype: 'Webxdc' })
  const bobApp = await until('the app reaches Bob', async () => {
    for (const id of await rpc('getMessageIds', bob, (await rpc('getMessage', bob, bobXdc)).chatId, false, false)) {
      if ((await rpc('getMessage', bob, id)).viewType === 'Webxdc' && (await rpc('getWebxdcInfo', bob, id)).name === 'rtapp.xdc') return id
    }
  })
  const openApp = (acc, msgId, name) =>
    page.evaluate(
      async ([acc, msgId, name]) => {
        const webxdcInfo = await window.exp.rpc.getWebxdcInfo(acc, msgId)
        window.exp.runtime.openWebxdc(msgId, { accountId: acc, displayname: name, chatName: 'chat', webxdcInfo, href: '' })
      },
      [acc, msgId, name]
    )
  const appFrame = who =>
    until(`${who}'s app`, async () => {
      for (const f of page.context().pages().flatMap(p => p.frames())) {
        if (!/\.webxdc\.localhost/.test(f.url())) continue
        if ((await f.evaluate(() => window.webxdc?.selfName).catch(() => null)) === who) return f
      }
    })
  const adsBefore = await page.evaluate(b => window.__rt.ads[b] ?? 0, bob)
  await openApp(alice, aliceApp, 'Alice')
  const aliceFrame = await appFrame('Alice')
  await until('Bob gets the app\'s advertisement', async () => (await page.evaluate(b => window.__rt.ads[b] ?? 0, bob)) > adsBefore)
  const t1 = Date.now()
  await openApp(bob, bobApp, 'Bob')
  const bobFrame = await appFrame('Bob')
  // join: Alice's app pings until one comes back
  for (let i = 0; ; i++) {
    if (Date.now() - t1 > 60_000) throw new Error('the apps never joined')
    if (await aliceFrame.evaluate(i => window.ping([9, i & 255], 300).then(() => true, () => false), i)) break
  }
  check(true, `two apps join through webxdc.joinRealtimeChannel (${Date.now() - t1} ms after Bob's opens)`)
  const appRtts = await aliceFrame.evaluate(async n => {
    const out = []
    for (let i = 0; i < n; i++) out.push(await window.ping([3, i & 255, i >> 8, ...Array.from({ length: 32 }, (_, k) => (i * 7 + k) & 255)]))
    return out
  }, N)
  check(appRtts.length === N, `${N} of ${N} app-to-app round trips delivered`)
  const a = [...appRtts].sort((x, y) => x - y)
  const qa = p => a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1)
  console.log(`app round trip ms (n=${N}): min ${qa(0)}  median ${qa(0.5)}  p95 ${qa(0.95)}  max ${qa(1)}`)
  check(
    await bobFrame.evaluate(() => window.got.every(d => Array.isArray(d)) && window.got.some(d => d[0] === 3 && d.length === 35)),
    'the app receives Uint8Arrays with the bytes sent'
  )
  await bobFrame.evaluate(() => window.rt.leave())
  check(await bobFrame.evaluate(() => { try { window.rt.send(new Uint8Array([1])); return false } catch { return true } }), 'a left channel refuses to send')
} catch (err) {
  console.error('FAIL:', err)
  failed++
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nPASS: webxdc realtime end to end')
