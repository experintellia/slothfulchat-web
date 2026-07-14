// Enforces docs/calls.md's packages/calls invariant: "engine/ (pure TS, ZERO
// React/DOM imports, unit-testable)". This is the import-level half of the
// boundary; packages/calls/engine/tsconfig.json (DOM lib present, for ambient
// WebRTC types like RTCPeerConnection, but no "jsx") is the type-level half —
// see the comment there for why DOM *types* are fine but DOM/React *imports*
// are not.
//
// Walks packages/calls/engine/**/*.{ts,tsx,mts,cts} and fails on any file
// that:
//   - has a .tsx extension (JSX has no business in the engine — it is
//     framework-agnostic and runs outside a DOM entirely, e.g. in a popup
//     that hasn't rendered anything yet)
//   - imports (static or dynamic) 'react', 'react-dom', or any subpath of
//     either — including type-only imports and side-effect-only imports
//   - imports a relative path that resolves outside packages/calls/engine/
//     (i.e. reaches into ../ui or ../bridge) — the engine must stay
//     location/consumer-agnostic per docs/calls.md ("Location-agnostic so it
//     runs in an overlay *or* a popup")
//
// Deliberately dependency-free (regex, not a real parser) so it runs in CI's
// `lint` job with no `pnpm install` — same constraint as the other checks
// there. A regex is enough here: catching the common-case `import ... from
// 'react'` is the point, not defending against deliberately obfuscated code.
//
//   node scripts/check-calls-engine-boundary.mjs
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const engineDir = join(repo, 'packages', 'calls', 'engine')
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts'])

// import/export ... from '<spec>'  (covers `import x from`, `import {a} from`,
// `import * as x from`, `import type {a} from`, `export {a} from`, `export *
// from`, and the combination `import x, {a} from`)
const FROM_RE = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g
// side-effect-only: import '<spec>'
const BARE_IMPORT_RE = /(?<!\bfrom\s{0,20})\bimport\s*['"]([^'"]+)['"]/g
// dynamic: import('<spec>')
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function importSpecifiers(source) {
  const specs = new Set()
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const m of source.matchAll(re)) specs.add(m[1])
  }
  return specs
}

function isReactSpecifier(spec) {
  return spec === 'react' || spec === 'react-dom' || spec.startsWith('react/') || spec.startsWith('react-dom/')
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const violations = []

for await (const file of walk(engineDir)) {
  const ext = extname(file)
  if (!SOURCE_EXTS.has(ext)) continue
  const rel = relative(repo, file)

  if (ext === '.tsx') {
    violations.push(`${rel}: .tsx file inside engine/ (JSX is not allowed here)`)
    continue
  }

  const source = await readFile(file, 'utf8')
  for (const spec of importSpecifiers(source)) {
    if (isReactSpecifier(spec)) {
      violations.push(`${rel}: imports "${spec}" — engine/ must not import React`)
      continue
    }
    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(file), spec)
      const withinEngine = resolved === engineDir || resolved.startsWith(engineDir + sep)
      if (!withinEngine) {
        violations.push(
          `${rel}: imports "${spec}" which resolves outside engine/ — engine/ must not depend on ui/ or bridge/`
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    'packages/calls engine/ import-boundary violation(s) (docs/calls.md: "engine/ imports NO React/DOM"):'
  )
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(`OK — packages/calls/engine has no React/DOM imports and no ui/ or bridge/ imports`)
