// Clickjacking guard check (packages/web-app/static/frame-guard.js): the page-
// level backstop for hosts that cannot send `frame-ancestors` / `X-Frame-Options`
// (GitHub Pages serves the flagship — see SELFHOSTING.md). It is a branch, so it
// needs a check in BOTH directions:
//   - a foreign origin framing main.html / html-email.html / call-popup.html is
//     refused: the document is emptied and the app never loads, so there is
//     nothing left to trick a click onto,
//   - the app framing its OWN html-email.html (same origin, what
//     ensureHtmlEmailDialog does on phones/PWAs) still renders and still boots
//     its module — the guard must not break the one legitimate frame we have,
//   - but a SAME-origin frame of main.html / call-popup.html is refused too:
//     that is a webxdc app navigating its window onto the app origin
//     (WEBXDC.md, "Security model").
// Self-sufficient like scripts/test-html-email.mjs: esbuilds html-email.ts,
// copies the three static documents into a temp dir and serves only those. Two
// origins come from two hostnames on one server (app./evil.localhost, both
// resolved to loopback by Chromium), so no second port is needed.
// Run:  node scripts/test-frame-guard.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const webApp = fileURLToPath(new URL('../packages/web-app', import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8668)
const APP = `http://app.localhost:${APP_PORT}`

const dir = mkdtempSync(join(tmpdir(), 'frame-guard-test-'))
// the viewer's real bundle, so "still works" means its module actually ran
execFileSync(
  join(webApp, 'node_modules/.bin/esbuild'),
  ['--format=esm', '--bundle', join(webApp, 'src/html-email.ts'), `--outfile=${join(dir, 'html-email.js')}`],
  { stdio: 'inherit' }
)
for (const f of ['frame-guard.js', 'main.html', 'html-email.html', 'call-popup.html'])
  copyFileSync(join(webApp, 'static', f), join(dir, f))
// The framing page. Absolute src, so it frames app.localhost whichever host
// serves the framer — that difference is the whole experiment.
// what a webxdc app's frame looks like after it navigated onto the app origin
writeFileSync(
  join(dir, 'frame-sandboxed-html-email.html'),
  `<!doctype html><meta charset="utf-8"><title>framer</title>` +
    `<iframe sandbox="allow-scripts allow-same-origin" src="${APP}/html-email.html"></iframe>`
)
for (const doc of ['main', 'html-email', 'call-popup'])
  writeFileSync(
    join(dir, `frame-${doc}.html`),
    `<!doctype html><meta charset="utf-8"><title>framer</title>` +
      `<iframe id="f" width="600" height="400" src="${APP}/${doc}.html"></iframe>`
  )

const { cleanup } = await startServers({ app: APP_PORT, appRoot: dir })

let failures = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failures++
}

// CHROMIUM_PATH: run against a system chromium when the playwright-pinned
// browser build isn't downloaded (unset in CI, which installs the pinned one)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Chromium resolves *.localhost to loopback; the rule pins it (same as
  // scripts/test-webxdc-host.mjs).
  args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'],
})
const page = await browser.newPage()

/** Load `framer` and report what survived inside its iframe. */
const framed = async (framerOrigin, doc, framer = `frame-${doc}`) => {
  await page.goto(`${framerOrigin}/${framer}.html`)
  const frame = page.frame({ url: u => u.pathname.endsWith(`/${doc}.html`) })
  if (!frame) return { missing: true }
  await page.waitForTimeout(300) // let the framed document settle
  return frame.evaluate(() => ({
    // the guard replaces <html>'s children with one text node, so both of
    // these go away — nothing renders, nothing is clickable
    hasBody: !!document.body,
    text: document.documentElement.textContent.slice(0, 60),
    ids: [...document.querySelectorAll('[id]')].map(e => e.id),
    mailBooted: typeof window.__initHtmlEmail === 'function',
  }))
}

const refused = r =>
  !r.missing && !r.hasBody && !r.ids.length && r.text.startsWith('Refused to load')

for (const doc of ['main', 'html-email', 'call-popup'])
  check(
    refused(await framed('http://evil.localhost:' + APP_PORT, doc)),
    `foreign origin framing ${doc}.html is refused, nothing clickable left`
  )

// The one frame the app legitimately creates (runtime.ts ensureHtmlEmailDialog).
const legit = await framed(APP, 'html-email')
check(legit.hasBody && !refused(legit), 'same-origin html-email.html frame still renders')
check(legit.ids?.includes('subject'), 'same-origin html-email.html keeps its UI')
check(legit.mailBooted, 'same-origin html-email.html still boots html-email.js')

// A webxdc app's frame can be navigated onto the app origin (frame-src must
// admit 'self' for the viewer above). Same origin, but not the viewer: refused.
check(refused(await framed(APP, 'main')), 'same-origin frame of main.html is refused (webxdc frame navigating home)')
check(refused(await framed(APP, 'call-popup')), 'same-origin frame of call-popup.html is refused')
check(
  refused(await framed(APP, 'html-email', 'frame-sandboxed-html-email')),
  'a sandboxed same-origin frame of html-email.html (a webxdc frame gone home) is refused'
)

// Unframed is the normal case and must be untouched.
await page.goto(`${APP}/main.html`)
check(
  await page.evaluate(() => !!document.getElementById('root')),
  'unframed main.html renders normally'
)

await browser.close()
cleanup()
if (failures) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('frame guard checks passed')
process.exit(0) // the spawned server would keep the event loop alive
