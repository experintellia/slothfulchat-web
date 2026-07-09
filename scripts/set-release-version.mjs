#!/usr/bin/env node
// Set ONE synced version across every released package — the release train
// moves in lockstep, so a tag `vX.Y.Z` means every package is at X.Y.Z (see
// RELEASING.md). Run this before tagging; publish-npm.yml enforces the same
// invariant on the tag and refuses to publish a drifted set.
//
//   node scripts/set-release-version.mjs 0.3.0     # or v0.3.0
//   pnpm set-version 0.3.0
//
// It only rewrites the top-level "version" field (regex-targeted, so package
// formatting and dependency version ranges are untouched). It does NOT touch
// CHANGELOG.md — add entries by hand only for the packages that actually
// changed; gaps in a package's changelog are expected now that the numbers
// are synced.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Every package that carries the synced release version. web-app is private
// (shipped as the release zip, not published to npm) but still tracks the tag
// so "the version you are running" is one number across the whole project.
const PKGS = ['ws-tcp-proxy', 'core-wasm', 'customize', 'web-app']

const raw = process.argv[2]
if (!raw) {
  console.error('usage: node scripts/set-release-version.mjs <version>   (e.g. 0.3.0 or v0.3.0)')
  process.exit(1)
}
const version = raw.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: ${raw}`)
  process.exit(1)
}

for (const pkg of PKGS) {
  const file = join(repo, 'packages', pkg, 'package.json')
  const srcText = await readFile(file, 'utf8')
  const m = srcText.match(/"version":\s*"([^"]*)"/) // first match = the top-level field
  if (!m) {
    console.error(`no "version" field in ${file}`)
    process.exit(1)
  }
  const old = m[1]
  await writeFile(file, srcText.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`))
  console.log(`${pkg}: ${old} -> ${version}`)
}

console.log(
  `\nAll packages set to ${version}. Next: add CHANGELOG.md entries for whatever changed, commit, then:\n` +
  `  git tag v${version} && git push origin v${version}`
)
