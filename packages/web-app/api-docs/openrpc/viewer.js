// The OpenRPC reference at /api-docs/openrpc/.
//
// Rendering is @open-rpc/docs-react (Apache-2.0), the renderer the OpenRPC
// project maintains against its own spec — so keeping up with the spec's shapes
// is their job, not ours. It is a React/MUI component, so this file is bundled
// by assemble.mjs (esbuild, already a devDependency) into one self-contained
// viewer.js + viewer.css next to the page. Nothing comes from a CDN and nothing
// is loaded cross-origin: the page's only request is the same-origin, relative
// `../openrpc.json`, which is what keeps it inside `script-src 'self'` on
// GitHub Pages and self-hosted Caddy alike.
//
// Plain JS with createElement rather than JSX/TSX on purpose: no JSX pragma, no
// tsconfig entry, no typecheck wiring for a page this size.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { Documentation } from '@open-rpc/docs-react'
import { dereference } from './deref.mjs'
// The package's `exports` map only publishes ".", so its stylesheet cannot be
// reached as a subpath specifier; esbuild picks it up from this path and emits
// it as viewer.css, which index.html links.
import '../../node_modules/@open-rpc/docs-react/dist/docs-react.css'

const mount = document.getElementById('root')
// The rest of /api-docs/ is dark; MUI defaults to light and would flash white.
const theme = createTheme({ palette: { mode: 'dark' } })

fetch('../openrpc.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
  .then((doc) => {
    createRoot(mount).render(
      h(ThemeProvider, { theme }, h(CssBaseline), h(Documentation, { schema: dereference(doc) })),
    )
  })
  .catch((e) => {
    mount.textContent = 'Could not render ../openrpc.json: ' + e.message
  })
