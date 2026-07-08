// Emits dist/sw-precache.js: the content-hashed precache manifest for
// blobs-sw.ts (home-rolled Workbox pattern). Per-file hashes let the SW
// re-download only files whose content actually changed on a deploy —
// GitHub Pages regenerates every ETag per deploy, so HTTP caching alone
// re-downloads the world (including the 10MB emoji font).
// Runs at the END of `pnpm build`: runtime.js/blobs-sw.js must be in dist/.
// Optional argv[2]: alternate dist dir (used by scripts/test-pwa-update.mjs
// to fake deploys onto a copy).
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(process.argv[2] ?? fileURLToPath(new URL('./dist', import.meta.url)))

// the SW machinery itself is never precached: the browser manages blobs-sw.js
// updates, and sw-precache.js describes the cache rather than living in it
const skip = f =>
  f.endsWith('.map') ||
  f.startsWith('demo/') ||
  ['.nojekyll', 'sw-precache.js', 'blobs-sw.js'].includes(f)

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter(e => e.isFile())
  .map(e => join(e.parentPath, e.name).slice(dist.length + 1))
  .filter(f => !skip(f))
  .sort()

const manifest = {}
for (const file of files) {
  const hash = createHash('sha1').update(await readFile(join(dist, file)))
  manifest[file] = hash.digest('hex').slice(0, 16)
}
const version = createHash('sha1').update(JSON.stringify(manifest)).digest('hex').slice(0, 12)

await writeFile(
  join(dist, 'sw-precache.js'),
  `self.__PRECACHE_VERSION=${JSON.stringify(version)}\nself.__PRECACHE=${JSON.stringify(manifest)}\n`
)
console.log(`sw-precache.js: ${files.length} files, version ${version}`)
