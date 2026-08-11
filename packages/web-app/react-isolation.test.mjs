// Two Reacts live in this workspace and only one of them may reach the app.
//
//   packages/calls        react ^19  — the call UI, bundled into dist/runtime.js
//   packages/web-app dev  react 18.3.1 — @open-rpc/docs-react peer-pins the exact
//                         version, so aligning on 19 is not on offer. It is only
//                         for api-docs/openrpc/viewer.js, bundled separately.
//
// Nothing enforces that split at build time: `react` resolves relative to the
// importing file, so today runtime.ts → @slothfulchat/calls/ui → packages/calls'
// own react@19. One change would silently flip the shipped app to React 18 — a
// direct `react` import from packages/web-app/src/ — and it produces no error,
// only a different bundle. That is what this checks.
//
//   node --test packages/web-app/react-isolation.test.mjs
import { deepEqual, equal } from 'node:assert/strict'
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
