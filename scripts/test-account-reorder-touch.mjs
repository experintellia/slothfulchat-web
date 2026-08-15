// Self-check for reordering profiles with a finger and the long-press context-menu
// fallback (both desktop/0077) — runs FULLY OFFLINE.
//
// The gesture has to share one press with two others: an early move scrolls the profile
// list, a still press opens the context menu, and only "hold, then move" reorders. That
// three-way split is the risky part, so this bundles the real hook AND the real
// long-press fallback, mounts a stand-in sidebar in a real chromium with touch, and
// dispatches real touch sequences at it. A pick-up delay that never arms, a drop that
// computes the wrong index, an early move that reorders anyway, or a menu that leaves
// the profile picked up all fail here.
//
// Headless chromium never runs its own long-press gesture for CDP-dispatched touches
// (no native contextmenu, verified experimentally) — which makes it a faithful stand-in
// for iOS, where Safari fires no contextmenu for touch presses at all. The resting
// press in case 3 therefore exercises the long-press fallback end to end.
//
// Needs only playwright + esbuild (no core-wasm, no web-app build).
// Run:  node scripts/test-account-reorder-touch.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'

const repo = new URL('..', import.meta.url)
const frontendSrc = fileURLToPath(
  new URL('build/desktop/packages/frontend/src/', repo)
)

// esbuild lives in the web-app package, not at the workspace root.
const require = createRequire(fileURLToPath(new URL('packages/web-app/', repo)))
const esbuild = await import(require.resolve('esbuild'))

// The hook's two app imports would drag in the whole app (and a real core
// connection). The stub records what the hook would have written instead.
const stubApp = {
  name: 'stub-app',
  setup(build) {
    build.onResolve({ filter: /backend-com$/ }, () => ({
      path: 'backend-com',
      namespace: 'stub',
    }))
    build.onResolve({ filter: /hooks\/useFetch$/ }, () => ({
      path: 'useFetch',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /^backend-com$/, namespace: 'stub' }, () => ({
      contents: `
        export const BackendRemote = {
          rpc: {
            setAccountsOrder: order => {
              window.__ordersWritten.push(order)
              return Promise.resolve()
            },
          },
        }
      `,
    }))
    build.onLoad({ filter: /^useFetch$/, namespace: 'stub' }, () => ({
      // Only imported for its type, never called.
      contents: 'export const useRpcFetch = () => undefined',
    }))
  },
}

const harness = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { useAccountDragAndDrop } from './hooks/useAccountDragAndDrop'
  import { installLongPressContextMenu } from './utils/longPressContextMenu'

  const ACCOUNTS = [1, 2, 3, 4]

  function Sidebar() {
    const [accounts] = useState(ACCOUNTS)
    const accountsFetch = {
      lingeringResult: { ok: true, value: accounts },
      refresh: () => {},
    }
    const { draggedAccountId, dropIndicator, handleTouchStart } =
      useAccountDragAndDrop(accountsFetch)

    window.__pickedUp = draggedAccountId
    window.__dropIndicator = dropIndicator

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'p',
        {
          id: 'selectable',
          // Like a message body: explicitly selectable text with a context
          // menu on it. The long-press fallback must stay out of its way.
          style: { userSelect: 'text', margin: 0, width: '200px' },
          onContextMenu: e => {
            e.preventDefault()
            window.__menusOpened.push('selectable')
          },
        },
        'selectable message text'
      ),
      React.createElement(
        'ul',
      { style: { margin: 0, padding: 0, listStyle: 'none' } },
      accounts.map(id =>
        React.createElement(
          'li',
          { key: id, onTouchStart: e => handleTouchStart(e, id) },
          React.createElement(
            'button',
            {
              'x-account-sidebar-account-id': id,
              style: { display: 'block', width: '64px', height: '64px' },
              // Mimics makeContextMenu: record that the menu opened, suppress
              // any native menu.
              onContextMenu: e => {
                e.preventDefault()
                window.__menusOpened.push(id)
              },
            },
            String(id)
          )
        )
      )
    )
    )
  }

  window.__ordersWritten = []
  window.__menusOpened = []
  installLongPressContextMenu()
  createRoot(document.getElementById('root')).render(
    React.createElement(Sidebar)
  )
`

const { outputFiles } = await esbuild.build({
  stdin: {
    contents: harness,
    resolveDir: frontendSrc,
    sourcefile: 'reorder-harness.tsx',
    loader: 'tsx',
  },
  bundle: true,
  format: 'iife',
  plugins: [stubApp],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
})
const bundle = outputFiles[0].text

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_BIN || undefined,
})
try {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  await page.setContent(
    '<!doctype html><meta charset=utf-8><title>reorder</title><div id=root></div>'
  )
  await page.addScriptTag({ content: bundle })
  await page.waitForSelector('[x-account-sidebar-account-id="1"]')

  const cdp = await context.newCDPSession(page)
  const centerOf = async accountId => {
    const box = await page
      .locator(`[x-account-sidebar-account-id="${accountId}"]`)
      .boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const touch = async (type, point) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ ...point, id: 1 }] : [],
    })

  const state = () =>
    page.evaluate(() => ({
      orders: window.__ordersWritten,
      menus: window.__menusOpened,
      pickedUp: window.__pickedUp,
      indicator: window.__dropIndicator,
    }))
  const reset = () =>
    page.evaluate(() => {
      window.__ordersWritten = []
      window.__menusOpened = []
    })

  // 1. Hold, then move onto the lower half of profile 3, then let go.
  //    Reorders, and the profile lands *below* the one it was dropped on.
  const start = await centerOf(1)
  const target = await centerOf(3)
  await touch('touchStart', start)
  await page.waitForTimeout(400) // > ARM_DELAY_MS
  assert.equal((await state()).pickedUp, 1, 'holding picks the profile up')
  await touch('touchMove', { x: target.x, y: target.y + 20 })
  const dragging = await state()
  assert.deepEqual(
    dragging.indicator,
    { index: 2, position: 'bottom' },
    'the drop line follows the finger'
  )
  await touch('touchEnd')
  assert.deepEqual(
    (await state()).orders,
    [[2, 3, 1, 4]],
    'dropping below profile 3 writes the new order'
  )
  assert.equal(
    (await state()).pickedUp,
    null,
    'the profile is put down again after the drop'
  )

  // 2. Moving right away is a scroll, not a reorder.
  await reset()
  await touch('touchStart', start)
  await page.waitForTimeout(50) // < ARM_DELAY_MS
  await touch('touchMove', { x: start.x, y: target.y + 20 })
  await touch('touchEnd')
  assert.deepEqual(
    (await state()).orders,
    [],
    'a move before the pick-up delay leaves the order alone'
  )

  // 3. Resting through the long-press delay: the fallback opens the context
  //    menu (this browser fires no contextmenu of its own for these touches,
  //    like iOS), the menu puts the picked-up profile back down, and moving or
  //    letting go afterwards must not reorder anything.
  await reset()
  await touch('touchStart', start)
  await page.waitForTimeout(400)
  assert.equal((await state()).pickedUp, 1, 'picked up before the menu opens')
  assert.deepEqual((await state()).menus, [], 'no menu before the delay')
  await page.waitForTimeout(500) // past LONG_PRESS_MS (700) in total
  const rested = await state()
  assert.deepEqual(rested.menus, [1], 'resting opens the context menu')
  assert.equal(rested.pickedUp, null, 'the context menu takes the press back')
  await touch('touchMove', { x: target.x, y: target.y + 20 })
  await touch('touchEnd')
  assert.deepEqual(
    (await state()).orders,
    [],
    'a press that opened the menu never reorders'
  )

  // 4. A reorder is not a long press: dragging must never open the menu.
  await reset()
  await touch('touchStart', start)
  await page.waitForTimeout(400)
  await touch('touchMove', { x: target.x, y: target.y + 20 })
  await page.waitForTimeout(500) // past LONG_PRESS_MS since the press began
  await touch('touchEnd')
  const dragged = await state()
  assert.deepEqual(dragged.menus, [], 'dragging does not open the menu')
  assert.deepEqual(
    dragged.orders,
    [[2, 3, 1, 4]],
    'the drag still reorders normally'
  )

  // 5. Selectable text (a message body): the platform's long press means
  //    "select", so a rest there must never open the menu.
  await reset()
  const sel = await page.locator('#selectable').boundingBox()
  await touch('touchStart', {
    x: sel.x + sel.width / 2,
    y: sel.y + sel.height / 2,
  })
  await page.waitForTimeout(900) // past LONG_PRESS_MS
  await touch('touchEnd')
  assert.deepEqual(
    (await state()).menus,
    [],
    'no menu on explicitly selectable text'
  )

  console.log(
    '✓ touch: hold-then-move reorders, a rest opens the menu, a scroll does neither, selectable text stays selectable'
  )
} finally {
  await browser.close()
}
