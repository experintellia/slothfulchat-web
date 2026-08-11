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
// An item is marked `added` when it does not exist upstream at all, `changed`
// when it does and a *substantive* line in it is ours — the signature, the
// body, the attributes. Doc comments, blank lines and reformatting are not
// substantive, so an item that only reads differently from upstream gets no
// mark: the 🦥 is worth reading only while it means the behaviour differs.
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

export const MARKER = '🦥'
/** Only this crate's sources reach the generated client and the OpenRPC spec. */
const API_SRC = 'deltachat-jsonrpc/src'
/** Record of what was marked, consumed by verify-fork-marks.mjs. */
export const MANIFEST = (root) => path.join(root, 'build/core/fork-marks.json')

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

/**
 * First line of the run of attributes/doc comments attached to `decl`.
 *
 * Attributes may span several lines — `#[rpc(\n  all_positional,\n  …\n)]` is
 * the one that matters, since missing it means every RPC method goes unmarked.
 * So an attribute is walked back over by brackets, not by matching `#[` on the
 * line above: from its closing `]`, sum `delta` upwards until the brackets
 * balance, and that line is its `#[`.
 */
function attrStart(lines, decl) {
  let i = decl
  for (;;) {
    if (i > 0 && /^\s*\/\/\//.test(lines[i - 1])) {
      i--
      continue
    }
    if (i === 0 || !/]\s*$/.test(code(lines[i - 1]))) return i
    let j = i - 1
    let depth = 0
    do depth += delta(lines[j--])
    while (j >= 0 && depth !== 0)
    if (depth !== 0 || !/^\s*#!?\[/.test(lines[j + 1])) return i
    i = j + 1
  }
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
 * @returns {{decl: number, docEnd: number, from: number, to: number}[]}
 */
export function apiItems(source) {
  const lines = source.split('\n')
  const items = []
  const add = (decl, to) => {
    const from = attrStart(lines, decl)
    let docEnd = from
    while (docEnd < decl && /^\s*\/\/\//.test(lines[docEnd])) docEnd++
    items.push({ decl, docEnd, from, to })
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

/** `{kind, name}` of a Rust declaration line: an rpc method, or anything else. */
function declared(line) {
  const fn = /^\s*(pub(\([\w:]+\))? )?(async )?fn (\w+)/.exec(line)
  if (fn) return { kind: 'method', name: fn[4] }
  const rest = line.replace(/^\s*(pub(\([\w:]+\))?\s+)?((struct|enum)\s+)?/, '')
  return { kind: 'type', name: /^\w+/.exec(rest)?.[0] ?? '?' }
}

/**
 * Is this line one a reader would care that we changed?
 *
 * The signature, the body and the attributes are; a `///` or `//!` doc line and
 * a blank line are not — reword a doc comment and the item a consumer calls is
 * upstream's, byte for byte. Reindentation never gets this far: blameFork
 * blames with `-w`, so a line our patches only moved sideways stays upstream's.
 * Plain `//` comments count as substantive on purpose — they sit in the body
 * and in this stack they come with the behaviour change they explain.
 */
const substantive = (line) => Boolean(line.trim()) && !/^\s*\/\/[/!]/.test(line)

/**
 * Insert the marker into every API item our patches substantively touched.
 *
 * `added` = the item is ours whole. `changed` = it exists upstream and at least
 * one substantive line in it is ours. Docs-and-whitespace-only differences get
 * no mark at all: a 🦥 that fires on a reflow teaches readers to ignore it.
 *
 * @param source     Rust source text.
 * @param forkLines  Map of 1-based line number -> patch label that wrote it.
 * @returns `marked` items, and what they were — see verify-fork-marks.mjs.
 */
export function markSource(source, forkLines) {
  const lines = source.split('\n')
  const inserts = new Map()
  const methods = []
  const types = []
  let marked = 0

  for (const { decl, docEnd, from, to } of apiItems(source)) {
    const patches = new Set()
    let upstream = false
    let touched = false
    for (let i = from; i < to; i++) {
      const patch = forkLines.get(i + 1)
      if (patch) {
        patches.add(patch)
        touched ||= substantive(lines[i])
      } else if (lines[i].trim()) upstream = true
    }
    // Every patch that wrote any line is still credited — the gate is only
    // whether there is anything to credit them for.
    if (!patches.size || (upstream && !touched)) continue
    // Recorded whether or not a marker is inserted below: re-running on an
    // already-marked tree must still report the same set of items, or the
    // second run would hand verify-fork-marks.mjs an empty manifest.
    const { kind, name } = declared(lines[decl])
    ;(kind === 'method' ? methods : types).push(name)
    if (lines.slice(from, to).some((l) => l.includes(MARKER))) continue

    const indent = lines[from].match(/^ */)[0]
    const what = upstream ? 'changed' : 'added'
    const by = [...patches].sort().join(', ')
    const gap = docEnd > from ? [`${indent}///`] : []
    inserts.set(docEnd, [...gap, `${indent}/// ${MARKER} slothfulchat-web fork: ${what} by ${by}.`])
    marked++
  }

  if (!marked) return { source, marked, methods, types }
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (inserts.has(i)) out.push(...inserts.get(i))
    out.push(lines[i])
  }
  return { source: out.join('\n'), marked, methods, types }
}

/**
 * 1-based line -> patch label, for every line one of our patches wrote.
 *
 * `-w` so that rustfmt reindenting an upstream line — what `core/0019` does to
 * `get_dbfile().metadata()` by wrapping it in a `#[cfg]` — leaves it upstream's.
 */
export function blameFork(repo, file, labels) {
  const forkLines = new Map()
  for (const line of git(repo, 'blame', '-w', '--line-porcelain', '--', file).split('\n')) {
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
  const manifest = { methods: [], types: [] }
  for (const rel of rustFiles(path.join(buildCore, API_SRC))) {
    const file = path.join(API_SRC, rel)
    const forkLines = blameFork(buildCore, file, labels)
    if (!forkLines.size) continue
    const abs = path.join(buildCore, file)
    const { source, marked, methods, types } = markSource(readFileSync(abs, 'utf8'), forkLines)
    manifest.methods.push(...methods)
    manifest.types.push(...types)
    if (!marked) continue
    writeFileSync(abs, source)
    console.log(`${file}: ${marked} item(s) marked`)
    total += marked
  }
  // What was marked, for verify-fork-marks.mjs to check the generators against.
  // Written even when nothing matched, so "the marker never ran" and "the
  // marker found nothing" stay distinguishable downstream.
  writeFileSync(MANIFEST(root), JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `marked ${total} API item(s) in build/core/${API_SRC} ` +
      `(${manifest.methods.length} method(s), ${manifest.types.length} type(s)/field(s))`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
