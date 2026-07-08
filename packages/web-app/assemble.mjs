// Assembles dist/: upstream's prebuilt frontend bundle + locales + themes.json
// + our static overlays (main.html, manifest) + the wasm core worker.
// Our runtime.js/blobs-sw.js are added by `pnpm build` afterwards.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

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

// Per-instance config from env vars (set in CI, never committed to source):
//   SLOTHFUL_INSTANCE_NAME   human name, e.g. "SlothfulChat"
//   SLOTHFUL_INSTANCE_URL    canonical origin, e.g. "https://web.slothful.chat"
//   SLOTHFUL_DEFAULT_PROXY   wss:// WS-TCP bridge the app uses by default
//   SLOTHFUL_IMPRINT_NAME    responsible person/entity (legal imprint)
//   SLOTHFUL_IMPRINT_ADDRESS postal address (newlines allowed)
//   SLOTHFUL_IMPRINT_EMAIL   contact email
const env = process.env
const config = {
  instanceName: env.SLOTHFUL_INSTANCE_NAME || '',
  instanceUrl: env.SLOTHFUL_INSTANCE_URL || '',
  defaultProxyUrl: env.SLOTHFUL_DEFAULT_PROXY || '',
  // imprint.html is always emitted (placeholder when unconfigured), so the
  // About link can point at it unconditionally
  imprintUrl: 'imprint.html',
  // release builds (CI sets NODE_ENV=production) hide devmode features:
  // window.exp access, debug log level, dev_ prototype themes
  devmode: env.NODE_ENV !== 'production',
}

// `window.__slothfulConfig` must load before runtime.js (main + index). A
// separate file, not an inline script: the CSP is script-src 'self' and an
// inline script would be silently blocked.
await writeFile(
  join(dist, 'config.js'),
  `window.__slothfulConfig=${JSON.stringify(config)}\n`
)
const mainHtml = (await readFile(join(here, 'static/main.html'), 'utf-8')).replace(
  '<!--slothful-config-->',
  '<script src="./config.js"></script>'
)

// our overlays. index.html is a copy of main.html so the bare site root
// (e.g. https://user.github.io/repo/) loads without a redirect. .nojekyll
// stops GitHub Pages' Jekyll from dropping _-prefixed files (locales).
await writeFile(join(dist, 'main.html'), mainHtml)
await writeFile(join(dist, 'index.html'), mainHtml)
await cp(join(here, 'static/manifest.webmanifest'), join(dist, 'manifest.webmanifest'))
await cp(join(here, 'static/boot-error.js'), join(dist, 'boot-error.js'))
await writeFile(join(dist, '.nojekyll'), '')

// imprint.html — standalone legal notice. The operator's name/address/email
// come from env at build time (so they live in CI config, not the source
// tree); the scope + privacy + reporting text is the same for every instance
// and is baked into the template below.
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const nl2br = s => esc(s).replace(/\r?\n/g, '<br />')
const name = env.SLOTHFUL_IMPRINT_NAME || ''
const address = env.SLOTHFUL_IMPRINT_ADDRESS || ''
const email = env.SLOTHFUL_IMPRINT_EMAIL || ''
const instanceLabel = config.instanceName || config.instanceUrl || 'this site'

const operatorBlock =
  name || address || email
    ? `<h2>Operator of this site</h2>
<p>
${name ? `${nl2br(name)}<br />` : ''}${address ? `${nl2br(address)}<br />` : ''}${
        email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ''
      }
</p>`
    : `<p><em>No operator details have been configured for ${esc(instanceLabel)}.</em>
Operators: set <code>SLOTHFUL_IMPRINT_NAME</code>, <code>SLOTHFUL_IMPRINT_ADDRESS</code>
and <code>SLOTHFUL_IMPRINT_EMAIL</code> at build time.</p>`

const imprintHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Imprint — ${esc(config.instanceName || 'SlothfulChat')}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
  a { color: #2c8a68; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  .meta { color: #666; font-size: 0.9rem; margin-top: 2.5rem; }
</style>
</head>
<body>
<h1>Imprint</h1>
${operatorBlock}

<h2>What this imprint covers</h2>
<p>This imprint concerns ${esc(instanceLabel)} — the website and web app — only.
It does not concern the content of any messages or accounts.</p>

<h2>Your data stays on your device</h2>
<p>${esc(config.instanceName || 'This app')} runs entirely in your browser. Your accounts,
messages, encryption keys and files are stored only on your device (in your
browser's storage) and are exchanged end-to-end encrypted, directly with the
mail servers, through a relay that only sees encrypted traffic.
${
  config.defaultProxyUrl
    ? `By default this instance uses the relay at <code>${esc(config.defaultProxyUrl)}</code>.`
    : `This instance has no default relay configured — you provide the address of your own relay.`
}
The operator of
this site never receives, stores, sees or processes your messages or account
data, and has no way to know what you do in the app.</p>

<h2>Problems with other users</h2>
<p>Because the operator has no access to your conversations, they cannot moderate
them and cannot act on reports about other users. If someone harasses you or
breaks the law: block them in the app, and report them directly to the relevant
authorities if a law was broken. You can also report them to their email /
chatmail provider — the operator of the relay behind their address. You can see
which relays a contact uses by opening the contact, then the three-dot menu,
then &ldquo;Encryption Info&rdquo;.</p>

<h2>Links</h2>
<p>This site and app contain links to external websites. The operator has no
influence over their content and accepts no responsibility for it; at the time
of linking, no malicious or illegal content was apparent. If a linked site no
longer complies, please report it to the email address above.</p>

<p class="meta">${esc(instanceLabel)}${
  config.instanceUrl
    ? ` — <a href="${esc(config.instanceUrl)}">${esc(config.instanceUrl)}</a>`
    : ''
}<br />An unofficial experiment running Delta Chat's chatmail core in the browser. Not affiliated with Delta Chat.</p>
<p><a href="./">← Back to the app</a></p>
</body>
</html>
`
await writeFile(join(dist, 'imprint.html'), imprintHtml)

// PWA install icons (Chrome wants >=192 + 512): reuse upstream's tauri icons
const tauriIcons = join(repo, 'build/desktop/packages/target-tauri/src-tauri/icons')
await cp(join(tauriIcons, 'icon.png'), join(dist, 'images/icon-512.png'))
await cp(join(tauriIcons, '128x128@2x.png'), join(dist, 'images/icon-256.png'))
// maskable variant: upstream icon at 66% on theme color, pre-generated by
// scripts/make-maskable-icon.mjs — rerun it when we get our own icon
await cp(join(here, 'static/images/icon-maskable-512.png'), join(dist, 'images/icon-maskable-512.png'))

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

// The offline app-shell precache manifest (dist/sw-precache.js) is emitted by
// sw-manifest.mjs at the END of `pnpm build`: it content-hashes every file,
// so it must run after esbuild adds runtime.js/blobs-sw.js to dist/.

console.log(`assembled ${dist} (${themes.length} themes)`)
