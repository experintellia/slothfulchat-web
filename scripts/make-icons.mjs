// Render the fork's PWA/app icons from static/images/icon-source.png:
// icon-256.png, icon-512.png, and the maskable variant. Rerun when the source
// icon changes. Usage: node scripts/make-icons.mjs
// (needs playwright + a cached chromium; playwright is a root devDependency.)
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const p = rel => fileURLToPath(new URL(rel, import.meta.url))
const src = p('../packages/web-app/static/images/icon-source.png')
const out = name => p(`../packages/web-app/static/images/${name}`)

const srcB64 = (await readFile(src)).toString('base64')
const browser = await chromium.launch()
const page = await browser.newPage()
const rendered = await page.evaluate(async b64 => {
  const img = new Image()
  img.src = `data:image/png;base64,${b64}`
  await img.decode()
  const render = (size, draw) => {
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    draw(ctx, size)
    return c.toDataURL('image/png')
  }
  // plain icons: the source is already a full-bleed square icon
  const plain = size => render(size, (ctx, s) => ctx.drawImage(img, 0, 0, s, s))
  // maskable: fill with the source's corner colour (its own background) so the
  // masked corners blend in, and inset the artwork to 80% for the safe zone.
  const probe = document.createElement('canvas')
  probe.width = probe.height = img.naturalWidth
  const pctx = probe.getContext('2d')
  pctx.drawImage(img, 0, 0)
  const [r, g, b, a] = pctx.getImageData(0, 0, 1, 1).data
  // a transparent corner would silently probe as black — demand a real colour
  if (a !== 255) throw new Error('icon-source corner is not opaque; hardcode a maskable bg colour here')
  const maskable = render(512, (ctx, s) => {
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(0, 0, s, s)
    const inset = s * 0.8
    ctx.drawImage(img, (s - inset) / 2, (s - inset) / 2, inset, inset)
  })
  return { i256: plain(256), i512: plain(512), maskable }
}, srcB64)
await browser.close()

const save = (name, dataUrl) =>
  writeFile(out(name), Buffer.from(dataUrl.split(',')[1], 'base64'))
await save('icon-256.png', rendered.i256)
await save('icon-512.png', rendered.i512)
await save('icon-maskable-512.png', rendered.maskable)
console.log('wrote icon-256.png, icon-512.png, icon-maskable-512.png')
