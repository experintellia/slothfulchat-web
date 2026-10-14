# iOS: deliberate differences from upstream deltachat-ios

The iOS app is forked from upstream deltachat-ios at `86b750af`. We don't
rebase it any more; upstream changes are reviewed and ported or reimplemented
selectively (plan: #288). This file lists everything we decided to do
differently, so that a port never quietly:

- brings back something we removed or declined,
- undoes something we changed, or
- breaks something we added.

Core-level differences are not listed here. Core is still a patch stack, so
those are in [PATCHES.md](PATCHES.md), and an entry here may point there.

## Rules

- **Every deliberate difference gets an entry.** That covers adding a fork
  feature, changing upstream behaviour, removing something, or declining an
  upstream change. Write the entry in the same change that makes the
  difference.
- **Check upstream changes against every entry before porting them.** If an
  upstream change touches an entry's area, the entry's *porting rule* decides
  what we do with it (port, adapt or skip), not the upstream change.
- **Edit entries, never delete them.** To revise or reverse a decision, update
  its status, date and reason. A reversed entry stays, so the history of why
  we differ stays readable.

Each entry has these fields:

```
### D-NNN: <title>
- Kind: added | changed | removed | declined
- Status: done | decided (not implemented yet) | reversed
- Decided: <date>, <PR/issue>
- What / Why / Where (files or area in our code)
- Upstream: what upstream has or does (commit/PR if there is one)
- Porting rule: how to treat upstream changes that touch this
```

## Entries

### D-001: App identifiers are `chat.slothful`
- **Kind:** changed · **Status:** done · **Decided:** 2026-10-11, #286
- **What:** `chat.delta` → `chat.slothful` everywhere it identifies the app:
  - the bundle IDs of all targets (app, DcShare, DcNotificationService,
    DcWidget, Clip, DcTests, DcCore)
  - the app group and shared keychain group `group.chat.slothful.ios`
  - the deeplink scheme `chat.slothful.deeplink`
  - the Darwin notification names between the app and the notification
    service
  - the URL type names and the log subsystem
- **Why:** the fork installs next to Delta Chat instead of replacing it, and
  the two never share containers, deeplinks or cross-process notifications.
- **Where:** `PRODUCT_BUNDLE_IDENTIFIER` in both `project.pbxproj` files, all
  `*.entitlements`, `Info.plist`, `DcAccount.swift`, `DatabaseHelper.swift`,
  `UserDefaults+Extensions.swift`, `KeychainManager.swift`,
  `DarwinNotificationCenter.swift`, and the deeplink handling in
  `AppCoordinator`, `AppDelegate`, `WidgetProvider`, `ShareViewController` and
  `AppClipApp`.
- **Upstream:** `chat.delta` throughout.
- **Porting rule:** if ported code introduces a new `chat.delta*`
  identifier, rename it. Never port an identifier change back.
  `AppIdentifierTests` catches regressions of the bundle ID and the deeplink
  scheme.
- **Not changed yet:**
  - `DEVELOPMENT_TEAM` and `KeychainManager.teamId` are still upstream's
    Apple team; device builds need ours.
  - The associated domain (`applinks:i.delta.chat`) can't verify for our app
    ID.

### D-002: The app links our patched core, not upstream's core pin
- **Kind:** changed · **Status:** done · **Decided:** 2026-10-11, #286
- **What:**
  - The app builds against `build/core` (`vendor/core` + `patches/core`).
    Upstream's `deltachat-ios/libraries/deltachat-core-rust` submodule is never
    used.
  - Rust is 1.97.0 instead of 1.91.1, because our rusqlite 0.40 needs
    `cfg_select!`.
  - `build-core.sh` passes cargo the physical path to the core, because our
    core's `../../` path dependencies would otherwise resolve in the wrong
    place.
- **Why:** the fork's features live in our core: the webimap transport,
  chunked downloads, and the rest listed in PATCHES.md.
- **Where:** `scripts/apply-patches.sh` (symlink), `rust-toolchain`,
  `scripts/build-core.sh`.
- **Upstream:** pins its own core submodule and bumps it in "update
  deltachat-core-rust" commits.
- **Porting rule:**
  - Upstream core-bump commits never apply; our core moves with
    `vendor/core`.
  - A ported change that needs a newer core API waits until our core pin has
    that API.
  - Upstream `rust-toolchain` bumps apply only if our core builds with them.

### D-003: Offline integration tests and test hooks
- **Kind:** added · **Status:** done · **Decided:** 2026-10-11, #286
- **What:**
  - `DcTests/IntegrationTests`: onboarding, send and receive, and a screenshot
    dropped onto the composer, all against `scripts/mock-madmail.mjs` over
    webimap.
  - `PatchedCoreTests` and `AppIdentifierTests`.
  - `ChatViewController.draft` is internal instead of private, so the tests
    can type into the composer.
- **Why:** an offline CI gate that also proves our core is the one linked.
- **Porting rule:**
  - When porting upstream changes to these screens, keep the tests green.
  - `draft`'s visibility goes away with the chat view rewrite (D-007).

### D-004: SwiftPM instead of CocoaPods
- **Kind:** changed · **Status:** decided (M1 in #288) · **Decided:** 2026-10-11, #288
- **What:**
  - All pods move to SwiftPM.
  - Reachability is replaced by `NWPathMonitor`, and SCSiriWaveformView by our
    own SwiftUI waveform.
  - Core is built as an xcframework, and the simulator runs natively on
    arm64.
- **Porting rule:**
  - Upstream Podfile and `Podfile.lock` bumps become SwiftPM version bumps if
    we want them.
  - Never bring CocoaPods back.

### D-005: Deployment target iOS 26
- **Kind:** changed · **Status:** decided (M2 in #288) · **Decided:** 2026-10-11, #288
- **What:** iOS 26 is the minimum for the app and all extensions, using the
  Liquid Glass and iOS 26 APIs directly.
- **Porting rule:** when porting, drop upstream's `#available` checks and
  fallback code for older iOS versions.

### D-006: JSON-RPC instead of the C FFI
- **Kind:** changed · **Status:** decided (M4 in #288) · **Decided:** 2026-10-11, #288
- **What:**
  - Swift bindings are generated from our core's OpenRPC document.
  - App code calls asynchronously; the extensions call blocking, never on the
    main thread.
  - Typed events feed stores.
  - Only `dc_accounts_new` and `dc_jsonrpc_*` stay as C calls.
- **Porting rule:** ported code that calls `dc_*` C functions gets rewritten
  against the generated client.

### D-007: Rewritten screens replace upstream's
- **Kind:** changed · **Status:** decided (M5 onwards in #288) · **Decided:** 2026-10-11, #288
- **What:** screens rewritten under the #288 recipe replace upstream's
  versions, and the old code is deleted.
- **Rewritten so far:** none.
- **Porting rule:**
  - Upstream code changes to a rewritten screen don't apply as code.
  - Read them for behaviour instead: if the bug fix or feature applies,
    reimplement it.
  - Add the requirement and its test to `docs/ios-features.md`.

## Declined upstream changes

None yet. The upstream review step records each change we decline here, as a
`declined` entry naming the upstream commit or PR and the reason. Later reviews
then skip it.
