/**
 * Which caches the blobs service worker owns, and which same-origin GETs it may
 * cache. Plain .mjs beside the TS so it can be unit-tested without a build,
 * same as blob-route.mjs.
 *
 * Both halves exist because the browser's namespaces are wider than this app:
 *
 *  - `caches.keys()` is per ORIGIN, not per service-worker scope. Deleting
 *    every cache but the current one on activate wipes whatever else lives on
 *    the origin — a co-hosted app, or a second deploy of this one under
 *    another base path (user.github.io/a/ and /b/ are one origin).
 *  - the fetch handler sees every request its clients make, including
 *    same-origin URLs that are not ours at all (a self-hoster's endpoint next
 *    to dist/, the /help/ tree openHelpWindow fetches from the origin root).
 *    Caching those — query-insensitively, at that — is how one dynamic
 *    response ends up answering a different request.
 */

const CACHE_PREFIX = 'slothful-shell-'

/** Cache name for this SW scope and precache version. The scope is part of the
 * name so two deploys on one origin own distinct caches. `scopePath` always
 * ends in '/', so it needs no separator of its own. */
export const cacheName = (scopePath, version) => CACHE_PREFIX + scopePath + version

/** Caches this app is allowed to delete: its own, at this scope — plus the
 * unscoped names it used before the scope was part of the name. Those carry no
 * '/' and are dropped once, on the first activate after the rename; without
 * that a user's pre-rename shell would sit in storage forever. */
export const isOwnCache = (name, scopePath) =>
  name.startsWith(CACHE_PREFIX + scopePath) || (name.startsWith(CACHE_PREFIX) && !name.includes('/'))

/**
 * What the app shell handler may do with a same-origin GET:
 *   'precache' — a manifest file: served cache-only, matched with ignoreSearch
 *   'runtime'  — an enumerated static route: cached on fetch, exact-URL match
 *   'shell'    — an in-scope navigation: network, offline fallback to the shell
 *   null       — not ours: leave it to the network and cache nothing
 */
export function shellRole(pathname, scopePath, manifest, isNavigate) {
  if (!pathname.startsWith(scopePath)) return null
  const file = pathname.slice(scopePath.length)
  // manifest keys are scope-relative paths (base-path agnostic, like the blob routes)
  if (Object.prototype.hasOwnProperty.call(manifest, file)) return 'precache'
  // the one asset family deliberately kept out of the precache to be fetched on
  // demand instead — opt-in emoji fonts (instance-config.mjs precacheSkip)
  if (file.startsWith('fonts/emoji-sets/')) return 'runtime'
  return isNavigate ? 'shell' : null
}
