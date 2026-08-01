// Status + headers for one blob served by the blobs service worker. Every
// response the SW's fetch handler builds for /blobs/, /blob-path/,
// /download-backup/ and /webxdc-icon/ goes through here — which is why the
// security headers live in this function and not at the call sites: a
// per-route guard is a guard the next route forgets.
//
// Plain .mjs with no DOM/SW globals (same idiom as translation-editor.mjs) so
// `node --test src/blob-response.test.mjs` can check it without a browser.

/**
 * @param {number} total byte length of the whole blob
 * @param {string | undefined} mime MIME the page derived from the filename
 * @param {string | null} downloadName if set, serve as a download under this name
 * @param {string | null} range the request's `Range` header, if any
 * @returns {{ status: number, headers: Record<string, string>, start: number, end: number }}
 *   `start`/`end` are an exclusive-end slice of the blob to send as the body
 *   (empty on 416).
 */
export function blobResponseInit(total, mime, downloadName, range) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': mime ?? 'application/octet-stream',
    // advertise range support so <video>/<audio> expose a working seek bar;
    // without this browsers treat the media as non-seekable
    'accept-ranges': 'bytes',
    // Attachment bytes are sender-controlled but served from the app's *own*
    // origin, and opening an attachment (runtime.ts openPath -> window.open)
    // navigates to one as a top-level document. image/svg+xml is a scripted
    // document type, so without this header a sent .svg executes script with
    // our localStorage, service worker and OPFS. `sandbox` with neither
    // allow-scripts nor allow-same-origin gives a navigated blob an opaque
    // origin and no scripting; `default-src 'none'` also keeps it off the
    // network (no beacons out of an opened attachment).
    // A response's CSP is only enforced when the response *becomes a document
    // or worker* — subresource loads ignore it, so the <img>/<video>/<audio>
    // tags that render these very same URLs inline are unaffected.
    // `allow-downloads` grants neither script nor origin and keeps a
    // `?download_with_filename=` navigation able to land as a save.
    'content-security-policy': "sandbox allow-downloads; default-src 'none'",
    // the type comes from the sender's file extension (MIME_BY_EXT, else
    // application/octet-stream) — never let a browser sniff a more dangerous,
    // scriptable type out of the bytes than the one we declared
    'x-content-type-options': 'nosniff',
  }
  if (downloadName) {
    headers['content-disposition'] =
      `attachment; filename="${downloadName.replace(/["\\]/g, '')}"`
  }
  // media seeking: honor Range with 206 Partial Content. The whole blob is
  // already in memory, so the caller just slices it — no streaming needed.
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (m && (m[1] || m[2])) {
    // "bytes=-N" is a suffix range: the last N bytes
    const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1])
    const end =
      m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
    if (start > end || start >= total) {
      headers['content-range'] = `bytes */${total}`
      return { status: 416, headers, start: 0, end: 0 }
    }
    headers['content-range'] = `bytes ${start}-${end}/${total}`
    headers['content-length'] = String(end - start + 1)
    return { status: 206, headers, start, end: end + 1 }
  }
  headers['content-length'] = String(total)
  return { status: 200, headers, start: 0, end: total }
}
