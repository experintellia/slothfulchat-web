/**
 * Sticker pack zips — the runtime half of the sticker pack feature. The core
 * stores and manages packs (JSON-RPC `get_sticker_packs` & co.); this file only
 * does what needs a zip library: recognizing a pack zip in a chat, previewing
 * it, importing it, and exporting a pack as one. Registered as
 * window.__slothfulStickers for the desktop patch.
 */
import { unzipSync, zipSync } from 'fflate'
import {
  MAX_PACK_ZIP_BYTES,
  parsePackListing,
  stickerMagicMatches,
  stickerMime,
  type PackListing,
} from './sticker-pack-zip'

type Rpc = {
  getStickerPacks(accountId: number): Promise<
    { id: number; name: string; stickers: { id: number; path: string }[] }[]
  >
  createStickerPack(accountId: number, name: string): Promise<number>
  addStickerFromFile(accountId: number, packId: number, path: string, name: string): Promise<number>
}

type Fs = {
  read(path: string): Promise<Uint8Array>
  /** writes to a fresh temp path and returns it */
  stage(name: string, data: Uint8Array): Promise<string>
  unstage(path: string): Promise<void>
  save(data: Uint8Array, name: string): Promise<unknown>
}

export type PackPreview = {
  name: string
  count: number
  /** object URLs of up to 4 stickers; '' for an animated .tgs (not previewed) */
  previews: string[]
}

const PREVIEWS = 4
/** decompress this many stickers at a time, yielding to the UI in between */
const IMPORT_BATCH = 8

const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0))

/** Zip entries are read once: the file list, without decompressing. */
function listPack(data: Uint8Array, zipName: string): PackListing | null {
  const files: { name: string; originalSize: number }[] = []
  try {
    unzipSync(data, {
      filter: f => {
        files.push({ name: f.name, originalSize: f.originalSize })
        return false
      },
    })
  } catch {
    return null // not a zip after all
  }
  return parsePackListing(files, zipName)
}

function unzipSome(data: Uint8Array, names: string[]): Record<string, Uint8Array> {
  const wanted = new Set(names)
  return unzipSync(data, { filter: f => wanted.has(f.name) })
}

export function initStickerPacks(rpc: () => Rpc, fs: Fs): void {
  // ponytail: per-tab caches, never evicted; one entry per zip shown, a few
  // KiB of previews each. Evict if people keep tabs open for months.
  const cache = new Map<string, Promise<PackPreview | null>>()
  // One zip at a time, so a chat full of zips can't stall the UI.
  let queue: Promise<unknown> = Promise.resolve()

  const inspect = (path: string, zipName: string, size: number) => {
    if (size > MAX_PACK_ZIP_BYTES || !/\.zip$/i.test(zipName)) {
      return Promise.resolve(null)
    }
    let result = cache.get(path)
    if (!result) {
      result = queue.then(async () => {
        await new Promise(resolve =>
          'requestIdleCallback' in window
            ? requestIdleCallback(resolve, { timeout: 2000 })
            : setTimeout(resolve, 50)
        )
        const data = await fs.read(path)
        const pack = listPack(data, zipName)
        if (!pack) return null
        // static stickers make better previews than placeholder tiles
        const order = [...pack.entries].sort(
          (a, b) => Number(/\.tgs$/i.test(a)) - Number(/\.tgs$/i.test(b))
        )
        const picked = order.slice(0, PREVIEWS)
        const files = unzipSome(data, picked.filter(n => !/\.tgs$/i.test(n)))
        for (const name of Object.keys(files)) {
          // the extension decides the renderer, so it must not lie
          if (!stickerMagicMatches(name, files[name])) return null
        }
        return {
          name: pack.name,
          count: pack.entries.length,
          previews: picked.map(n =>
            files[n]
              ? URL.createObjectURL(new Blob([files[n] as BlobPart], { type: stickerMime(n) }))
              : ''
          ),
        }
      }).catch(() => null)
      queue = result
      cache.set(path, result)
    }
    return result
  }

  /** Imports the pack in the zip at `path`; resolves to the new pack's id. */
  const importZip = async (accountId: number, path: string, zipName: string) => {
    const data = await fs.read(path)
    const pack = listPack(data, zipName)
    if (!pack) throw new Error('not a sticker pack')
    const packId = await rpc().createStickerPack(accountId, pack.name)
    let added = 0
    for (let i = 0; i < pack.entries.length; i += IMPORT_BATCH) {
      const files = unzipSome(data, pack.entries.slice(i, i + IMPORT_BATCH))
      for (const [name, bytes] of Object.entries(files)) {
        const base = name.slice(name.lastIndexOf('/') + 1)
        const tmp = await fs.stage(base, bytes)
        try {
          // the core checks type and content again; a bad file is skipped
          await rpc().addStickerFromFile(accountId, packId, tmp, base)
          added++
        } catch {
          /* skipped */
        } finally {
          await fs.unstage(tmp)
        }
      }
      await yieldToUi()
    }
    return { packId, name: pack.name, added, skipped: pack.entries.length - added }
  }

  /** Saves a pack as `<name>.zip`, StickersBot's layout, so it re-imports anywhere. */
  const exportPack = async (accountId: number, packId: number) => {
    const pack = (await rpc().getStickerPacks(accountId)).find(p => p.id === packId)
    if (!pack) throw new Error('no such sticker pack')
    const folder = pack.name.replace(/[/\\]/g, '_')
    const files: Record<string, Uint8Array> = {}
    for (const [i, s] of pack.stickers.entries()) {
      files[`${folder}/${i + 1}${s.path.slice(s.path.lastIndexOf('.'))}`] = await fs.read(s.path)
    }
    // stickers are already compressed images; storing them is as small and faster
    await fs.save(zipSync(files, { level: 0 }), `${folder}.zip`)
  }

  ;(window as any).__slothfulStickers = { inspect, importZip, exportPack }
}
