// Voice-message waveform bucketing, off the main thread.
//
// Plain ESM, no build step (served as-is by the web-app shell next to the app,
// e.g. <base>/waveform-worker.js; the frontend creates it with
// `new Worker(new URL('waveform-worker.js', location.href), { type: 'module' })`
// so it resolves under any deploy base). Decoding stays on the main thread — a
// plain Worker can't construct an AudioContext, so it can't call
// decodeAudioData; only the cheap max-abs bucketing loop is offloaded here.

/**
 * Reduce a mono PCM channel to `n` peaks (max absolute sample per bucket).
 * @param {Float32Array} data channel-0 samples
 * @param {number} n number of output buckets
 * @returns {Float32Array} length `n`, values in [0, 1]-ish
 */
export function computePeaks(data, n) {
  const peaks = new Float32Array(n > 0 ? n : 0)
  if (!data || data.length === 0 || n <= 0) {
    return peaks
  }
  const bucketSize = data.length / n
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * bucketSize)
    const end = Math.min(data.length, Math.floor((i + 1) * bucketSize))
    let max = 0
    for (let j = start; j < end; j++) {
      const v = data[j] < 0 ? -data[j] : data[j]
      if (v > max) {
        max = v
      }
    }
    peaks[i] = max
  }
  return peaks
}

// Guarded so node:test can import computePeaks without a worker `self`.
if (typeof self !== 'undefined') {
  self.onmessage = e => {
    const { id, data, n } = e.data
    const peaks = computePeaks(data, n)
    self.postMessage({ id, peaks }, [peaks.buffer])
  }
}
