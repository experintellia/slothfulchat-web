// Permanent patch numbers for update-patches.sh.
//
// format-patch names files by position, so removing one patch would rename
// every patch after it and leave every `desktop/NNNN` reference pointing at a
// neighbour. Instead each regenerated patch keeps the number of the file it
// came from, matched by subject slug or, for a reworded subject, by its diff
// (`git patch-id`). A removed patch leaves a gap, and a new patch takes the
// next free number after the one before it. Numbers the old stack used are
// never handed to a different patch, so a reference to a removed patch dangles
// (and check-patch-refs.mjs fails) instead of quietly naming a newcomer.
// Upstream fixes are 0001-0999, everything else 1000-9999.
//
// Usage: node scripts/patch-numbers.mjs <patches/stack> <format-patch output dir>
// Prints "<output name>\t<final name>" per patch; RENUMBER=1 numbers by position.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RANGES = [
  [1, 999],
  [1000, 9999],
]
const num = (name) => Number(name.slice(0, 4))
const slug = (name) => name.slice(5)
const pad = (n) => String(n).padStart(4, '0')
const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value])

/**
 * @param {string[]} oldNames current patch files, e.g. 1004-web-app-foo.patch
 * @param {string[]} newNames format-patch output in apply order, fixes numbered
 *   from 0001 and everything else from 1000
 * @param {{renumber?: boolean, oldIds?: Map<string,string>, newIds?: Map<string,string>}} opts
 *   ids: patch-id per file name, used to match a patch whose subject changed
 * @returns {string[]} final file names, in the order of newNames
 */
export function assignNumbers(oldNames, newNames, { renumber = false, oldIds = new Map(), newIds = new Map() } = {}) {
  const used = new Set(renumber ? [] : oldNames.map(num))
  const bySlug = new Map()
  const byId = new Map()
  if (!renumber) {
    for (const name of [...oldNames].sort()) {
      push(bySlug, slug(name), name)
      if (oldIds.get(name)) push(byId, oldIds.get(name), name)
    }
  }
  const claimed = new Set()
  const take = (list) => {
    const name = list?.find((n) => !claimed.has(n))
    if (name) claimed.add(name)
    return name
  }
  const match = new Map()
  for (const n of newNames) {
    const o = take(bySlug.get(slug(n)))
    if (o) match.set(n, num(o))
  }
  for (const n of newNames) {
    if (match.has(n) || !newIds.get(n)) continue
    const o = take(byId.get(newIds.get(n)))
    if (o) match.set(n, num(o))
  }

  const final = new Map()
  for (const [lo, hi] of RANGES) {
    const items = newNames.filter((n) => (num(n) >= 1000) === lo >= 1000).map((name) => ({ name, old: match.get(name) }))
    // Keep the longest increasing run of old numbers that fall in this range,
    // so a reorder renumbers as few patches as possible.
    // ponytail: ties go to the earliest run, so a reorder can stop with "no
    // free number" although another equally long run would fit; RENUMBER=1
    // is the way out until that happens often enough to search all runs.
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
    let last = lo - 1
    items.forEach((it, i) => {
      if (kept.has(i)) {
        last = it.old
      } else {
        const next = items.findIndex((x, j) => j > i && kept.has(j))
        const limit = next >= 0 ? items[next].old : hi + 1
        let n = last + 1
        while (n < limit && used.has(n)) n++
        if (n >= limit) {
          throw new Error(
            `no free number for ${slug(it.name)} between ${pad(last)} and ${pad(limit)}; ` +
              'run with RENUMBER=1 to number by position',
          )
        }
        last = n
      }
      final.set(it.name, `${pad(last)}-${slug(it.name)}`)
    })
  }
  return newNames.map((n) => final.get(n))
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [oldDir, newDir] = process.argv.slice(2)
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.patch')).sort() : [])
  const ids = (dir, names) =>
    new Map(
      names.map((n) => [
        n,
        execFileSync('git', ['patch-id', '--stable'], { input: readFileSync(`${dir}/${n}`) }).toString().split(' ')[0],
      ]),
    )
  const oldNames = list(oldDir)
  const newNames = list(newDir)
  try {
    const final = assignNumbers(oldNames, newNames, {
      renumber: process.env.RENUMBER === '1',
      oldIds: ids(oldDir, oldNames),
      newIds: ids(newDir, newNames),
    })
    newNames.forEach((n, i) => console.log(`${n}\t${final[i]}`))
  } catch (err) {
    console.error(`${oldDir}: ${err.message}`)
    process.exit(1)
  }
}
