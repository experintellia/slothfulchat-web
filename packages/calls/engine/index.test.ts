import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as engine from './index.ts';

// M0 scaffold smoke test: the engine/ barrel loads cleanly end to end — its
// own sibling modules resolve, Node's built-in type-stripping test runner
// (`node --test *.test.ts`, no build step) can execute it, and the
// package.json "test" script glob (`engine/*.test.ts`) picks it up. This is
// the package-skeleton half of test coverage; the interop specifics are
// exercised by signaling.test.ts and ice-gathering.test.ts. Deliberately
// decoupled from the exact export list so it keeps passing regardless of
// which engine exports come and go as milestones land.
test('engine/ barrel module loads and re-exports something', () => {
  assert.equal(typeof engine, 'object');
  assert.ok(Object.keys(engine).length > 0, 'engine barrel should re-export something');
});
