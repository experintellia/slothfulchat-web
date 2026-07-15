/**
 * Pure serialization/merge helpers for the in-app translation editor
 * (translation-editor.ts holds the UI; docs/translation-editor-design.md the
 * design). Plain .mjs with JSDoc types — no browser globals — so CI's lint job
 * unit-tests it with node:test and translation-editor.ts imports it back, the
 * same split events.mjs / analytics.ts already use.
 *
 * A locale "entry" is Android-shaped: { message } for a simple string, or CLDR
 * plural forms ({ one, other, ... }). The editor's overlay stores the full
 * edited entry per key, so exports are complete and plural forms are never
 * dropped.
 *
 * @typedef {Record<string, string>} Entry
 */

/**
 * Merge one locale's overlay onto its messages (per-key replace). Lossless: an
 * overlay entry carries all of a key's forms, so plural keys keep every form.
 * Does not mutate its inputs.
 * @param {Record<string, Entry>|undefined} overlayForLocale
 * @param {Record<string, Entry>} messages
 * @returns {Record<string, Entry>}
 */
export function mergeOverlay(overlayForLocale, messages) {
  if (!overlayForLocale) return messages
  const out = { ...messages }
  for (const key of Object.keys(overlayForLocale)) {
    out[key] = { ...out[key], ...overlayForLocale[key] }
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
 * @param {string} s
 * @returns {string}
 */
export function escapeAndroid(s) {
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
 * Serialize a set of entries as a *partial* Android string-resources XML — only
 * the given keys, for a merge-by-key upload to Weblate/Transifex. Never use
 * Weblate's "Replace existing translation file" mode with a partial file: that
 * deletes the keys not present. Keys are sorted for a stable, reviewable diff.
 * @param {Record<string, Entry>} entries  key -> entry
 * @returns {string}
 */
export function toAndroidXml(entries) {
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
