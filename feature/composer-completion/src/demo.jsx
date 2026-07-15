import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CompletionMenu } from './CompletionMenu.jsx'
import { useCompletion } from './useCompletion.js'
import { emojiProvider } from './emojiProvider.js'

function Composer() {
  const taRef = useRef(null)
  const [value, setValue] = useState('Look at this :sm')

  const c = useCompletion({ textareaRef: taRef, value, setValue, provider: emojiProvider })

  // recompute the token after the committed value changes (typing / insertion)
  useEffect(() => { c.onValueChange() }, [value]) // eslint-disable-line

  return (
    <div className="app">
      <div className="header">
        <div className="avatar">A</div>
        <div><div className="htitle">Alena</div><div className="hsub">chatmail · online</div></div>
      </div>
      <div className="messages">
        <div className="row in"><div className="bubble">did the emoji thing land yet?<div className="time">14:02</div></div></div>
        <div className="row out"><div className="bubble">almost — testing the picker now 😄<div className="time">14:03</div></div></div>
        <div className="row in"><div className="bubble">nice, send me a screenshot<div className="time">14:03</div></div></div>
      </div>

      <div className="composer-wrap">
        {c.open && <CompletionMenu heading={'Emoji · matching “' + value.slice(value.lastIndexOf(':') + 1) + '”'} {...c.menuProps} />}
        <div className="composer">
          <div className="cbtn">😊</div>
          <div className="cbtn">＋</div>
          <textarea
            ref={taRef}
            className="ta"
            rows={1}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={c.onKeyDown}
            onKeyUp={c.onCaretMove}
            onClick={c.onCaretMove}
          />
          <div className="cbtn send">➤</div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Composer />)
