#!/usr/bin/env node
// Fail the build if the 🦥 fork marks did not survive into the documentation.
//
// They already didn't, once, and silently: `patches/core/0031` reformatted
// `#[rpc(all_positional, ts_outdir = …)]` into a four-line attribute, the
// marker's backwards attribute scan stopped recognising it, and every RPC
// method quietly lost its mark while the type marks kept working — so the
// OpenRPC spec and types.ts still looked marked and nobody noticed the methods
// were bare. A count of "are there any marks" would not have caught it; this
// checks each marked symbol against each surface that is supposed to carry it.
//
//   node scripts/verify-fork-marks.mjs        # after the docs are generated
//
// Run it after `pnpm api-docs`: it wants the typedoc HTML.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFEST, MARKER } from './mark-fork-api.mjs'

const root = path.resolve(fileURLToPath(import.meta.url), '../..')
const coreTs = path.join(root, 'build/core/deltachat-jsonrpc/typescript')
const read = (p) => readFileSync(p, 'utf8')
const count = (s) => (s.match(new RegExp(MARKER, 'g')) ?? []).length
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase())

const problems = []
const check = (ok, msg) => void (ok || problems.push(msg))

if (!existsSync(MANIFEST(root))) {
  console.error(`${MANIFEST(root)} is missing — scripts/mark-fork-api.mjs never ran.`)
  process.exit(1)
}
const { methods, types } = JSON.parse(read(MANIFEST(root)))
console.log(`marked in build/core: ${methods.length} method(s), ${types.length} type(s)/field(s)`)

// The regression class: a whole kind of item stops being marked. The patch
// stack has always touched both, so an empty side means the scanner broke, not
// that the fork got smaller.
check(methods.length > 0, 'no rpc METHOD was marked in build/core — the #[rpc] scan found nothing')
check(types.length > 0, 'no TYPE was marked in build/core — the TypeDef scan found nothing')

/** Is `name`'s JSDoc block in `src` marked? */
const jsdocMarked = (src, name) => {
  const at = src.search(new RegExp(`^\\s*((public|private|protected|readonly|declare) )*${name}[(:<]`, 'm'))
  if (at < 0) return null // not in this surface at all
  const open = src.lastIndexOf('/**', at)
  if (open < 0) return false
  const block = src.slice(open, at)
  const close = block.indexOf('*/')
  // The back-scan has no floor, so an UNDOCUMENTED member would otherwise be
  // validated against the previous member's block and report marked — turning
  // a partial-loss regression green. Anything but whitespace between the
  // block's `*/` and the member means we scanned past its owner.
  if (close < 0 || /[;}]|\*\//.test(block.slice(close + 2))) return false
  return block.includes(MARKER)
}

/** Per-symbol: every marked method must still be marked here. */
function eachMethod(label, file, name) {
  if (!existsSync(file)) return check(false, `${label}: ${file} is missing`)
  const src = read(file)
  for (const m of methods) {
    const got = jsdocMarked(src, name(m))
    check(got !== null, `${label}: ${name(m)} is not in ${path.basename(file)} at all`)
    check(got !== false, `${label}: ${name(m)} lost its ${MARKER} mark`)
  }
}

/** Per-surface: at least as many marks as were injected. */
function atLeast(label, file, expected) {
  if (!existsSync(file)) return check(false, `${label}: ${file} is missing`)
  const n = count(read(file))
  check(n >= expected, `${label}: ${n} mark(s), expected at least ${expected}`)
}

// 1. the generated TypeScript, and the declarations tsc emits from it
eachMethod('generated/client.ts', path.join(coreTs, 'generated/client.ts'), camel)
eachMethod('dist/generated/client.d.ts', path.join(coreTs, 'dist/generated/client.d.ts'), camel)
atLeast('generated/types.ts', path.join(coreTs, 'generated/types.ts'), types.length)
atLeast('dist/generated/types.d.ts', path.join(coreTs, 'dist/generated/types.d.ts'), types.length)

// 2. the OpenRPC document — methods keep their wire (snake_case) names here
const openrpc = path.join(coreTs, 'generated/openrpc.json')
if (!existsSync(openrpc)) {
  check(false, `openrpc.json: ${openrpc} is missing`)
} else {
  const doc = JSON.parse(read(openrpc))
  for (const m of methods) {
    const entry = doc.methods.find((x) => x.name === m)
    check(entry, `openrpc.json: method ${m} is absent`)
    check(
      !entry || (entry.description ?? '').includes(MARKER),
      `openrpc.json: method ${m} lost its ${MARKER} mark`,
    )
  }
  const schemas = count(JSON.stringify(doc.components?.schemas ?? {}))
  check(
    schemas >= types.length,
    `openrpc.json: ${schemas} mark(s) in components.schemas, expected at least ${types.length}`,
  )
}

// 3. the rendered TypeDoc HTML — RawClient is where the methods land
const docs = path.join(coreTs, 'docs')
if (!existsSync(docs)) {
  check(false, `typedoc: ${docs} is missing — run \`pnpm api-docs\``)
} else {
  atLeast('typedoc RawClient.html', path.join(docs, 'classes/RawClient.html'), methods.length)
  const html = readdirSync(docs, { recursive: true }).filter((f) => f.endsWith('.html'))
  const total = html.reduce((n, f) => n + count(read(path.join(docs, f))), 0)
  check(
    total >= methods.length + types.length,
    `typedoc: ${total} mark(s) across ${html.length} pages, ` +
      `expected at least ${methods.length + types.length}`,
  )
}

// What core-wasm publishes is not a fourth surface: `build:types` is a plain
// `cp -r` of the dist/ checked above, and a copy cannot drop a 🦥.

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log('all documentation surfaces carry the fork marks')
