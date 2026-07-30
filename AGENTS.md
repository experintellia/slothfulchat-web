# Changelog entries are for humans

A changelog line is read by a person deciding whether a release affects them — keep it on point: what changed and why it matters, in a sentence or two. The exhaustive version (mechanism, root cause, every edge case) belongs in the commit message, where it already lives. Don't paste the commit body into the changelog.

# Labels: apply them to every issue and PR

Label every issue and PR you open (and anything unlabeled you touch). Two axes, pick at most one from each:

**What it is:**

- `feature` — new end-user capability.
- `enhancement` — improve an existing feature.
- `bug` — something isn't working.
- `performance` — make an existing path faster or cheaper.
- `robustness` — reliability / hardening to prevent failure modes (not user-facing).
- `idea` — issues only: a proposal not yet committed to.
- `discussion` — issues only: needs a decision before work starts.

**Where the code comes from** (for features/enhancements):

- `original` — our own analysis / design; no external code to copy.
- `port` — ported from live code in another fork (e.g. ArcaneChat).
- `revived` — revives an abandoned upstream PR (closed unmerged); may upstream later.
- `official` — official Delta Chat feature that needs extra attention for the web version.

Chores (releases, CI, docs, patch-stack maintenance) stay unlabeled.

# Ponytail, lazy senior dev mode

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark intentional simplifications with a `ponytail:` comment. If the shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), the comment names the ceiling and the upgrade path.

Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

# Building core-wasm (packages/core-wasm)

Cold-start gotchas, in order. Each one cost real time to rediscover:

1. **Submodule + patches first.** `build/core` is throwaway and not checked in.
   `git submodule update --init vendor/core && scripts/apply-patches.sh`.
   (apply-patches also tries the `desktop` worktree — it needs
   `vendor/deltachat-desktop` inited too; `build:wasm` doesn't, so a desktop
   failure there is fine.)
2. **Toolchain = nightly** (auto-selected via `rust/rust-toolchain.toml`; pinned
   `rusqlite` uses the nightly-only `cfg_select!` macro, so stable fails E0658).
   Just ensure it's installed: `rustup toolchain install nightly`.
3. **Install wasm-pack + wasm-bindgen-cli from crates.io, version-matched.**
   Neither ships in the image. GitHub binary downloads are proxy-blocked, so
   `cargo install wasm-pack` and `cargo install wasm-bindgen-cli --version <X>`
   where `<X>` is the `wasm-bindgen` version in `rust/Cargo.lock` (a mismatch
   makes wasm-pack try to download the matching one from GitHub → fails).
4. **Use `build:wasm:ci`, not `build:wasm`.** The `:ci` variant passes
   `--no-opt`, skipping `wasm-opt`, which also downloads from GitHub.
