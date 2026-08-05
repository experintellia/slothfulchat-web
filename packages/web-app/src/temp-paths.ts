/**
 * Which memfs path to delete for a staged temp file.
 *
 * Write-side trust boundary: the path comes from the frontend, so keep the
 * upstream backendApi guard (must look like a temp path, no `..`) — the memfs
 * `normalize()` resolves `..` by popping a component, and this deletes trees.
 *
 * Every temp file gets its own random parent dir (runtime.ts `tmpPath()`:
 * `/tmp/<uuid>/<name>`), so removing only the file leaves an empty random
 * directory behind — and the memfs is mirrored into OPFS, so it stays there
 * across reloads. Collapse to that parent when the path has exactly that
 * shape; `fs_remove` deletes a subtree, so one call takes file and dir.
 */
export function tempRemovalPath(name: string | undefined): string | null {
  if (typeof name !== 'string' || !name.includes('tmp') || name.includes('..')) {
    return null
  }
  const staged = name.match(/^(\/tmp\/[^/]+)\/[^/]+$/)
  return staged ? staged[1] : name
}
