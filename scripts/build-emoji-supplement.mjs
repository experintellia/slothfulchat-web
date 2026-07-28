// Regenerates the emoji-mart data supplement — the emoji that @emoji-mart/data
// (~Unicode 15) is missing, taken from emojibase-data (Unicode 17). The
// picker and the composer :emoji: completion both read @emoji-mart/data via
// the vendored EmojiPicker/emojiDataExtended.ts, which folds this supplement
// in (see patches/desktop). Additive only — the base dataset is untouched.
//
// Run after applying patches (needs the build/desktop frontend to write into):
//   node scripts/build-emoji-supplement.mjs && scripts/update-patches.sh
//
// Pinned sources (bump when a newer Unicode lands):
const EMOJIBASE = 'emojibase-data@17.0.0' // Unicode 17.0
const EMOJIMART = '@emoji-mart/data@1.2.1' // latest npm release, ~Unicode 15
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(
  repo,
  'build/desktop/packages/frontend/src/components/EmojiPicker/emoji-supplement.json'
)

// npm-pack a package into `dir` and return its extracted `package/` path
function fetchPkg(spec, dir) {
  const tgz = execFileSync('npm', ['pack', spec, '--silent'], { cwd: dir, encoding: 'utf8' }).trim()
  execFileSync('tar', ['xzf', tgz], { cwd: dir })
  return join(dir, 'package')
}

const tmp = mkdtempSync(join(tmpdir(), 'emoji-'))
const ej = JSON.parse(readFileSync(join(fetchPkg(EMOJIBASE, tmp), 'en/data.json'), 'utf8'))
const emDir = fetchPkg(EMOJIMART, tmp)
// @emoji-mart/data ships per-Unicode sets under sets/<n>/native.json; use the newest
const setN = Math.max(...readdirSync(join(emDir, 'sets')).map(Number).filter(Number.isFinite))
const em = JSON.parse(readFileSync(join(emDir, `sets/${setN}/native.json`), 'utf8'))
const sc = JSON.parse(readFileSync(join(tmp, 'package/en/shortcodes/emojibase.json'), 'utf8'))
const iamcal = JSON.parse(readFileSync(join(tmp, 'package/en/shortcodes/iamcal.json'), 'utf8'))

const haveNative = new Set(Object.values(em.emojis).flatMap(e => e.skins.map(s => s.native)))
const haveId = new Set(Object.keys(em.emojis))
// emojibase group number -> emoji-mart category id (group 2 = skin-tone components, skipped)
const GROUP = { 0: 'people', 1: 'people', 3: 'nature', 4: 'foods', 5: 'places', 6: 'activity', 7: 'objects', 8: 'symbols', 9: 'flags' }
const title = s => s.replace(/(^|[\s:-])\w/g, c => c.toUpperCase())
const first = v => (Array.isArray(v) ? v[0] : v)
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

const out = []
for (const e of ej) {
  if (!(e.version > setN) || haveNative.has(e.emoji) || !(e.group in GROUP)) continue
  let id = slug(first(iamcal[e.hexcode]) || first(sc[e.hexcode]) || e.label)
  while (haveId.has(id) || out.some(o => o.id === id)) id += '_' + e.hexcode.toLowerCase().slice(0, 4)
  out.push({
    category: GROUP[e.group],
    id,
    name: title(e.label),
    keywords: [...new Set([...(e.tags || []), ...String(first(sc[e.hexcode]) || '').split('_')].filter(Boolean))],
    skins: [{ unified: e.hexcode.toLowerCase(), native: e.emoji }],
    // emoji-mart filters emoji whose `version` exceeds its `emojiVersion` prop
    // (choices max out at 15), so cap at 15 — the field is only used for that
    // filter, and we want every newer emoji shown.
    version: Math.min(Math.floor(e.version), setN),
  })
}
out.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.length} emoji to ${OUT} (base set = Unicode ${setN})`)
