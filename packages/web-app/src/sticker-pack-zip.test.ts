// Self-check for sticker pack zip detection. Run: node src/sticker-pack-zip.test.ts
import { strict as assert } from 'node:assert'
import {
  checkPackListing,
  emojisFromFileName,
  parsePackListing,
  stickerMagicMatches,
  MAX_PACK_ENTRIES,
  MAX_STICKER_BYTES,
} from './sticker-pack-zip.ts'

const f = (name: string, originalSize = 1000) => ({ name, originalSize })

// StickersBot layout: url-quoted folder, emoji in file names
assert.deepEqual(
  parsePackListing(
    [f('Cute%20Cats/'), f('Cute%20Cats/1.cat+🐱.webp'), f('Cute%20Cats/2.x+😺.webp')],
    'Cute%20Cats-abc123def.zip'
  ),
  { name: 'Cute Cats', entries: ['Cute%20Cats/1.cat+🐱.webp', 'Cute%20Cats/2.x+😺.webp'] }
)

// flat zip: named after the file; junk is ignored
assert.equal(
  parsePackListing([f('a.png'), f('b.tgs'), f('__MACOSX/._a.png'), f('.DS_Store')], 'my-dogs.zip')?.name,
  'my-dogs'
)

// not a pack
assert.equal(parsePackListing([f('a.png'), f('readme.txt')], 'x.zip'), null, 'other file types')
assert.equal(parsePackListing([f('a/1.png'), f('b/2.png')], 'x.zip'), null, 'two folders')
assert.equal(parsePackListing([f('1.png'), f('a/2.png')], 'x.zip'), null, 'mixed flat and folder')
assert.equal(parsePackListing([f('a/b/1.png')], 'x.zip'), null, 'nested')
assert.equal(parsePackListing([f('../1.png')], 'x.zip'), null, 'traversal')
assert.equal(parsePackListing([], 'x.zip'), null, 'empty')
assert.equal(parsePackListing([f('1.png', MAX_STICKER_BYTES + 1)], 'x.zip'), null, 'huge file')
assert.equal(
  parsePackListing(Array.from({ length: MAX_PACK_ENTRIES + 1 }, (_, i) => f(`${i}.png`)), 'x.zip'),
  null,
  'too many entries'
)

// the reason is shown to the user on import
assert.equal(checkPackListing([f('a/1.png'), f('b/2.png')], 'x.zip'), 'files in more than one folder')
assert.match(String(checkPackListing([f('a.png'), f('readme.txt')], 'x.zip')), /readme\.txt is not/)

// magic bytes
const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap(x => (typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : [x])))
assert.ok(stickerMagicMatches('a.PNG', bytes(0x89, 'PNG')))
assert.ok(stickerMagicMatches('a.webp', bytes('RIFF', 0, 0, 0, 0, 'WEBP')))
assert.ok(stickerMagicMatches('a.tgs', bytes(0x1f, 0x8b)))
assert.ok(stickerMagicMatches('a.gif', bytes('GIF89a')))
assert.ok(!stickerMagicMatches('a.png', bytes('GIF89a')), 'gif posing as png')
assert.ok(!stickerMagicMatches('a.webp', bytes('RIFF', 0, 0, 0, 0, 'WAVE')))

// emojis in StickersBot file names
assert.deepEqual(emojisFromFileName('Cute%20Cats/12.cat+🐱.webp'), ['🐱'])
assert.deepEqual(emojisFromFileName('1.x+👨‍👩‍👧😺🇩🇪.png'), ['👨‍👩‍👧', '😺', '🇩🇪'], 'ZWJ, several, flag')
assert.deepEqual(emojisFromFileName('1.a+b+👍🏽.webp'), ['👍🏽'], 'last plus, skin tone')
assert.deepEqual(emojisFromFileName('1+abc.webp'), [], 'no emoji')
assert.deepEqual(emojisFromFileName('a+b/1.webp'), [], 'plus only in folder')
assert.deepEqual(emojisFromFileName('3.png'), [])

console.log('sticker-pack-zip: ok')
