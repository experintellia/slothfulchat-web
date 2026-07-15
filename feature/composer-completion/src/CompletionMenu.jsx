// Generic, presentational completion menu. Knows nothing about emoji — it
// renders items ({id,label,native/preview}), highlights the active row, keeps
// it scrolled into view, and reports clicks/hovers. Keyboard + data live in the
// useCompletion hook so a future @mention menu reuses this untouched.
import React, { useEffect, useRef } from 'react'

export function CompletionMenu({ heading, items, active, onSelect, onHover }) {
  const listRef = useRef(null)

  useEffect(() => {
    const row = listRef.current?.children[active]
    row?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!items.length) return null

  return (
    <div className="cmenu" role="listbox" aria-label={heading}>
      <div className="cmenu-head">{heading}</div>
      <div className="cmenu-list" ref={listRef}>
        {items.map((it, i) => (
          <div
            key={it.id}
            role="option"
            aria-selected={i === active}
            className={'cmenu-item' + (i === active ? ' active' : '')}
            onMouseEnter={() => onHover(i)}
            onMouseDown={e => { e.preventDefault(); onSelect(it) }} // mousedown keeps textarea focus
          >
            <span className="cmenu-em">{it.native}</span>
            <span className="cmenu-code">{it.label}</span>
          </div>
        ))}
      </div>
      <div className="cmenu-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> select</span>
        <span><kbd>Esc</kbd> dismiss</span>
      </div>
    </div>
  )
}
