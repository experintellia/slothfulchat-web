// Glue between a controlled <textarea> and the generic CompletionMenu: detects
// the active token under the caret, queries the provider, drives keyboard nav,
// and inserts the chosen value (replacing the whole :token fragment).
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { findActiveToken } from './findActiveToken.js'

const CLOSED = { open: false, items: [], active: 0, token: null }

export function useCompletion({ textareaRef, value, setValue, provider }) {
  const [state, setState] = useState(CLOSED)
  const caretToApply = useRef(null)

  // After we rewrite the value on select, restore the caret to just past the emoji.
  useLayoutEffect(() => {
    if (caretToApply.current == null) return
    const ta = textareaRef.current
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caretToApply.current }
    caretToApply.current = null
  })

  // ponytail: queries emoji-mart on every keystroke (no debounce). Ceiling: a
  // long fast-typed term fires N searches; dataset is in-memory so it's cheap.
  // Upgrade path: wrap provider.query in a ~60ms debounce keyed on term.
  const refresh = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const token = findActiveToken(value, ta.selectionStart, provider)
    if (!token) return setState(CLOSED)
    Promise.resolve(provider.query(token.term)).then(items => {
      // guard against a stale async result after the caret moved off the token
      const still = findActiveToken(ta.value, ta.selectionStart, provider)
      if (!still || still.start !== token.start) return
      setState(s => {
        // a pure caret move within the same term keeps the highlight; a changed
        // term (typing) resets to the top.
        const sameTerm = s.token && s.token.start === still.start && s.token.term === still.term
        const active = sameTerm ? Math.min(s.active, items.length - 1) : 0
        return { open: items.length > 0, items, active: Math.max(active, 0), token: still }
      })
    })
  }, [value, provider, textareaRef])

  const select = useCallback(item => {
    const t = state.token
    if (!t) return
    const next = value.slice(0, t.start) + item.native + value.slice(t.end)
    caretToApply.current = t.start + item.native.length
    setValue(next)
    setState(CLOSED)
  }, [state.token, value, setValue])

  const onKeyDown = useCallback(e => {
    if (!state.open) return // menu closed → composer's Enter=send / ArrowUp=edit-last run as usual
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setState(s => ({ ...s, active: (s.active + 1) % s.items.length })); break
      case 'ArrowUp':   e.preventDefault(); setState(s => ({ ...s, active: (s.active - 1 + s.items.length) % s.items.length })); break
      case 'Enter':     e.preventDefault(); select(state.items[state.active]); break
      case 'Escape':    e.preventDefault(); setState(CLOSED); break
    }
  }, [state, select])

  return {
    open: state.open,
    menuProps: {
      items: state.items,
      active: state.active,
      onSelect: select,
      onHover: i => setState(s => ({ ...s, active: i })),
    },
    // wire these onto the textarea; refresh after value or caret changes
    onKeyDown,
    onValueChange: refresh, // call once the new value has been committed
    onCaretMove: refresh,
  }
}
