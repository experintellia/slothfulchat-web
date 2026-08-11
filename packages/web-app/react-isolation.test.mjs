// Two Reacts live in this workspace and only one of them may reach the app.
//
//   packages/calls        react ^19  — the call UI, bundled into dist/runtime.js
//   packages/web-app dev  react 18.3.1 — @open-rpc/docs-react peer-pins the exact
//                         version, so aligning on 19 is not on offer. It is only
//                         for api-docs/openrpc/viewer.js, bundled separately.
//
// Nothing enforces that split at build time: `react` resolves relative to the
// importing file, so today runtime.ts → @slothfulchat/calls/ui → packages/calls'
// own react@19. Two changes would silently flip the shipped app to React 18 —
// a direct `react` import from packages/web-app/src/, or a move to a hoisted
// node-linker — and neither produces an error, only a different bundle.
//
//   node --test packages/web-app/react-isolation.test.mjs
import { deepEqual, equal, ok } from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..')
const read = (p) => readFileSync(p, 'utf8')

// `from 'react'`, bare `import 'react'`, `import('react')`, `require('react')`,
// and every subpath (react-dom/client, react/jsx-runtime). Type-only imports
// match too: `import type … from 'react'` still ends in `from 'react'`.
// ponytail: string-literal specifiers only. A computed specifier would slip
// past — and would be a much louder thing to find in review than a plain import.
const REACT_IMPORT = /(?:from|import|require)\s*\(?\s*['"](react(?:-dom)?(?:\/[^'"]*)?)['"]/g

/** Every source file under a directory, recursively. */
const sources = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(m?[jt]sx?|tsx)$/.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))

test('nothing under packages/web-app/src imports react', () => {
  const src = path.join(here, 'src')
  const files = sources(src)
  // A glob that silently matches nothing would pass this test forever.
  equal(files.length > 20, true, `only found ${files.length} sources under src/ — bad walk?`)

  const offenders = files.flatMap((f) =>
    [...read(f).matchAll(REACT_IMPORT)].map((m) => `${path.relative(repo, f)} imports '${m[1]}'`),
  )
  deepEqual(
    offenders,
    [],
    'React must not enter packages/web-app/src — it would resolve to this package\'s ' +
      'react@18 devDependency (docs-react peer pin) and ship React 18 in dist/runtime.js. ' +
      'React UI belongs in packages/calls/ui; the OpenRPC viewer belongs in api-docs/.',
  )
})

/** The version pnpm-lock.yaml records for `dep` in workspace `importer`. */
function lockedVersion(lock, importer, dep) {
  const lines = lock.split('\n')
  let inImporter = false
  for (let i = 0; i < lines.length; i++) {
    // importer keys sit at two spaces under `importers:`
    if (/^ {2}\S/.test(lines[i])) inImporter = lines[i].trimEnd() === `  ${importer}:`
    if (!inImporter || lines[i].trimEnd() !== `      ${dep}:`) continue
    for (let j = i + 1; j < lines.length && /^ {8}/.test(lines[j]); j++) {
      const m = lines[j].match(/^ {8}version:\s*(\S+)/)
      if (m) return m[1]
    }
  }
  return null
}

// Reads the lockfile rather than resolving `react` for real. It has to: this
// runs in CI's lint job, which cannot `pnpm install` at all (the jsonrpc-client
// file: dep does not exist until apply-patches), so there is no node_modules to
// resolve through. Reading the committed lockfile is also the better check —
// it fails in review, on the diff that would collapse the two, rather than
// after an install on someone's machine.
test("packages/calls locks the react major it declares, not web-app's", () => {
  const declared = JSON.parse(read(path.join(repo, 'packages/calls/package.json'))).dependencies
    .react
  const wanted = declared.match(/\d+/)[0]
  const got = lockedVersion(read(path.join(repo, 'pnpm-lock.yaml')), 'packages/calls', 'react')
  ok(got, 'no react entry for packages/calls in pnpm-lock.yaml — did the importer key move?')
  equal(
    got.split('.')[0],
    wanted,
    `packages/calls declares react ${declared} but the lockfile pins ${got} — ` +
      'the two Reacts have collapsed into one, so dist/runtime.js is not shipping what calls asked for.',
  )
})
