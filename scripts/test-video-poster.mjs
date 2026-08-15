// Self-check for the video poster grabber (desktop/0066) — runs FULLY OFFLINE.
//
// The risky part of sender-side video thumbnails is the browser-side frame grab, so this
// bundles videoPoster.ts, records a real video in a real chromium from a canvas painted a
// known colour, and asserts the returned JPEG decodes back to that colour. A blank canvas,
// a missed 'loadeddata', or a broken data-URL split all fail here.
//
// Needs only playwright + esbuild (no core-wasm, no web-app build).
// Run:  node scripts/test-video-poster.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = new URL('..', import.meta.url)
const source = fileURLToPath(
  new URL('build/desktop/packages/frontend/src/utils/videoPoster.ts', repo)
)

// esbuild lives in the web-app package, not at the workspace root.
const require = createRequire(fileURLToPath(new URL('packages/web-app/', repo)))
const esbuild = await import(require.resolve('esbuild'))

// The module's only import is the frontend logger, which drags in the whole app; stub it.
const stubLogger = {
  name: 'stub-logger',
  setup(build) {
    build.onResolve({ filter: /shared\/logger$/ }, () => ({
      path: 'logger',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const getLogger = () => console',
    }))
  },
}

const { outputFiles } = await esbuild.build({
  entryPoints: [source],
  bundle: true,
  format: 'iife',
  globalName: 'videoPosterModule',
  plugins: [stubLogger],
  write: false,
})
const bundle = outputFiles[0].text

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_BIN || undefined,
})
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><meta charset=utf-8><title>poster</title>')
  await page.addScriptTag({ content: bundle })

  const result = await page.evaluate(async () => {
    const COLOUR = [0, 128, 255]

    // Record ~1s of a canvas painted COLOUR — a real, decodable video file.
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')
    const paint = () => {
      ctx.fillStyle = `rgb(${COLOUR.join(',')})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    paint()
    const chunks = []
    const recorder = new MediaRecorder(canvas.captureStream(10))
    recorder.ondataavailable = e => chunks.push(e.data)
    const recorded = new Promise(resolve => (recorder.onstop = resolve))
    recorder.start()
    const painter = setInterval(paint, 100)
    await new Promise(resolve => setTimeout(resolve, 1000))
    clearInterval(painter)
    recorder.stop()
    await recorded
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))

    const poster = await videoPosterModule.videoPoster(url)
    if (poster == null) {
      return { poster: null }
    }

    // Decode the JPEG back and read the middle pixel.
    const img = new Image()
    img.src = `data:image/jpeg;base64,${poster}`
    await img.decode()
    const out = document.createElement('canvas')
    out.width = img.width
    out.height = img.height
    const outCtx = out.getContext('2d')
    outCtx.drawImage(img, 0, 0)
    const [r, g, b] = outCtx.getImageData(
      Math.floor(img.width / 2),
      Math.floor(img.height / 2),
      1,
      1
    ).data

    // And a source the browser cannot decode must degrade to "no poster", not throw.
    const notAVideo = await videoPosterModule.videoPoster(
      URL.createObjectURL(new Blob(['nope'], { type: 'video/webm' }))
    )

    return {
      poster,
      width: img.width,
      height: img.height,
      pixel: [r, g, b],
      expected: COLOUR,
      notAVideo,
    }
  })

  assert.notEqual(result.poster, null, 'a frame was grabbed')
  assert.ok(result.poster.length > 100, 'poster is not an empty JPEG')
  assert.deepEqual([result.width, result.height], [320, 180], 'poster keeps the video size')
  // JPEG at quality 0.7 shifts flat colours by a couple of steps.
  for (const [i, channel] of result.pixel.entries()) {
    assert.ok(
      Math.abs(channel - result.expected[i]) <= 8,
      `channel ${i}: got ${channel}, expected ~${result.expected[i]} (blank/black frame?)`
    )
  }
  assert.equal(result.notAVideo, null, 'an undecodable source yields no poster')
  console.log('video poster: ok', result.pixel, `${result.poster.length} base64 chars`)
} finally {
  await browser.close()
}
