// One-off: render the maskable PWA icon (upstream tauri icon at 66% centered
// on the theme color, 512x512) and commit it to web-app/static/images/.
// Rerun when the icon changes (see "own icon" issue). Usage: node scripts/make-maskable-icon.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const p = rel => fileURLToPath(new URL(rel, import.meta.url))
const src = p('../build/desktop/packages/target-tauri/src-tauri/icons/icon.png')
const out = p('../packages/web-app/static/images/icon-maskable-512.png')
const THEME = '#2c8a68' // manifest theme_color
const SIZE = 512
const SCALE = 0.66 // keep content inside the maskable safe zone

const iconB64 = (await readFile(src)).toString('base64')
const browser = await chromium.launch()
const page = await browser.newPage()
const dataUrl = await page.evaluate(
  async ([b64, theme, size, scale]) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = theme
    ctx.fillRect(0, 0, size, size)
    const s = size * scale
    ctx.drawImage(img, (size - s) / 2, (size - s) / 2, s, s)
    return canvas.toDataURL('image/png')
  },
  [iconB64, THEME, SIZE, SCALE]
)
await browser.close()
await writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
console.log(`wrote ${out}`)
