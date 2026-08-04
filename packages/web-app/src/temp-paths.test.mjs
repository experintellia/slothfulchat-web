// Unit tests for the temp-file removal path — dependency-free (node:test), so
// they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/temp-paths.test.mjs
import { strictEqual } from 'node:assert'
import { test } from 'node:test'

import { tempRemovalPath } from './temp-paths.mjs'

test('a staged temp file collapses to its random parent dir (M-03)', () => {
  strictEqual(
    tempRemovalPath('/tmp/11900ee1-f762-43e5-8283-eedbabb791e8/backup.tar'),
    '/tmp/11900ee1-f762-43e5-8283-eedbabb791e8',
    'otherwise the empty uuid dir stays in OPFS forever'
  )
})

test('anything but the exact /tmp/<dir>/<file> shape is removed as given', () => {
  // deeper (or shallower) than tmpPath() produces: never guess a parent
  strictEqual(tempRemovalPath('/tmp/a/b/c.tar'), '/tmp/a/b/c.tar')
  strictEqual(tempRemovalPath('/tmp/loose.tar'), '/tmp/loose.tar')
  strictEqual(tempRemovalPath('/tmp'), '/tmp')
})

test('refuses paths that are not temp paths, or that could climb out', () => {
  strictEqual(tempRemovalPath('/accounts/1/dc.db'), null)
  strictEqual(tempRemovalPath('/tmp/../accounts/1/dc.db'), null)
  strictEqual(tempRemovalPath('/tmp/uuid/../../accounts'), null)
  strictEqual(tempRemovalPath(''), null)
  strictEqual(tempRemovalPath(undefined), null, 'a missing rpc param is not a path')
})
