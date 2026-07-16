// Assembles dist/: upstream's prebuilt frontend bundle + locales + themes.json
// + our static overlays (main.html, manifest) + the wasm core worker.
// Our runtime.js/blobs-sw.js are added by `pnpm build` afterwards.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as sass from 'sass'
import { analyticsOrigin, buildConfig, configJs, imprintHtml, patchBootError, patchCsp, patchManifest, patchTitle, privacyHtml } from './instance-config.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')

// Version + source commit shown in the About dialog/log. Best-effort:
// shallow clones/CI checkouts without .git history just leave the commit
// line blank instead of failing the build.
async function gitBuildMeta() {
  const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf-8'))
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim()
    // A build from a dirty tree gets attributed to the clean HEAD commit
    // otherwise — exactly the case where "which commit is this" misleads.
    const dirty = git('status', '--porcelain') !== ''
    return {
      version,
      commitHash: git('rev-parse', '--short', 'HEAD') + (dirty ? '-dirty' : ''),
      commitMessage: git('log', '-1', '--pretty=%s'),
    }
  } catch {
    return { version, commitHash: '', commitMessage: '' }
  }
}
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

// fonts.css declares the same 10MB NotoColorEmoji.ttf under two families
// ("NotoEmoji" + "EmojiMart"), which the browser downloads twice; drop the
// redundant one — the app stack and the picker both resolve via "EmojiMart".
// Exact-match replace: a no-op if upstream ever changes the block.
const fontsCssPath = join(dist, 'fonts/fonts.css')
const fontsCss = await readFile(fontsCssPath, 'utf-8')
await writeFile(fontsCssPath, fontsCss.replace(
  `@font-face {\n  font-family: "NotoEmoji";\n  src: url("noto/emoji/NotoColorEmoji.ttf") format("truetype");\n}\n`,
  ''
))

await mkdir(join(dist, 'locales'))
for (const file of await readdir(locales)) {
  if (file.endsWith('.json')) {
    await cp(join(locales, file), join(dist, 'locales', file))
  }
}

// Manifests for the in-app translation editor: _catalogue.json maps each
// translatable locale (<code>.json, skipping the _-prefixed meta files like
// _languages.json) to its key count, and _stockstrings.json lists the keys
// core's stockStrings.ts hardcodes — the editor uses both to show progress
// and flag which strings ship from core rather than the locale files.
const catalogue = {}
for (const file of await readdir(locales)) {
  if (!file.endsWith('.json') || file.startsWith('_')) continue
  const code = basename(file, '.json')
  catalogue[code] = Object.keys(JSON.parse(await readFile(join(locales, file), 'utf-8'))).length
}
await writeFile(join(dist, 'locales/_catalogue.json'), JSON.stringify(catalogue))

let stockStrings = []
try {
  const src = await readFile(join(repo, 'build/desktop/packages/frontend/src/stockStrings.ts'), 'utf-8')
  stockStrings = [...new Set([...src.matchAll(/tx\(\s*'([^']+)'/g)].map(m => m[1]))]
} catch {}
await writeFile(join(dist, 'locales/_stockstrings.json'), JSON.stringify(stockStrings))

// our themes: compile themes/*.scss against upstream's _themebase and drop
// them into dist/themes/ — the themes.json scan below picks them up, so
// adding/changing a theme never touches patches/.
for (const file of await readdir(join(here, 'themes'))) {
  if (!file.endsWith('.scss') || file.startsWith('_')) continue
  const { css } = sass.compile(join(here, 'themes', file), {
    loadPaths: [join(repo, 'build/desktop/packages/frontend/themes')],
    style: 'compressed',
  })
  await writeFile(join(dist, 'themes', basename(file, '.scss') + '.css'), css)
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

// Per-instance config from env vars (set in CI, never committed to source) —
// the vars, config.js shape and imprint template live in instance-config.mjs,
// shared with customize.mjs (which re-applies them to a prebuilt release zip).
const env = process.env
const config = buildConfig(env, await gitBuildMeta())

// `window.__slothfulConfig` must load before runtime.js (main + index). A
// separate file, not an inline script: the CSP is script-src 'self' and an
// inline script would be silently blocked.
await writeFile(join(dist, 'config.js'), configJs(config))
// instance name also becomes the tab title (runtime.ts keeps it updated)
// CSP connect-src: analytics (when configured) POSTs to Plausible from our own
// bundle (one extra origin), and the relay-directory URL is pinned so the
// onboarding picker can fetch it; script-src stays 'self'
const mainHtml = patchCsp(
  patchTitle(
    (await readFile(join(here, 'static/main.html'), 'utf-8')).replace(
      '<!--slothful-config-->',
      '<script src="./config.js"></script>'
    ),
    config.instanceName
  ),
  analyticsOrigin(config),
  config.relayDirectoryUrl
)

// our overlays. index.html is a copy of main.html so the bare site root
// (e.g. https://user.github.io/repo/) loads without a redirect. .nojekyll
// stops GitHub Pages' Jekyll from dropping _-prefixed files (locales).
await writeFile(join(dist, 'main.html'), mainHtml)
await writeFile(join(dist, 'index.html'), mainHtml)
// instance name also names the installed PWA
await writeFile(
  join(dist, 'manifest.webmanifest'),
  patchManifest(await readFile(join(here, 'static/manifest.webmanifest'), 'utf-8'), config.instanceName)
)
// boot-error screens render before config.js is guaranteed up — bake the name
await writeFile(
  join(dist, 'boot-error.js'),
  patchBootError(await readFile(join(here, 'static/boot-error.js'), 'utf-8'), config.instanceName)
)
await cp(join(here, 'static/viewport-keyboard.js'), join(dist, 'viewport-keyboard.js'))
await writeFile(join(dist, '.nojekyll'), '')

// imprint.html + privacy.html — standalone pages, templates in instance-config.mjs.
await writeFile(join(dist, 'imprint.html'), imprintHtml(config, env))
await writeFile(join(dist, 'privacy.html'), privacyHtml(config, env))

// PWA install + favicon icons (Chrome wants >=192 + 512): the fork's own sloth
// icon, pre-generated from static/images/icon-source.png by scripts/make-icons.mjs
// (rerun that when the source icon changes).
for (const f of ['icon-256.png', 'icon-512.png', 'icon-maskable-512.png']) {
  await cp(join(here, 'static/images', f), join(dist, 'images', f))
}

// wasm core: worker at /core/worker.js imports ../wasm-dist/deltachat_wasm.js
// -> /wasm-dist/ (same relative layout as in the core-wasm package)
await mkdir(join(dist, 'core'))
await cp(join(coreWasm, 'dist/worker.js'), join(dist, 'core/worker.js'))
await mkdir(join(dist, 'wasm-dist'))
for (const file of ['deltachat_wasm.js', 'deltachat_wasm_bg.wasm']) {
  await cp(join(coreWasm, 'wasm-dist', file), join(dist, 'wasm-dist', file))
}

// core-wasm demo page at /demo/, reusing /core/worker.js and /wasm-dist/
// (index.js resolves the worker as a sibling, so it lives in /core/ too)
await cp(join(coreWasm, 'dist/index.js'), join(dist, 'core/index.js'))
await mkdir(join(dist, 'demo'))
const demoHtml = await readFile(join(coreWasm, 'example/index.html'), 'utf8')
await writeFile(
  join(dist, 'demo/index.html'),
  demoHtml.replace("'../dist/index.js'", "'../core/index.js'")
)

// changelog viewer at /changelog/ (web.slothful.chat/changelog): the vendored
// single-page viewer + markdown-it, plus the web app's and each published
// package's CHANGELOG.md copied in beside it as <name>.md. The page fetches
// those with relative URLs, so it shows the versions current at build time
// (no live network, no CDN).
await mkdir(join(dist, 'changelog'))
for (const file of ['index.html', 'markdown-it.min.js']) {
  await cp(join(here, 'changelog', file), join(dist, 'changelog', file))
}
for (const pkg of ['web-app', 'core-wasm', 'ws-tcp-proxy', 'customize']) {
  await cp(join(repo, 'packages', pkg, 'CHANGELOG.md'), join(dist, 'changelog', pkg + '.md'))
}

// The offline app-shell precache manifest (dist/sw-precache.js) is emitted by
// sw-manifest.mjs at the END of `pnpm build`: it content-hashes every file,
// so it must run after esbuild adds runtime.js/blobs-sw.js to dist/.

console.log(`assembled ${dist} (${themes.length} themes)`)
