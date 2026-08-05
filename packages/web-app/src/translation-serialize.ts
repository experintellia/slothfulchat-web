/**
 * Pure serialization/merge helpers for the in-app translation editor
 * (translation-editor.ts holds the UI; docs/design/translation-editor-design.md the
 * design). No browser globals, so CI's lint job unit-tests it with node:test
 * and translation-editor.ts imports it back — the same split events.ts /
 * analytics.ts already use.
 *
 * A locale "entry" is Android-shaped: { message } for a simple string, or CLDR
 * plural forms ({ one, other, ... }). The editor's overlay stores the full
 * edited entry per key, so exports are complete and plural forms are never
 * dropped.
 */
export type Entry = Record<string, string>

/**
 * Merge one locale's overlay onto its messages (per-key replace). Lossless: an
 * overlay entry carries all of a key's forms, so plural keys keep every form.
 * Does not mutate its inputs.
 */
export function mergeOverlay(
  overlayForLocale: Record<string, Entry> | undefined,
  messages: Record<string, Entry>
): Record<string, Entry> {
  if (!overlayForLocale) return messages
  const out = { ...messages }
  for (const key of Object.keys(overlayForLocale)) {
    const entry = overlayForLocale[key]
    // Skip anything that isn't an entry object: a corrupted or old-format
    // localStorage value (e.g. a bare string) would otherwise spread into
    // indexed characters and garble that key's message app-wide.
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
      out[key] = { ...out[key], ...entry }
  }
  return out
}

/**
 * Escape a translation value for an Android string resource, mirroring the
 * reverse of the build's xml->json converter (bin/build-shared-convert-
 * translations.mjs `removeJunk`, which turns \n into a newline, \' into ', \"
 * into " and strips lone backslashes). Emitting those escapes keeps a
 * round-trip through Weblate/Transifex and the build converter faithful.
 * ponytail: covers the escapes the converter round-trips; an exotic sequence it
 * doesn't handle would need manual review before upload.
 */
export function escapeAndroid(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
}

/**
 * Resolve which translation key(s) produced any of `strings`, from the live tx
 * registry (rendered result text -> set of keys that produced it; populated by
 * the inspector's wrap of window.static_translate). One row per candidate
 * string that had a hit, longest text first (the most specific match), deduped.
 * ponytail: identical text from different keys (e.g. "OK") yields multiple keys
 * — the inspector shows them all rather than guessing; the fiber's component
 * name is the tiebreaker a human uses. Upgrade path: the zero-width exact mode
 * in the design doc, if this ambiguity ever bites.
 */
export function matchKeys(
  registry: Map<string, Set<string>>,
  strings: readonly string[]
): { text: string; keys: string[] }[] {
  const out: { text: string; keys: string[] }[] = []
  const seen = new Set<string>()
  for (const s of strings) {
    const text = (s || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    const keys = registry.get(text)
    if (keys && keys.size) out.push({ text, keys: [...keys].sort() })
  }
  return out.sort((a, b) => b.text.length - a.text.length)
}

/**
 * Serialize a set of entries as a *partial* Android string-resources XML — only
 * the given keys, for a merge-by-key upload to Weblate/Transifex. Never use
 * Weblate's "Replace existing translation file" mode with a partial file: that
 * deletes the keys not present. Keys are sorted for a stable, reviewable diff.
 *
 * @param entries key -> entry
 */
export function toAndroidXml(entries: Record<string, Entry>): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>']
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key]
    if (typeof entry.message === 'string') {
      lines.push(`    <string name="${key}">${escapeAndroid(entry.message)}</string>`)
    } else {
      lines.push(`    <plurals name="${key}">`)
      for (const quantity of Object.keys(entry)) {
        lines.push(
          `        <item quantity="${quantity}">${escapeAndroid(entry[quantity])}</item>`
        )
      }
      lines.push('    </plurals>')
    }
  }
  lines.push('</resources>', '')
  return lines.join('\n')
}
