// Self-check for the media metadata reader (desktop/0071) — runs FULLY OFFLINE.
//
// This is what fills in `Chat-Duration` and a video's pixel size on send, and the part
// that can actually break is the browser side: MediaRecorder writes containers with no
// duration in the header, exactly like our own voice recorder's mp3, so `.duration` is
// `Infinity` until the seek-to-the-end trick forces a scan. That trick is what this
// records real media in a real chromium to verify.
//
// Needs only playwright + esbuild (no core-wasm, no web-app build).
// Run:  node scripts/test-media-metadata.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = new URL('..', import.meta.url)
const source = fileURLToPath(
  new URL('build/desktop/packages/frontend/src/utils/mediaMetadata.ts', repo)
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
  globalName: 'mediaMetadataModule',
  plugins: [stubLogger],
  write: false,
})
const bundle = outputFiles[0].text

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_BIN || undefined,
  // Lets getUserMedia-free oscillator recording run without a device prompt.
  args: ['--autoplay-policy=no-user-gesture-required'],
})
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><meta charset=utf-8><title>metadata</title>')
  await page.addScriptTag({ content: bundle })

  const result = await page.evaluate(async () => {
    const RECORD_MS = 1200

    /** Record `stream` for RECORD_MS and return an object URL for the result. */
    const record = async stream => {
      const chunks = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = e => chunks.push(e.data)
      const stopped = new Promise(resolve => (recorder.onstop = resolve))
      recorder.start()
      await new Promise(resolve => setTimeout(resolve, RECORD_MS))
      recorder.stop()
      await stopped
      return URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }))
    }

    // A video: a canvas repainted so the encoder emits frames.
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')
    const paint = () => {
      ctx.fillStyle = `hsl(${Date.now() % 360}, 80%, 50%)`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    paint()
    const painter = setInterval(paint, 50)
    const videoUrl = await record(canvas.captureStream(20))
    clearInterval(painter)

    // Audio only: an oscillator, no microphone and no permission prompt needed.
    const audioCtx = new AudioContext()
    const destination = audioCtx.createMediaStreamDestination()
    const oscillator = audioCtx.createOscillator()
    oscillator.connect(destination)
    oscillator.start()
    const audioUrl = await record(destination.stream)
    oscillator.stop()
    await audioCtx.close()

    return {
      video: await mediaMetadataModule.mediaMetadata(videoUrl),
      audio: await mediaMetadataModule.mediaMetadata(audioUrl),
      // Anything undecodable has to degrade to "nothing known", not throw.
      garbage: await mediaMetadataModule.mediaMetadata(
        URL.createObjectURL(new Blob(['nope'], { type: 'video/webm' }))
      ),
      missing: await mediaMetadataModule.mediaMetadata('blob:does-not-exist'),
      recordMs: RECORD_MS,
    }
  })

  const { video, audio, garbage, missing, recordMs } = result

  assert.deepEqual(
    [video.width, video.height],
    [320, 180],
    'video keeps its real pixel size'
  )
  // The recorder stops on a frame boundary, and a header-less container's duration is
  // whatever the scan finds — generous bounds, the point is that it is measured at all.
  assert.ok(
    video.duration > recordMs / 2 && video.duration < recordMs * 2,
    `video duration ${video.duration}ms is nowhere near the recorded ${recordMs}ms ` +
      `(Infinity leaking through means the end-seek stopped working)`
  )

  assert.equal(audio.width, undefined, 'audio has no pixel size')
  assert.equal(audio.height, undefined, 'audio has no pixel size')
  assert.ok(
    audio.duration > recordMs / 2 && audio.duration < recordMs * 2,
    `audio duration ${audio.duration}ms is nowhere near the recorded ${recordMs}ms`
  )

  assert.deepEqual(garbage, {}, 'an undecodable source yields no metadata')
  assert.deepEqual(missing, {}, 'a dead URL yields no metadata')

  console.log('media metadata: ok', { video, audio })
} finally {
  await browser.close()
}
