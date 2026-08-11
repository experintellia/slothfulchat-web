// Self-check for the 🦥 fork markers injected into build/core's JSON-RPC
// sources. The mapping from "a patch touched this line" to "this is the API
// item it belongs to" is the only real logic in mark-fork-api.mjs, and getting
// it wrong is quiet: a marker in the wrong place misleads, a missing one is
// invisible, and a marker on a wrapped type expression would not even compile.
//   node --test scripts/mark-fork-api.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blameFork, markSource } from './mark-fork-api.mjs'

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

#[rpc(
    all_positional,
    ts_outdir = "typescript/generated",
    openrpc_outdir = "typescript/generated"
)]
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

// The `#[rpc(...)]` attribute above `impl CommandApi` is MULTI-LINE in the real
// tree (patches/core sets openrpc_outdir next to ts_outdir, and rustfmt wraps
// it), and the fixture matches. It is spelled out because a single-line
// fixture is what let every method go unmarked without a test failing: the
// attribute scan walked back only over lines that themselves start with `#[`,
// so it never reached `#[rpc(`, the impl block was skipped whole, and only the
// type marks (which take a different path) kept working.
test('a patched rpc method body marks that method and nothing else', () => {
  const { source, marked, methods, types } = markSource(SRC, fork([44], 'core/0019'))
  assert.equal(marked, 1)
  assert.deepEqual(methods, ['get_account_file_size'])
  assert.deepEqual(types, [])
  assert.equal(
    markOn(source, 'async fn get_account_file_size')?.trim(),
    '/// 🦥 slothfulchat-web fork: changed by core/0019.',
  )
  assert.equal(markOn(source, 'async fn untouched'), undefined)
})

// The mark is only worth reading while it means "this behaves differently from
// upstream". This says what does NOT earn one.
test('a reworded doc comment on an upstream item earns no mark', () => {
  // Line 5 is `/// Upstream event.`, inside both the Info variant and the
  // EventType enum; line 9 is a blank line inside the enum.
  const { source, marked, methods, types } = markSource(SRC, fork([5, 9], 'core/0031'))
  assert.equal(marked, 0)
  assert.equal(source, SRC)
  // …and it must not reach the manifest either, or verify-fork-marks.mjs would
  // go looking for a mark that was deliberately not inserted.
  assert.deepEqual([...methods, ...types], [])
})

test('a line our patch only reindented stays upstream, so it earns no mark', () => {
  // The one rule that cannot be checked through markSource: `git blame -w` is
  // what keeps rustfmt reflow out of forkLines in the first place.
  const dir = mkdtempSync(path.join(tmpdir(), 'fork-blame-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  const commit = (text, msg) => {
    writeFileSync(path.join(dir, 'a.rs'), text)
    git('add', 'a.rs')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg)
  }
  git('init', '-q', '-b', 'main')
  commit('fn f() {\n    let n = 1;\n}\n', 'upstream')
  // What widening a `#[cfg]` block around existing code does: same statement,
  // one indent level deeper, plus one genuinely new line.
  commit('fn f() {\n        let n = 1;\n    let m = 2;\n}\n', 'ours')
  const forkLines = blameFork(dir, 'a.rs', new Map([[git('rev-parse', 'HEAD').trim(), 'core/0031']]))
  assert.equal(forkLines.get(2), undefined, 'a reindented line is still upstream’s')
  assert.equal(forkLines.get(3), 'core/0031')
  rmSync(dir, { recursive: true, force: true })
})

// A lifetime's apostrophe must not pair with the next one: `<'a>(&'a self`
// reads as one char literal spanning the brackets, `delta()` returns 0 instead
// of +1, the method's range collapses AND the impl block closes early — so
// every method below it silently drops out of the item set. verify-fork-marks
// cannot catch that: its manifest comes from this same scanner.
const LIFETIMES = `#[rpc(all_positional)]
impl CommandApi {
    /// Borrows.
    async fn borrowed<'a>(&'a self, name: &'a str) -> Result<()> {
        Ok(())
    }

    /// Comes after it.
    async fn later(&self) -> Result<u64> {
        Ok(patched())
    }
}
`
test('a method with explicit lifetimes does not swallow the methods below it', () => {
  // Line 10 is `Ok(patched())`, inside `later` — the method after the borrower.
  const { source, methods } = markSource(LIFETIMES, fork([10], 'core/0019'))
  assert.deepEqual(methods, ['later'])
  assert.equal(
    markOn(source, 'async fn later')?.trim(),
    '/// 🦥 slothfulchat-web fork: changed by core/0019.',
  )
})

test('changes outside the documented API surface are left alone', () => {
  // Line 27 is inside `impl From<CoreEvent> for EventType`: real fork code,
  // but it produces no client method, type, field or variant.
  const { source, marked } = markSource(SRC, fork([27], 'core/0020'))
  assert.equal(marked, 0)
  assert.equal(source, SRC)
})

test('marking is idempotent, and the second run still reports the same items', () => {
  const first = markSource(SRC, fork(FIELD, 'core/0028'))
  // Re-running shifts every line number, but the marker guard has to stop a
  // second copy landing on an item that already carries one. Re-find the two
  // lines rather than adding a fixed offset: the inserted markers are doc
  // lines, so a blind shift would land on one and read as a docs-only change.
  const at = (needle) => first.source.split('\n').findIndex((l) => l.includes(needle)) + 1
  const second = markSource(first.source, fork([at('Media duration.'), at('pub duration')], 'core/0028'))
  assert.equal(second.source, first.source)
  assert.equal(second.marked, 0)
  // …and it must still name them, or a re-run would tell verify-fork-marks
  // there is nothing to check.
  assert.deepEqual(second.types, first.types)
})
