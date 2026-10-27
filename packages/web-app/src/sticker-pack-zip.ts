/**
 * Decides from a zip's file list alone whether it is a sticker pack, without
 * decompressing anything. Kept free of imports so CI's dependency-free unit
 * step can test it (sticker-pack-zip.test.ts).
 *
 * The format is StickersBot's (github.com/deltachat-bot/stickersbot):
 * `<url-quoted title>/<id>.<desc>+<emoji>.webp`, one top-level folder. A flat
 * zip of stickers counts too; the pack is then named after the zip.
 */

/** zips above this are never inspected automatically (StickersBot's own cap) */
export const MAX_PACK_ZIP_BYTES = 15 * 1024 * 1024
export const MAX_PACK_ENTRIES = 200
/** per sticker; the core refuses bigger files too */
export const MAX_STICKER_BYTES = 5 * 1024 * 1024
export const MAX_PACK_TOTAL_BYTES = 50 * 1024 * 1024

const STICKER_EXT = /\.(png|webp|gif|tgs)$/i
/** junk archivers and file managers add; never part of a pack */
const IGNORED = /(^|\/)(__MACOSX\/|\.[^/]*$|Thumbs\.db$|desktop\.ini$)/i

export type ZipEntryInfo = { name: string; originalSize: number }
export type PackListing = {
  name: string
  /** zip entry names of the stickers, in zip order */
  entries: string[]
}

export function packNameFromZipName(zipName: string): string {
  return cleanPackName(zipName.replace(/\.zip$/i, ''))
}

/** Pack names are free text in the core; just keep them printable and short. */
export function cleanPackName(raw: string): string {
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    /* not url-quoted */
  }
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
  return name || 'Stickers'
}

/** The pack in this zip, or null if it is anything else. */
export function parsePackListing(
  files: ZipEntryInfo[],
  zipName: string
): PackListing | null {
  const entries = files.filter(f => !f.name.endsWith('/') && !IGNORED.test(f.name))
  if (entries.length === 0 || entries.length > MAX_PACK_ENTRIES) return null
  let total = 0
  const folders = new Set<string>()
  for (const f of entries) {
    if (!STICKER_EXT.test(f.name) || f.originalSize > MAX_STICKER_BYTES) return null
    total += f.originalSize
    const parts = f.name.split('/')
    if (parts.length > 2 || parts.some(p => p === '..' || p === '')) return null
    folders.add(parts.length === 2 ? parts[0] : '')
  }
  // all flat, or all in one folder
  if (folders.size !== 1 || total > MAX_PACK_TOTAL_BYTES) return null
  const [folder] = folders
  return {
    name: folder ? cleanPackName(folder) : packNameFromZipName(zipName),
    entries: entries.map(f => f.name),
  }
}

/** Whether `head` (a file's first bytes) is what extension `name` promises. */
export function stickerMagicMatches(name: string, head: Uint8Array): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const ascii = (from: number, s: string) =>
    [...s].every((c, i) => head[from + i] === c.charCodeAt(0))
  switch (ext) {
    case 'png':
      return head[0] === 0x89 && ascii(1, 'PNG')
    case 'gif':
      return ascii(0, 'GIF8')
    case 'webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP')
    case 'tgs':
      return head[0] === 0x1f && head[1] === 0x8b
    default:
      return false
  }
}

export function stickerMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'tgs' ? 'application/x-tgsticker' : `image/${ext}`
}
