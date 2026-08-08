#!/usr/bin/env node
// Mark the JSON-RPC API surface our patch stack touches with a 🦥 doc line, so
// the generated documentation says which parts are the fork's and which came
// from upstream chatmail core.
//
// Both doc artifacts derive from the same Rust `///` comments — yerpc's
// TypeScript generator emits them as JSDoc (which typedoc renders and which
// ships in @slothfulchat/core-wasm's .d.ts, so an IDE hover shows them too),
// and yerpc's OpenRPC generator puts them in the spec's descriptions. Marking
// once in Rust therefore reaches all three.
//
// The marks are derived, never hand-written: `build/core` is a worktree of the
// pinned submodule with `patches/core/*.patch` applied as commits on top, so
// `git blame` says per line whether upstream or one of our patches wrote it,
// and which one. Nothing can drift out of date.
//
// Writes to `build/core` only — never to `patches/` or `vendor/`. Run it as a
// step of documentation generation, *not* from apply-patches.sh: build/core
// doubles as the edit-and-`update-patches.sh` worktree, and marks committed
// there would end up back in patches/.
//
//   node scripts/mark-fork-api.mjs            # after scripts/apply-patches.sh
//
// Callers that must not fail hard should append `|| true` — unmarked docs beat
// no docs.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '🦥'
/** Only this crate's sources reach the generated client and the OpenRPC spec. */
const API_SRC = 'deltachat-jsonrpc/src'

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })

/** Strip string/char literals and line comments so brace counting isn't fooled. */
const code = (line) =>
  line.replace(/r?"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])*'/g, "''").replace(/\/\/.*$/, '')

const delta = (line) => {
  const c = code(line)
  return (c.match(/[{([]/g)?.length ?? 0) - (c.match(/[})\]]/g)?.length ?? 0)
}

/** Line index (exclusive) where the block opened at `start` closes. */
function blockEnd(lines, start) {
  let depth = delta(lines[start])
  if (depth <= 0) return start + 1
  for (let i = start + 1; i < lines.length; i++) {
    depth += delta(lines[i])
    if (depth <= 0) return i + 1
  }
  return lines.length
}

/** First line of the run of attributes/doc comments attached to `decl`. */
function attrStart(lines, decl) {
  let i = decl
  while (i > 0 && /^\s*(\/\/\/|#\[)/.test(lines[i - 1])) i--
  return i
}

// ponytail: a line scanner, not a Rust parser — it only has to find the item a
// changed line belongs to, and it leans on the source being rustfmt-formatted
// (top-level items unindented, 4 spaces per level). If core ever ships
// unformatted or macro-generated API types, swap this for syn behind a tiny
// `--emit-items` helper binary; nothing else in the script would change.
const RE_TYPE = /^(pub )?(struct|enum) (\w+)/
const RE_FN = /^ {4}(pub(\([\w:]+\))? )?(async )?fn \w+/
// Inside a struct/enum body there is nothing but fields and variants, so these
// stay unambiguous without tracking depth. The indents are exact on purpose:
// struct fields and enum variants sit at 4, a variant's own fields at 8, and
// anything deeper is a wrapped type expression, where a `///` would not compile.
const RE_VARIANT = /^ {4}[A-Z]\w*\s*([{(,=]|$)/
const RE_FIELD = /^(?: {4}| {8})(pub(\([\w:]+\))? )?[a-z_]\w*\s*:\s/

/**
 * Documented API items in one Rust source: the `#[rpc]` methods, the types that
 * derive TypeDef, and those types' variants and fields. Each item is the line
 * range that belongs to it, including its doc comment and attributes.
 *
 * @returns {{docEnd: number, from: number, to: number}[]}
 */
export function apiItems(source) {
  const lines = source.split('\n')
  const items = []
  const add = (decl, to) => {
    const from = attrStart(lines, decl)
    let docEnd = from
    while (docEnd < decl && /^\s*\/\/\//.test(lines[docEnd])) docEnd++
    items.push({ docEnd, from, to })
  }

  for (let i = 0; i < lines.length; i++) {
    if (RE_TYPE.test(lines[i]) && attrStart(lines, i) !== i) {
      const attrs = lines.slice(attrStart(lines, i), i).join('')
      if (!attrs.includes('TypeDef')) continue
      const end = blockEnd(lines, i)
      add(i, end)
      for (let j = i + 1; j < end - 1; j++) {
        if (RE_VARIANT.test(lines[j]) || RE_FIELD.test(lines[j])) add(j, blockEnd(lines, j))
      }
      i = end - 1
    } else if (/^impl /.test(lines[i]) && lines[attrStart(lines, i)].startsWith('#[rpc(')) {
      const end = blockEnd(lines, i)
      for (let j = i + 1; j < end - 1; j++) {
        if (RE_FN.test(lines[j])) {
          add(j, blockEnd(lines, j))
          j = blockEnd(lines, j) - 1
        }
      }
      i = end - 1
    }
  }
  return items
}

/**
 * Insert the marker into every API item that a fork line falls inside.
 *
 * @param source     Rust source text.
 * @param forkLines  Map of 1-based line number -> patch label that wrote it.
 */
export function markSource(source, forkLines) {
  const lines = source.split('\n')
  const inserts = new Map()
  let marked = 0

  for (const { docEnd, from, to } of apiItems(source)) {
    const patches = new Set()
    let upstream = false
    for (let i = from; i < to; i++) {
      const patch = forkLines.get(i + 1)
      if (patch) patches.add(patch)
      else if (lines[i].trim()) upstream = true
    }
    if (!patches.size) continue
    if (lines.slice(from, to).some((l) => l.includes(MARKER))) continue

    const indent = lines[from].match(/^ */)[0]
    const what = upstream ? 'changed' : 'added'
    const by = [...patches].sort().join(', ')
    const gap = docEnd > from ? [`${indent}///`] : []
    inserts.set(docEnd, [...gap, `${indent}/// ${MARKER} slothfulchat-web fork: ${what} by ${by}.`])
    marked++
  }

  if (!marked) return { source, marked }
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (inserts.has(i)) out.push(...inserts.get(i))
    out.push(lines[i])
  }
  return { source: out.join('\n'), marked }
}

/** 1-based line -> patch label, for every line one of our patches wrote. */
function blameFork(repo, file, labels) {
  const forkLines = new Map()
  for (const line of git(repo, 'blame', '--line-porcelain', '--', file).split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (m && labels.has(m[1])) forkLines.set(Number(m[2]), labels.get(m[1]))
  }
  return forkLines
}

function rustFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return rustFiles(p, base)
    return e.name.endsWith('.rs') ? [path.relative(base, p)] : []
  })
}

function main() {
  const root = path.resolve(fileURLToPath(import.meta.url), '../..')
  const buildCore = path.join(root, 'build/core')
  const base = git(path.join(root, 'vendor/core'), 'rev-parse', 'HEAD').trim()

  // format-patch numbers the patch files in commit order, so the Nth commit on
  // top of the pin is the Nth patch file. Cross-checked against the subject.
  const commits = git(buildCore, 'log', '--reverse', '--format=%H %s', `${base}..HEAD`)
    .trim()
    .split('\n')
  const files = readdirSync(path.join(root, 'patches/core')).sort()
  if (commits.length !== files.length) {
    throw new Error(`build/core has ${commits.length} commits but patches/core has ${files.length}`)
  }
  const labels = new Map(
    commits.map((c, i) => {
      const [sha, ...subject] = c.split(' ')
      const slug = subject.join(' ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const name = files[i]
      if (!name.slice(5).startsWith(slug.slice(0, 16))) {
        throw new Error(`patch order mismatch: ${name} vs "${subject.join(' ')}"`)
      }
      return [sha, `core/${name.slice(0, 4)}`]
    }),
  )

  let total = 0
  for (const rel of rustFiles(path.join(buildCore, API_SRC))) {
    const file = path.join(API_SRC, rel)
    const forkLines = blameFork(buildCore, file, labels)
    if (!forkLines.size) continue
    const abs = path.join(buildCore, file)
    const { source, marked } = markSource(readFileSync(abs, 'utf8'), forkLines)
    if (!marked) continue
    writeFileSync(abs, source)
    console.log(`${file}: ${marked} item(s) marked`)
    total += marked
  }
  console.log(`marked ${total} API item(s) in build/core/${API_SRC}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
