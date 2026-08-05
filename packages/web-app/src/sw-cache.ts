/**
 * Which caches the blobs service worker owns, and which same-origin GETs it may
 * cache. Kept beside blobs-sw.ts, free of SW globals, so it can be unit-tested
 * without a browser — same as blob-route.ts.
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
export const cacheName = (scopePath: string, version: string): string =>
  CACHE_PREFIX + scopePath + version

/** Caches this app is allowed to delete: its own, at this scope — plus the
 * unscoped names it used before the scope was part of the name. Those carry no
 * '/' and are dropped once, on the first activate after the rename; without
 * that a user's pre-rename shell would sit in storage forever.
 * The remainder after the scope must be slash-free (the version is a hex hash
 * or 'dev'): otherwise a scope would also claim deploys NESTED under it —
 * scope '/' owns 'slothful-shell-/<version>', not 'slothful-shell-/beta/…'. */
export const isOwnCache = (name: string, scopePath: string): boolean =>
  (name.startsWith(CACHE_PREFIX + scopePath) &&
    !name.slice(CACHE_PREFIX.length + scopePath.length).includes('/')) ||
  (name.startsWith(CACHE_PREFIX) && !name.includes('/'))

/**
 * What the app shell handler may do with a same-origin GET:
 *   'precache' — a manifest file: served cache-only, matched with ignoreSearch
 *   'runtime'  — an enumerated static route: cached on fetch, exact-URL match
 *   'shell'    — an in-scope navigation: network, offline fallback to the shell
 *   null       — not ours: leave it to the network and cache nothing
 */
export function shellRole(
  pathname: string,
  scopePath: string,
  manifest: Record<string, string>,
  isNavigate: boolean
): 'precache' | 'runtime' | 'shell' | null {
  if (!pathname.startsWith(scopePath)) return null
  const file = pathname.slice(scopePath.length)
  // manifest keys are scope-relative paths (base-path agnostic, like the blob routes)
  if (Object.prototype.hasOwnProperty.call(manifest, file)) return 'precache'
  // the one asset family deliberately kept out of the precache to be fetched on
  // demand instead — opt-in emoji fonts (instance-config.mjs precacheSkip)
  if (file.startsWith('fonts/emoji-sets/')) return 'runtime'
  return isNavigate ? 'shell' : null
}
