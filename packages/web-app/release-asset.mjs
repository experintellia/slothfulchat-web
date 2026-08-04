// The checks that make "download a release zip and unpack it" safe for
// customize.mjs: pin the asset by name, verify the sha256 digest GitHub
// publishes for it, and bound every allocation so a hostile or corrupt archive
// can't exhaust memory before anything is checked. Pure helpers over
// bytes/streams — no fflate, no filesystem — so release-asset.test.mjs runs
// dependency-free.
//
// (The sha1 hashes customize.mjs computes later are service-worker cache
// versions, not verification — the digest check below is the only one.)
import { createHash } from 'node:crypto'

// --- limits: raise these if a release legitimately outgrows them ---
// v0.8.0 ships a ~27 MB zip; the caps leave room to grow while still bounding
// what an archive we did not build can make us allocate.
export const MAX_ZIP_BYTES = 128 * 1024 * 1024
export const MAX_ENTRIES = 10_000
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024

// publish-npm.yml attaches exactly one zip per release, alongside the
// standalone customize script: slothfulchat-web-<tag>.zip
const ASSET_NAME = /^slothfulchat-web-.+\.zip$/

/** The one release asset we know how to customize. Throws if the release has
 * no such asset, or more than one — better a loud stop than guessing. */
export function pickReleaseAsset(release) {
  const found = (release.assets ?? []).filter(a => ASSET_NAME.test(a.name))
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one slothfulchat-web-<tag>.zip asset in release ${release.tag_name ?? '?'}, ` +
        `found ${found.length}${found.length ? `: ${found.map(a => a.name).join(', ')}` : ''}`
    )
  }
  return found[0]
}

/** Verifies the bytes against the `sha256:<hex>` digest the release-asset JSON
 * carries. Fails closed: a missing or unparseable digest means the download
 * can't be verified at all, which is not a reason to proceed. */
export function verifyAssetDigest(asset, bytes) {
  const want = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? '').toLowerCase())
  if (!want) {
    throw new Error(
      `no sha256 digest for ${asset.name} in the GitHub API response (got ${JSON.stringify(asset.digest)}) — ` +
        'refusing to customize an unverifiable download'
    )
  }
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== want[1]) {
    throw new Error(`digest mismatch for ${asset.name}: expected sha256:${want[1]}, got sha256:${got}`)
  }
}

/** Reads an async byte stream (fetch body or fs.createReadStream) into memory,
 * throwing as soon as it goes over `max` — the point is to stop reading, not
 * to measure the damage after buffering it all. */
export async function readCapped(stream, max, what) {
  if (!stream) throw new Error(`no response body for ${what}`)
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > max) throw new Error(`${what} is larger than the ${max}-byte cap — refusing to read further`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** fflate `filter` enforcing the entry-count and expanded-size caps. fflate
 * calls it per central-directory entry *before* decompressing that entry, so
 * throwing here bounds the allocation instead of diagnosing it afterwards.
 * Stateful: one per unzipSync call. */
export function boundedUnzipFilter() {
  let entries = 0
  let unpacked = 0
  return file => {
    if (++entries > MAX_ENTRIES) {
      throw new Error(`archive declares more than ${MAX_ENTRIES} entries — refusing to unpack`)
    }
    // stored entries are copied at their compressed size, deflated ones are
    // inflated into a buffer of the declared original size — bound both
    unpacked += Math.max(file.size, file.originalSize)
    if (unpacked > MAX_UNPACKED_BYTES) {
      throw new Error(`archive expands to more than ${MAX_UNPACKED_BYTES} bytes — refusing to unpack`)
    }
    return true
  }
}
