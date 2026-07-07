// Assembles dist/: upstream's prebuilt frontend bundle + locales + themes.json
// + our static overlays (main.html, manifest) + the wasm core worker.
// Our runtime.js/blobs-sw.js are added by `pnpm build` afterwards.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const upstreamDist = join(repo, 'build/desktop/packages/target-browser/dist')
const locales = join(repo, 'build/desktop/_locales')
const coreWasm = join(repo, 'packages/core-wasm')
const dist = join(here, 'dist')

// upstream server/runtime and pages we replace or don't serve
const skip = new Set([
  'server.js', 'server.js.map',
  'runtime.js', 'runtime.js.map',
  'main.html', 'test.html', 'login.html', 'login.css',
])

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

await cp(upstreamDist, dist, {
  recursive: true,
  filter: src => !skip.has(basename(src)),
})

await mkdir(join(dist, 'locales'))
for (const file of await readdir(locales)) {
  if (file.endsWith('.json')) {
    await cp(join(locales, file), join(dist, 'locales', file))
  }
}

// themes.json — mirrors target-browser/src/themes.ts readThemeDir
const HIDDEN_THEME_PREFIX = 'dev_'
function parseThemeMetaData(rawTheme) {
  const block = /.theme-meta ?{([^]*)}/gm.exec(rawTheme)?.[1].trim() || ''
  const regex = /--(\w*): ?['"]([^]*?)['"];?/gi
  const meta = {}
  let m
  while ((m = regex.exec(block))) meta[m[1]] = m[2]
  if (!meta.name || !meta.description) throw new Error('missing theme meta')
  return meta
}
const themes = []
for (const file of await readdir(join(dist, 'themes'))) {
  if (!file.endsWith('.css') || file.startsWith('_')) continue
  const id = basename(file, '.css')
  const address = 'dc:' + id
  try {
    const meta = parseThemeMetaData(await readFile(join(dist, 'themes', file), 'utf-8'))
    themes.push({
      name: meta.name,
      description: meta.description,
      address,
      is_prototype: file.startsWith(HIDDEN_THEME_PREFIX),
    })
  } catch {
    themes.push({
      name: address + ' [Invalid Meta]',
      description: '[missing description]',
      address,
      is_prototype: file.startsWith(HIDDEN_THEME_PREFIX),
    })
  }
}
await writeFile(join(dist, 'themes.json'), JSON.stringify(themes, null, 2))

// our overlays. index.html is a copy of main.html so the bare site root
// (e.g. https://user.github.io/repo/) loads without a redirect. .nojekyll
// stops GitHub Pages' Jekyll from dropping _-prefixed files (locales).
await cp(join(here, 'static/main.html'), join(dist, 'main.html'))
await cp(join(here, 'static/main.html'), join(dist, 'index.html'))
await cp(join(here, 'static/manifest.webmanifest'), join(dist, 'manifest.webmanifest'))
await writeFile(join(dist, '.nojekyll'), '')

// PWA install icons (Chrome wants >=192 + 512): reuse upstream's tauri icons
const tauriIcons = join(repo, 'build/desktop/packages/target-tauri/src-tauri/icons')
await cp(join(tauriIcons, 'icon.png'), join(dist, 'images/icon-512.png'))
await cp(join(tauriIcons, '128x128@2x.png'), join(dist, 'images/icon-256.png'))

// wasm core: worker at /core/worker.js imports ../wasm-dist/deltachat_wasm.js
// -> /wasm-dist/ (same relative layout as in the core-wasm package)
await mkdir(join(dist, 'core'))
await cp(join(coreWasm, 'dist/worker.js'), join(dist, 'core/worker.js'))
await mkdir(join(dist, 'wasm-dist'))
for (const file of ['deltachat_wasm.js', 'deltachat_wasm_bg.wasm']) {
  await cp(join(coreWasm, 'wasm-dist', file), join(dist, 'wasm-dist', file))
}

console.log(`assembled ${dist} (${themes.length} themes)`)
