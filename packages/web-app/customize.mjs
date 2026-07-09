#!/usr/bin/env node
// Customize a prebuilt SlothfulChat release zip — instance name (tab title,
// PWA name, imprint), default bridge, imprint contacts — without rebuilding
// anything. Regenerates the same files assemble.mjs bakes (config.js,
// imprint.html, <title>, manifest.webmanifest) and recomputes sw-precache.js
// so installed PWAs pick the changes up. Never touches bundle.js or the wasm.
//
// Usage:
//   node slothfulchat-customize.mjs [--in release.zip] [--out custom.zip]
//   (also published as `npx @slothfulchat/customize`)
//
// Values come from the SLOTHFUL_* env vars (see SELFHOSTING.md); anything not
// set in the environment is prompted for interactively. Empty = unset (sane
// defaults + placeholder imprint).
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { unzipSync, zipSync } from 'fflate'
import {
  buildConfig,
  buildPrecache,
  configJs,
  imprintHtml,
  patchBootError,
  patchManifest,
  patchTitle,
} from './instance-config.mjs'

const REPO = 'experintellia/slothfulchat-web'

const VARS = [
  ['SLOTHFUL_INSTANCE_NAME', 'Instance name — app title, PWA name, imprint (e.g. "SlothfulChat")'],
  ['SLOTHFUL_INSTANCE_URL', 'Canonical URL of your instance (e.g. "https://web.example.chat")'],
  ['SLOTHFUL_DEFAULT_PROXY', 'Default WS-TCP bridge, wss:// (unset = ws://localhost:8641)'],
  ['SLOTHFUL_IMPRINT_NAME', 'Imprint: responsible person/entity'],
  ['SLOTHFUL_IMPRINT_ADDRESS', 'Imprint: postal address (type \\n for line breaks)'],
  ['SLOTHFUL_IMPRINT_EMAIL', 'Imprint: contact email'],
]

let opts
try {
  opts = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values
} catch (e) {
  console.error(e.message)
  console.error('run with --help for usage')
  process.exit(2)
}
if (opts.help) {
  console.log(`Usage: slothfulchat-customize [--in release.zip] [--out custom.zip]

Without --in, the latest release zip is downloaded from github.com/${REPO}.
Configuration values are taken from these env vars, or prompted for:
${VARS.map(([v, d]) => `  ${v.padEnd(26)} ${d}`).join('\n')}`)
  process.exit(0)
}

// --- collect values: env wins, prompt for the rest (TTY only) ---
const env = { NODE_ENV: 'production' }
const missing = VARS.filter(([v]) => !(v in process.env))
for (const [v] of VARS) if (v in process.env) env[v] = process.env[v]
if (missing.length && process.stdin.isTTY) {
  console.log('Configure your instance (Enter to leave a value unset):')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // with this listener registered, Ctrl+C fires it instead of rejecting the
  // pending question — an abort must not fall through and write a zip
  rl.on('SIGINT', () => {
    console.log('\naborted — nothing written')
    process.exit(130)
  })
  for (const [v, desc] of missing) {
    let answer
    try {
      answer = await rl.question(`${desc}\n${v}= `)
    } catch {
      console.log('\n(end of input — leaving the remaining values unset)')
      break // Ctrl+D rejects the pending question
    }
    // prompts are single-line; let operators type \n for the postal address
    env[v] = answer.replaceAll('\\n', '\n')
  }
  rl.close()
} else if (missing.length) {
  console.log(`not set (no TTY to prompt): ${missing.map(([v]) => v).join(', ')}`)
}

// --- get the release zip ---
let zipBytes
if (opts.in) {
  zipBytes = new Uint8Array(await readFile(opts.in))
} else {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`
  const headers = { 'user-agent': 'slothfulchat-customize' }
  const res = await fetch(api, { headers })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${api} (rate limit? no release yet?)`)
  }
  const release = await res.json()
  const asset = (release.assets ?? []).find(a => a.name.endsWith('.zip'))
  if (!asset) throw new Error(`no zip asset in the latest release (${api})`)
  console.log(`downloading ${asset.name} (${release.tag_name}, ${(asset.size / 1e6).toFixed(1)} MB)…`)
  const dl = await fetch(asset.browser_download_url, { headers })
  if (!dl.ok) throw new Error(`download failed: ${dl.status} ${dl.statusText}`)
  zipBytes = new Uint8Array(await dl.arrayBuffer())
}

const files = unzipSync(zipBytes)
for (const f of Object.keys(files)) if (f.endsWith('/')) delete files[f]
for (const f of ['config.js', 'index.html', 'main.html', 'manifest.webmanifest', 'boot-error.js']) {
  if (!files[f]) {
    throw new Error(
      `${f} not at the zip root — this must be a SlothfulChat release zip ` +
        '(or a zip of the CONTENTS of dist/, not the folder)'
    )
  }
}

// --- apply the instance config (same templates as assemble.mjs) ---
const enc = s => new TextEncoder().encode(s)
const dec = b => new TextDecoder().decode(b)

// Carry the source commit shown in the About dialog through unchanged: this
// script has no working tree to read it from, only the zip's existing bake.
// Sliced from the first '{' (rather than an exact configJs() prefix match)
// so it survives minor format drift, e.g. a trailing ';'.
let existingBuild = {}
try {
  const raw = dec(files['config.js'])
  const existingConfig = JSON.parse(raw.slice(raw.indexOf('{')).replace(/;?\s*$/, ''))
  existingBuild = { commitHash: existingConfig.commitHash, commitMessage: existingConfig.commitMessage }
} catch {
  // leave existingBuild empty — config.js was checked to exist above, but
  // tolerate an unexpected shape rather than fail the whole customize run
}

const config = buildConfig(env, existingBuild)
files['config.js'] = enc(configJs(config))
files['imprint.html'] = enc(imprintHtml(config, env))
for (const f of ['main.html', 'index.html']) {
  files[f] = enc(patchTitle(dec(files[f]), config.instanceName))
}
files['manifest.webmanifest'] = enc(patchManifest(dec(files['manifest.webmanifest']), config.instanceName))
files['boot-error.js'] = enc(patchBootError(dec(files['boot-error.js']), config.instanceName))

// recompute the offline-precache manifest — without this, already-installed
// PWAs would keep serving the old cached files forever
const { js, version, count } = buildPrecache(Object.entries(files))
files['sw-precache.js'] = enc(js)

const out = opts.out || 'slothfulchat-web-custom.zip'
await writeFile(out, zipSync(files))
console.log(`
wrote ${out} (${count} precached files, version ${version})
Next: unzip it onto any static host (nginx, S3, Netlify, GitHub Pages, …).
Unless all your accounts use webimap, you also need a WS-TCP bridge — see
https://github.com/${REPO}/blob/main/SELFHOSTING.md`)
