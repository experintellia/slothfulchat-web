// Synthetic voice-note mp3, shared by the browser-driven shot scripts.
//
// Encoded with the same lamejs the app's recorder uses, so no fixture file has
// to live in the repo. `seed` varies the melody: core dedupes blobs by content,
// so two messages that must stay distinct need different seeds.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = p => fileURLToPath(new URL(p, import.meta.url))

/** ~`secs` seconds of "spoken-word-ish" tone bursts, base64 mp3 (mono, 64 kbps). */
export async function voiceMp3Base64(seed = 0, secs = 7) {
  // require.resolve lands on the iife build (empty exports under node); the
  // ESM build sits next to it
  const lame = await import(
    createRequire(script('../build/desktop/packages/frontend/package.json'))
      .resolve('@breezystack/lamejs')
      .replace(/lamejs\.iife\.js$/, 'lamejs.js')
  )
  const Mp3Encoder = lame.Mp3Encoder ?? lame.default?.Mp3Encoder
  const sr = 44100
  const n = sr * secs
  const samples = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env =
      Math.max(0, Math.sin(2 * Math.PI * (2.3 + seed) * t)) *
      (t % 1.7 < 1.2 ? 1 : 0)
    const f = 180 + 40 * seed + 60 * Math.sin(2 * Math.PI * 0.9 * t)
    samples[i] = 12000 * env * Math.sin(2 * Math.PI * f * t)
  }
  const enc = new Mp3Encoder(1, sr, 64)
  const chunks = []
  for (let i = 0; i < n; i += 1152) {
    const b = enc.encodeBuffer(samples.subarray(i, i + 1152))
    if (b.length) chunks.push(Buffer.from(b))
  }
  const fin = enc.flush()
  if (fin.length) chunks.push(Buffer.from(fin))
  return Buffer.concat(chunks).toString('base64')
}
