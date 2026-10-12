// Permanent patch numbers for update-patches.sh.
//
// format-patch names files by position, so removing one patch would rename
// every patch after it and leave every `desktop/NNNN` reference pointing at a
// neighbour. Instead each regenerated patch keeps the number of the file it
// came from (matched by format-patch's subject slug), a removed patch leaves a
// gap, and a new patch takes the next free number after the one before it.
// Upstream fixes are 0001-0999, everything else 1000-9999.
//
// Usage: node scripts/patch-numbers.mjs <patches/stack> <format-patch output dir>
// Prints "<output name>\t<final name>" per patch; RENUMBER=1 numbers by position.

import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RANGES = [
  [1, 999],
  [1000, 9999],
]
const num = (name) => Number(name.slice(0, 4))
const slug = (name) => name.slice(5)
const pad = (n) => String(n).padStart(4, '0')

/**
 * @param {string[]} oldNames current patch files, e.g. 1004-web-app-foo.patch
 * @param {string[]} newNames format-patch output in apply order, fixes numbered
 *   from 0001 and everything else from 1000
 * @returns {string[]} final file names, in the order of newNames
 */
export function assignNumbers(oldNames, newNames, { renumber = false } = {}) {
  // ponytail: matching by slug means a reworded subject only keeps its number
  // when its old slot is free between its neighbours (usually it is).
  const pool = new Map()
  if (!renumber) {
    for (const name of [...oldNames].sort()) {
      if (!pool.has(slug(name))) pool.set(slug(name), [])
      pool.get(slug(name)).push(num(name))
    }
  }
  const final = new Map()
  for (const [lo, hi] of RANGES) {
    const items = newNames
      .filter((n) => (num(n) >= 1000) === lo >= 1000)
      .map((name) => ({ name, old: pool.get(slug(name))?.shift() }))
    // Keep the longest increasing run of old numbers that fall in this range,
    // so a reorder renumbers as few patches as possible.
    const ok = items.map((it) => it.old >= lo && it.old <= hi)
    const len = items.map(() => 0)
    const prev = items.map(() => -1)
    for (let i = 0; i < items.length; i++) {
      if (!ok[i]) continue
      len[i] = 1
      for (let j = 0; j < i; j++) {
        if (ok[j] && items[j].old < items[i].old && len[j] + 1 > len[i]) {
          len[i] = len[j] + 1
          prev[i] = j
        }
      }
    }
    const kept = new Set()
    let at = len.indexOf(Math.max(0, ...len))
    while (at >= 0 && len[at] > 0) {
      kept.add(at)
      at = prev[at]
    }
    // ponytail: removing the last patch of a range frees its number for the
    // next new one; keep a high-water mark per stack if that ever bites.
    let last = lo - 1
    items.forEach((it, i) => {
      if (kept.has(i)) {
        last = it.old
      } else {
        const next = items.findIndex((x, j) => j > i && kept.has(j))
        const limit = next >= 0 ? items[next].old : hi + 1
        if (last + 1 >= limit) {
          throw new Error(
            `no free number for ${slug(it.name)} between ${pad(last)} and ${pad(limit)}; ` +
              'run with RENUMBER=1 to number by position',
          )
        }
        last += 1
      }
      final.set(it.name, `${pad(last)}-${slug(it.name)}`)
    })
  }
  return newNames.map((n) => final.get(n))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [oldDir, newDir] = process.argv.slice(2)
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.patch')).sort() : [])
  const newNames = list(newDir)
  try {
    const final = assignNumbers(list(oldDir), newNames, { renumber: process.env.RENUMBER === '1' })
    newNames.forEach((n, i) => console.log(`${n}\t${final[i]}`))
  } catch (err) {
    console.error(`${oldDir}: ${err.message}`)
    process.exit(1)
  }
}
