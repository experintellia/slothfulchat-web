// Emoji completion provider — the first consumer of the generic menu.
// Reuses the already-bundled @emoji-mart/data dataset via emoji-mart's
// SearchIndex; no new dependency, no hand-rolled ranking.
import data from '@emoji-mart/data'
import { init, SearchIndex } from 'emoji-mart'

const ready = init({ data })

/** A provider is { trigger, minChars, boundaryBefore, query(term) -> items }. */
export const emojiProvider = {
  trigger: ':',
  minChars: 2,
  boundaryBefore: true,
  async query(term, max = 30) {
    await ready
    const hits = (await SearchIndex.search(term)) || []
    return hits.slice(0, max).map(e => ({
      id: e.id,
      label: `:${e.id}:`,
      native: e.skins?.[0]?.native ?? '',
    }))
  },
}
