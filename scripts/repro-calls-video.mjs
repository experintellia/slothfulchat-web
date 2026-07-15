// Dev repro harness for "mid-call camera enable arrives black on the peer".
// Bundles repro-calls-video-entry.ts, runs two AudioCallEngines back-to-back
// in one Chromium page with fake devices, and asserts video RTP actually
// flows (getStats + a luminance check on the received frame).
//
//   node scripts/repro-calls-video.mjs
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox } from 'playwright'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const workDir = mkdtempSync(join(tmpdir(), 'repro-calls-'))

// 1. bundle the page entry (iife so it runs from a file:// page)
const bundlePath = join(workDir, 'entry.js')
execFileSync('pnpm', [
  'exec', 'esbuild', '--bundle', '--format=iife', here('repro-calls-video-entry.ts'),
  `--outfile=${bundlePath}`,
], { cwd: here('../packages/web-app'), stdio: 'inherit' })
const pageHtml = `<!doctype html><body><script>${readFileSync(bundlePath, 'utf8')}</script></body>`
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(pageHtml)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${server.address().port}/`

// 2. drive it
// BROWSER=firefox runs the same matrix in Firefox (fake media via prefs).
const useFirefox = process.env.BROWSER === 'firefox'
const browser = useFirefox
  ? await firefox.launch({
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
      },
    })
  : await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      // headless:false + --headless=new = the FULL chromium run headlessly; the
      // default headless shell has no media-capture support (getUserMedia ->
      // NotSupportedError even with fake-device flags).
      headless: false,
      args: [
        '--headless=new',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-permissions',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
const context = await browser.newContext()
if (!useFirefox) await context.grantPermissions(['microphone', 'camera'])
const page = await context.newPage()
page.on('console', m => console.log('[page]', m.text()))
await page.goto(pageUrl)

const ev = (fn, arg) => page.evaluate(fn, arg)
// waitForFunction never awaits async predicates — poll from Node instead.
async function until(label, fn, timeoutMs = 15000) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise(r => setTimeout(r, 250))
  }
}

let failures = 0
async function runCase(name, opts, act, sendSide, recvSide) {
  console.log(`\n=== CASE: ${name} ===`)
  await ev(o => window.repro.setupCall(o), opts)
  await until('both connected', async () => {
    const s = await ev(() => window.repro.states())
    if (s.errors.length) console.log('  errors:', s.errors)
    return s.a === 'connected' && s.b === 'connected'
  })
  await act()
  await new Promise(r => setTimeout(r, 3000))
  const out = (await ev(s => window.repro.videoStats(s), sendSide)).out
  const inn = (await ev(s => window.repro.videoStats(s), recvSide)).inn
  const frame = await ev(s => window.repro.grabRemoteFrame(s), recvSide)
  const sending = out != null && out.framesEncoded > 0 && out.bytesSent > 0
  const receiving = inn != null && inn.framesDecoded > 0
  const nonBlack = frame.maxLum != null && frame.maxLum > 30
  console.log(`  ${sendSide} outbound:`, JSON.stringify(out))
  console.log(`  ${recvSide} inbound: `, JSON.stringify(inn))
  console.log(`  ${recvSide} frame:   `, JSON.stringify(frame))
  // The calls-webapp-consumer check: the peer only renders our video if the
  // video receiver track joined the ontrack stream (a=msid association).
  const assoc = await ev(s => window.repro.streamAssociation(s), recvSide)
  console.log(`  ${recvSide} stream assoc:`, JSON.stringify(assoc))
  console.log(`  route: A=${await ev(s => window.repro.route(s), 'A')} B=${await ev(s => window.repro.route(s), 'B')}`)
  const msidLines = await ev(() => window.repro.videoSection('offer'))
  console.log('  offer m=video key lines:\n' + msidLines.split('\n').map(l => '    ' + l).join('\n'))
  const associated = assoc.videoReceiverTrackInEngineStream === true
  const ok = sending && receiving && nonBlack && associated
  console.log(`  => ${ok ? 'PASS' : 'FAIL'} (sending=${sending} receiving=${receiving} nonBlack=${nonBlack} associated=${associated})`)
  if (!ok) {
    failures++
    console.log('  --- diagnostics ---')
    for (const side of ['A', 'B']) {
      console.log(`  diag ${side}:`, JSON.stringify(await ev(s => window.repro.diag(s), side), null, 1))
    }
    console.log('  offer m=video:\n' + (await ev(() => window.repro.videoSection('offer'))))
    console.log('  answer m=video:\n' + (await ev(() => window.repro.videoSection('answer'))))
  }
  await ev(() => window.repro.end())
}

// the user-reported scenario: audio-start call, OFFERER enables camera mid-call
await runCase('offerer camera mid-call', {},
  () => ev(() => window.repro.setCameraEnabled('A', true)), 'A', 'B')
// answerer enables camera mid-call
await runCase('answerer camera mid-call', {},
  () => ev(() => window.repro.setCameraEnabled('B', true)), 'B', 'A')
// video-start call, offerer->answerer direction
await runCase('video-start call', { aHasVideo: true, bHasVideo: true },
  () => Promise.resolve(), 'A', 'B')
// camera off then on again
await runCase('camera off/on again', {}, async () => {
  await ev(() => window.repro.setCameraEnabled('A', true))
  await new Promise(r => setTimeout(r, 1000))
  await ev(() => window.repro.setCameraEnabled('A', false))
  await new Promise(r => setTimeout(r, 1000))
  await ev(() => window.repro.setCameraEnabled('A', true))
}, 'A', 'B')

await browser.close()
server.close()
console.log(failures ? `\n${failures} case(s) FAILED` : '\nall cases passed')
process.exit(failures ? 1 : 0)
