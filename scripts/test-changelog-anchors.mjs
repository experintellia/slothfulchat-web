// Self-check for the changelog viewer's version anchors (issue #180): a link to
// a version has to keep pointing at that version after the next release. The
// viewer used to id its headings by position (`v-0` = newest), so every shared
// link drifted down one version per release.
//
// Fully offline and no wasm needed: serves packages/web-app/changelog with a
// synthetic changelog, then re-serves it with a newer release prepended — the
// same shape a release commit has — and checks the old link still lands.
//
// Run:  node scripts/test-changelog-anchors.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const PORT = Number(process.env.PORT ?? 8681)

// long enough that the content actually scrolls — scrollIntoView() is a no-op
// on a changelog that fits the viewport, and then the test proves nothing
const filler = (what) =>
  Array.from({ length: 40 }, (_, i) => `- ${what} entry ${i}`).join('\n')

const before = `# Changelog

## 0.8.0 — 2026-07-24

${filler('0.8.0')}

## 0.7.0 — 2026-06-01

${filler('0.7.0')}
`
// what a release commit does: a new section goes in at the top
const after = `# Changelog

## 0.9.0 — 2026-08-04

${filler('0.9.0')}

${before.slice('# Changelog\n\n'.length)}`

let changelog = before
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    if (path === '/web-app.md') {
      res.setHeader('content-type', 'text/markdown')
      return res.end(changelog)
    }
    const file = path === '/' ? '/index.html' : path
    res.setHeader(
      'content-type',
      file.endsWith('.js') ? 'text/javascript' : 'text/html'
    )
    res.end(await readFile(here('../packages/web-app/changelog' + file)))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

const headingIds = () =>
  page.$$eval('#content h2', (hs) => hs.map((h) => h.id))
// the heading the viewer actually scrolled to, i.e. what a shared link opens:
// the one nearest the top of the scroll container
const headingAtTop = () =>
  page.$$eval('#content h2', (hs) => {
    const top = document.querySelector('main').getBoundingClientRect().top
    let best = null
    for (const h of hs) {
      const d = Math.abs(h.getBoundingClientRect().top - top)
      if (!best || d < best.d) best = { d, text: h.textContent.trim() }
    }
    return best?.text ?? null
  })

let failed = false
try {
  await page.goto(`http://127.0.0.1:${PORT}/?p=web-app`)
  await page.locator('#content h2').first().waitFor({ timeout: 30_000 })

  const ids = await headingIds()
  if (ids.join(',') !== 'v-0.8.0,v-0.7.0') {
    throw new Error(`FAIL: headings are not anchored by version: ${ids}`)
  }
  console.log(`OK: anchors carry the version (${ids.join(', ')})`)

  const href = await page.locator('#toc a').first().getAttribute('href')
  if (href !== '?p=web-app#v-0.8.0') {
    throw new Error(`FAIL: sidebar link is ${href}`)
  }
  console.log('OK: sidebar links use it too')

  // a link shared today
  await page.goto(`http://127.0.0.1:${PORT}/?p=web-app#v-0.7.0`)
  await page.locator('#content h2').first().waitFor({ timeout: 30_000 })
  if (!(await headingAtTop())?.startsWith('0.7.0')) {
    throw new Error(`FAIL: deep link opened at ${await headingAtTop()}`)
  }
  console.log('OK: deep link scrolls to its version')

  // ...opened again after the next release went out
  changelog = after
  await page.goto(`http://127.0.0.1:${PORT}/?p=web-app#v-0.7.0`)
  await page.locator('#content h2').first().waitFor({ timeout: 30_000 })
  const landed = await headingAtTop()
  if (!landed?.startsWith('0.7.0')) {
    throw new Error(
      `FAIL: after a release the same link opens ${landed} instead of 0.7.0`
    )
  }
  console.log('OK: the link survives a release (this is issue #180)')

  console.log('OK: changelog anchors verified')
} catch (err) {
  console.error(err.message)
  failed = true
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
