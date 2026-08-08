// Self-check for the 🦥 fork markers injected into build/core's JSON-RPC
// sources. The mapping from "a patch touched this line" to "this is the API
// item it belongs to" is the only real logic in mark-fork-api.mjs, and getting
// it wrong is quiet: a marker in the wrong place misleads, a missing one is
// invisible, and a marker on a wrapped type expression would not even compile.
//   node --test scripts/mark-fork-api.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markSource } from './mark-fork-api.mjs'

// 1-based line numbers, as git blame reports them, are noted per line.
const SRC = `use serde::Serialize;

#[derive(Serialize, TypeDef)]
pub enum EventType {
    /// Upstream event.
    Info {
        msg: String,
    },

    /// Progress of a message download.
    DownloadProgress {
        /// Message ID.
        msg_id: u32,
    },
}

/// An upstream struct.
#[derive(Serialize, TypeDef)]
pub struct MessageData {
    pub text: Option<String>,
    /// Media duration.
    pub duration: Option<i32>,
}

impl From<CoreEvent> for EventType {
    fn from(e: CoreEvent) -> Self {
        EventType::DownloadProgress { msg_id: 1 }
    }
}

#[rpc(all_positional, ts_outdir = "typescript/generated")]
impl CommandApi {
    /// Upstream method.
    async fn untouched(&self) -> Result<()> {
        Ok(())
    }

    /// Get the file size.
    async fn get_account_file_size(&self) -> Result<u64> {
        Ok(patched_size())
    }
}
`
const VARIANT = [10, 11, 12, 13, 14] // the whole DownloadProgress variant
const FIELD = [21, 22] // `/// Media duration.` + `pub duration`
const fork = (lines, patch) => new Map(lines.map((n) => [n, patch]))
/** The marker line that immediately precedes `decl`, if any. */
const markOn = (source, decl) =>
  source.split('\n').find((l, i, all) => l.includes('🦥') && all[i + 1].includes(decl))

test('a new enum variant is marked added; the upstream enum around it, changed', () => {
  const { source } = markSource(SRC, fork(VARIANT, 'core/0020'))
  assert.equal(
    markOn(source, 'DownloadProgress {')?.trim(),
    '/// 🦥 slothfulchat-web fork: added by core/0020.',
  )
  assert.match(
    source,
    /changed by core\/0020\.\n#\[derive\(Serialize, TypeDef\)\]\npub enum EventType/,
  )
  // The variant's own fields are inside it, so they are added too.
  assert.equal(
    markOn(source, 'msg_id: u32')?.trim(),
    '/// 🦥 slothfulchat-web fork: added by core/0020.',
  )
  // Untouched siblings stay clean.
  assert.equal(markOn(source, 'Info {'), undefined)
  assert.equal(markOn(source, 'msg: String'), undefined)
})

test('a new field on an upstream type is added, the type itself changed', () => {
  const { source } = markSource(SRC, fork(FIELD, 'core/0028'))
  assert.equal(
    markOn(source, 'pub duration: Option<i32>')?.trim(),
    '/// 🦥 slothfulchat-web fork: added by core/0028.',
  )
  // The marker goes after the existing docs, so it reads as a footnote rather
  // than replacing the type's summary line in generated index pages.
  assert.match(
    source,
    /\/\/\/ An upstream struct\.\n\/\/\/\n\/\/\/ 🦥 slothfulchat-web fork: changed by core\/0028\.\n#\[derive/,
  )
  assert.equal(markOn(source, 'pub text: Option<String>'), undefined)
})

test('a patched rpc method body marks that method and nothing else', () => {
  const { source, marked } = markSource(SRC, fork([40], 'core/0019'))
  assert.equal(marked, 1)
  assert.equal(
    markOn(source, 'async fn get_account_file_size')?.trim(),
    '/// 🦥 slothfulchat-web fork: changed by core/0019.',
  )
})

test('several patches on one item are all named', () => {
  const { source } = markSource(SRC, new Map([[21, 'core/0028'], [22, 'core/0024']]))
  assert.equal(
    markOn(source, 'pub duration: Option<i32>')?.trim(),
    '/// 🦥 slothfulchat-web fork: added by core/0024, core/0028.',
  )
})

test('changes outside the documented API surface are left alone', () => {
  // Line 27 is inside `impl From<CoreEvent> for EventType`: real fork code,
  // but it produces no client method, type, field or variant.
  const { source, marked } = markSource(SRC, fork([27], 'core/0020'))
  assert.equal(marked, 0)
  assert.equal(source, SRC)
})

test('marking is idempotent', () => {
  const once = markSource(SRC, fork(FIELD, 'core/0028')).source
  // Re-running shifts every line number, but the marker guard has to stop a
  // second copy landing on an item that already carries one.
  const twice = markSource(once, fork(FIELD.map((n) => n + 2), 'core/0028')).source
  assert.equal(twice, once)
})
