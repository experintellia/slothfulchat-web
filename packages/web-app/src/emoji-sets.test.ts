// Self-check for the emoji-set catalogue. Run: node src/emoji-sets.test.ts
import { strict as assert } from 'node:assert'
import {
  EMOJI_SETS,
  DEFAULT_EMOJI_SET,
  TRACKED_EMOJI_SETS,
  emojiFonts,
} from './emoji-sets.ts'

// default exists and never reports usage (privacy: only non-standard is sent)
const def = EMOJI_SETS.find(s => s.id === DEFAULT_EMOJI_SET)
assert(def, 'default set must be in the catalogue')
assert.equal(def.track, false, 'the default set must not fire an analytics event')
assert(!TRACKED_EMOJI_SETS.includes(DEFAULT_EMOJI_SET), 'default set must be excluded from tracked ids')

// every other set is tracked, and the tracked list matches the catalogue
for (const s of EMOJI_SETS) {
  assert.equal(s.track, s.id !== DEFAULT_EMOJI_SET, `${s.id}: track must be (id !== default)`)
}
assert.deepEqual(
  TRACKED_EMOJI_SETS,
  EMOJI_SETS.filter(s => s.id !== DEFAULT_EMOJI_SET).map(s => s.id)
)

// emojiFonts resolves each id, and falls back to the default for unknowns
for (const s of EMOJI_SETS) assert.equal(emojiFonts(s.id), s.fonts)
assert.equal(emojiFonts('nope'), def.fonts, 'unknown id falls back to the default stack')

// 'native' must reference only SYSTEM fonts (no Sloth* web font → no download)
const native = EMOJI_SETS.find(s => s.id === 'native')
assert(!native.fonts.includes('Sloth'), 'native must not pull any bundled web font')

// every non-native set that isn't the OS default must pull exactly one of our
// bundled families, and every Sloth* family used must have a real @font-face
const cssPath = new URL('../static/fonts/emoji-fonts.css', import.meta.url)
const css = await (await import('node:fs/promises')).readFile(cssPath, 'utf-8')
for (const fam of ['SlothNotoColor', 'SlothNotoMono', 'SlothTwemoji']) {
  assert(css.includes(`font-family: '${fam}'`), `emoji-fonts.css must define @font-face ${fam}`)
}
for (const s of EMOJI_SETS) {
  for (const m of s.fonts.matchAll(/'(Sloth\w+)'/g)) {
    assert(css.includes(`font-family: '${m[1]}'`), `${s.id} references undefined web font ${m[1]}`)
  }
}

console.log(`ok — ${EMOJI_SETS.length} emoji sets, ${TRACKED_EMOJI_SETS.length} tracked, all fonts defined`)
