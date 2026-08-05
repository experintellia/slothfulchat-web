#!/usr/bin/env node
// PROTOTYPE (not wired into CI, nothing publishes this): repackage the
// jsonrpc-client that CI already generates from the pinned core as
// `@slothfulchat/jsonrpc-client`, so `@slothfulchat/core-wasm` could declare a
// types dependency that actually matches the core it was built against.
//
// Today core-wasm declares `@deltachat/jsonrpc-client: 2.53.0` while
// vendor/core is 2.54.0-dev — and npm has no 2.54.0 at all (it goes
// 2.53.0 -> 2.55.0), so no published version can ever describe our runtime;
// our patch stack adds API on top of that. Local/CI builds paper over it by
// overriding the dep to the generated `file:` path (build-web-app "ORDER TRAP
// #1"); anyone installing the published package gets the 2.53.0 types.
//
//   node scripts/pack-jsonrpc-client.mjs [--out <dir>]
//
// Prerequisite: the bindings must already be generated + built, i.e. in
// build/core/deltachat-jsonrpc/typescript:
//   pnpm install && cargo test -p deltachat-jsonrpc
//   node scripts/generate-constants.js && ./node_modules/.bin/tsc
// This script refuses to pack anything if dist/ isn't there — a tarball built
// from a stale or missing dist/ is exactly the lie it exists to remove.
import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = join(repo, 'build/core')
const ts = join(core, 'deltachat-jsonrpc/typescript')
const outIdx = process.argv.indexOf('--out')
const out = resolve(outIdx > 0 ? process.argv[outIdx + 1] : join(repo, 'build'))

const die = msg => {
  console.error(msg)
  process.exit(1)
}

const exists = async p => access(p).then(() => true, () => false)

if (!(await exists(ts))) die(`no ${ts} — run: git submodule update --init vendor/core && scripts/apply-patches.sh`)
for (const f of ['dist/deltachat.js', 'dist/deltachat.d.ts', 'dist/generated/types.d.ts']) {
  if (!(await exists(join(ts, f)))) die(`missing ${f} — generate the bindings first (see the header of this file)`)
}

// Version: upstream's own number for the pinned core, marked as ours with a
// semver prerelease so it can never be mistaken for (or collide with) a real
// upstream release of that number. The core commit DATE is the prerelease
// identifier: numeric, so npm orders successive fork builds correctly, unlike
// a short sha. The exact commit goes in a package.json field instead.
const coreVersion = /^version = "(.+)"$/m.exec(await readFile(join(core, 'Cargo.toml'), 'utf8'))[1]
const git = (...args) => execFileSync('git', args, { cwd: core, encoding: 'utf8' }).trim()
let commit = ''
let date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
try {
  commit = git('rev-parse', 'HEAD')
  date = git('show', '-s', '--format=%cd', '--date=format:%Y%m%d', 'HEAD')
} catch {
  console.warn('warning: build/core has no git history — falling back to today for the version stamp')
}
const version = `${coreVersion.replace(/-dev$/, '')}-sc.${date}`

const pkg = JSON.parse(await readFile(join(ts, 'package.json'), 'utf8'))
const patched = {
  ...pkg,
  name: '@slothfulchat/jsonrpc-client',
  version,
  description:
    `@deltachat/jsonrpc-client generated from chatmail core ${coreVersion} as pinned and patched by ` +
    'slothfulchat-web. Republished because no upstream release describes this API.',
  repository: { type: 'git', url: 'git+https://github.com/experintellia/slothfulchat-web.git' },
  // provenance a version string can't carry
  slothfulchat: { coreVersion, coreCommit: commit, generatedFrom: 'deltachat-jsonrpc/typescript' },
  // publish-only: none of upstream's dev tooling (cargo, mocha, typedoc…) makes
  // sense in a republished tarball, and devDependencies would just be noise
  devDependencies: undefined,
  scripts: undefined,
}
await writeFile(join(ts, 'package.json'), JSON.stringify(patched, null, 2) + '\n')

try {
  const stdout = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: ts, encoding: 'utf8' })
  const tarball = stdout.trim().split('\n').pop()
  console.log(`\npacked ${join(out, tarball)}`)
  console.log(`\ncore-wasm would then declare (alias keeps every 'import … from "@deltachat/jsonrpc-client"' working):`)
  console.log(`  "@deltachat/jsonrpc-client": "npm:@slothfulchat/jsonrpc-client@${version}"`)
} finally {
  // build/ is throwaway, but leaving a rewritten package.json behind would make
  // a following `pnpm install` in that dir resolve the wrong package name
  await writeFile(join(ts, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}
