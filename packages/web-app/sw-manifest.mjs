// Emits dist/sw-precache.js: the content-hashed precache manifest for
// blobs-sw.ts (home-rolled Workbox pattern). Per-file hashes let the SW
// re-download only files whose content actually changed on a deploy —
// GitHub Pages regenerates every ETag per deploy, so HTTP caching alone
// re-downloads the world (including the 10MB emoji font).
// Runs at the END of `pnpm build`: runtime.js/blobs-sw.js must be in dist/.
// Optional argv[2]: alternate dist dir (used by scripts/test-pwa-update.mjs
// to fake deploys onto a copy).
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrecache, precacheSkip } from './instance-config.mjs'

const dist = resolve(process.argv[2] ?? fileURLToPath(new URL('./dist', import.meta.url)))

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter(e => e.isFile())
  .map(e => join(e.parentPath, e.name).slice(dist.length + 1))
  .filter(f => !precacheSkip(f))

const entries = []
for (const file of files) entries.push([file, await readFile(join(dist, file))])
const { js, version, count } = buildPrecache(entries)

await writeFile(join(dist, 'sw-precache.js'), js)
console.log(`sw-precache.js: ${count} files, version ${version}`)
