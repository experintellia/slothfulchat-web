// Fails when a `core/NNNN` or `desktop/NNNN` reference names a patch file that
// doesn't exist. Patch numbers are permanent (scripts/patch-numbers.mjs), so a
// dangling reference means its patch was removed or folded into another one.
// Changelogs are history and the mark-fork-api test uses made-up labels.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const SKIP = [/(^|\/)CHANGELOG\.md$/, /^scripts\/mark-fork-api\.test\.mjs$/]
const stacks = readdirSync('patches', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const exist = new Map(stacks.map((s) => [s, new Set(readdirSync(`patches/${s}`).map((f) => f.slice(0, 4)))]))
// Bare `core/1004` or `patches/core/1004`, not a path like `chatmail/core/1234`.
const ref = new RegExp(`(?:(?<=patches/)|(?<![\\w./-]))(${stacks.join('|')})/(\\d{4})\\b`, 'g')

let bad = 0
for (const file of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')) {
  if (!file || SKIP.some((re) => re.test(file))) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(ref)) {
      if (exist.get(m[1]).has(m[2])) continue
      console.error(`${file}:${i + 1}: ${m[0]} names no patch file`)
      bad++
    }
  })
}
if (bad) {
  console.error(`${bad} dangling patch reference(s): point them at the patch they meant, or drop them`)
  process.exit(1)
}
