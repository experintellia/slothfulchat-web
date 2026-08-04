/**
 * Which memfs path, if any, a same-origin request under the blobs service
 * worker is allowed to read. Plain .mjs beside the TS so it can be unit-tested
 * without a build, same as blob-response.mjs.
 *
 * This is the trust boundary for the whole /blobs/ family: anything that can
 * make a same-origin GET (a message-supplied <img src>, an iframe, a link)
 * chooses this path, and the page hands whatever comes back to the core's
 * memfs — whose `normalize()` resolves `..` by popping a component
 * (crates/tokio-wasm-shim/src/fs.rs). So a decoded dot-segment that reaches it
 * escapes the blobdir into the account's SQLite database and its siblings.
 *
 * Browsers strip literal `../` from a URL path before the SW ever sees it, but
 * NOT percent-encoded ones — `%2e%2e%2f` arrives intact and only becomes `../`
 * when we decode it. Everything that gets decoded therefore has to be checked
 * after decoding, which is what `traversal()` below is for.
 */

/** Decode one path segment and reject anything that could climb out of the
 * directory we are about to join it onto. Returns null when unsafe. */
function safeSegment(raw, { allowSlashes = false } = {}) {
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null // malformed %-escape: not a path we can reason about
  }
  if (decoded.includes('\0')) return null
  if (traversal(decoded)) return null
  if (!allowSlashes && decoded.includes('/')) return null
  return decoded
}

/** A `..` component, however the separators are spelled. Substring-matching
 * '..' alone would reject the legitimate filename 'holiday..jpg'. */
const traversal = value => value.split(/[/\\]/).some(part => part === '..')

/** Does this pathname address the blob family at all? Lets the caller tell
 * "not ours, serve the app shell" apart from "ours, but refused" — answering a
 * probe for a forbidden path with the shell would be a confusing 200. */
export function isBlobRoute(pathname) {
  return /\/(blobs|download-backup|blob-path|webxdc-icon)\//.test(pathname)
}

/**
 * Resolve a request pathname to a read.
 *
 * Returns one of:
 *   { kind: 'blob',     accountId, filename }  — blobdir file, path built by the page
 *   { kind: 'backup',   filename, path }       — an export, always a download
 *   { kind: 'bypath',   filename, path }       — absolute memfs path (temp files)
 *   { kind: 'xdc-icon', accountId, msgId }     — icon from inside a .xdc
 *   null                                        — not ours, or refused
 */
export function resolveBlobRoute(pathname) {
  // match the tail so the app works under any base path (e.g. /repo/ on Pages)
  const blob = pathname.match(/\/blobs\/([^/]+)\/(.+)$/)
  if (blob) {
    // NB: not a number. This is the account *directory* name, which
    // transformBlobURL lifts out of the core's blob path — a UUID like
    // 11900ee1-f762-43e5-8283-eedbabb791e8. (The numeric account id that RPC
    // uses appears in /webxdc-icon/ below; same word, different value.) So
    // constrain it to a safe single path component rather than to a format.
    const accountId = safeSegment(blob[1])
    const filename = safeSegment(blob[2], { allowSlashes: true })
    // blobdir files are flat, but historical paths may carry a subdirectory;
    // allow the separator and rely on the dot-segment check above
    return accountId && filename ? { kind: 'blob', accountId, filename } : null
  }

  const backup = pathname.match(/\/download-backup\/([^/]+)$/)
  if (backup) {
    const filename = safeSegment(backup[1])
    // exports live in the memfs /exports dir (runtime.ts EXPORTS_DIR)
    return filename ? { kind: 'backup', filename, path: `/exports/${filename}` } : null
  }

  // /blob-path/<uri-encoded absolute memfs path>: temp files outside the
  // blobdir, e.g. /tmp/<uuid>/<file> (see runtime.ts transformBlobURL)
  const bypath = pathname.match(/\/blob-path\/([^/]+)$/)
  if (bypath) {
    const decoded = safeSegment(bypath[1], { allowSlashes: true })
    if (!decoded || !decoded.startsWith('/')) return null
    // the page derives the MIME from this
    return { kind: 'bypath', filename: decoded.split('/').pop(), path: decoded }
  }

  // /webxdc-icon/:accountId/:msgId — icon from inside a .xdc archive; the
  // page resolves it via get_webxdc_info + get_webxdc_blob
  const xdcIcon = pathname.match(/\/webxdc-icon\/(\d+)\/(\d+)$/)
  if (xdcIcon) {
    return { kind: 'xdc-icon', accountId: Number(xdcIcon[1]), msgId: Number(xdcIcon[2]) }
  }

  return null
}
