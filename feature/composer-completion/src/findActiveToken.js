// Generic completion-token detector for a plain <textarea>. Framework-free and
// pure so it carries the one runnable check (see findActiveToken.test.mjs).
//
// Scans left from the caret for `trigger`, stopping at any whitespace. Enforces
// a word boundary before the trigger (start-of-input or whitespace) so it never
// fires inside `http://host` or `12:30`. Returns the token range or null.

/**
 * @param {string} text   full textarea value
 * @param {number} caret  selectionStart (caret offset)
 * @param {{trigger:string, minChars:number, boundaryBefore?:boolean}} opts
 * @returns {{trigger:string, term:string, start:number, end:number} | null}
 */
export function findActiveToken(text, caret, opts) {
  const { trigger, minChars, boundaryBefore = true } = opts
  let i = caret - 1
  for (; i >= 0; i--) {
    const ch = text[i]
    if (ch === trigger) break
    if (ch === ' ' || ch === '\n' || ch === '\t') return null // whitespace before a trigger → no token
  }
  if (i < 0 || text[i] !== trigger) return null // no trigger between caret and the last whitespace

  if (boundaryBefore && i > 0) {
    const prev = text[i - 1]
    if (prev !== ' ' && prev !== '\n' && prev !== '\t') return null // e.g. the `:` in http:// or 12:30
  }

  const term = text.slice(i + 1, caret)
  if (term.length < minChars) return null // lone `:` or `:s` stays quiet until 2 chars
  return { trigger, term, start: i, end: caret }
}
