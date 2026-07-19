// Multi-agent build of tracking-param removal for links (see chat/PR):
// a shared strip module + open-side stripping + paste-time composer chip.
// Opus agents implement (sequential, same worktree, one amended commit);
// Fable (session model) reviews with three lenses; Opus fixes must-fix
// findings; a final Fable pass confirms. Docs/patch-regen/commit/push stay
// with the main loop — this workflow only touches build/desktop.

export const meta = {
  name: 'tracking-strip',
  description: 'Implement tracking-param link stripping (module + open-side + paste chip), review, fix',
  whenToUse: 'One-shot build of the tracking-strip feature on the prepared build/desktop worktree.',
  phases: [
    { title: 'Implement', detail: 'strip module + open-side + setting, then paste chip', model: 'opus' },
    { title: 'Review', detail: '3 lenses: correctness, trust-boundary, ponytail' },
    { title: 'Fix', detail: 'apply must-fix findings, amend, re-verify', model: 'opus' },
  ],
}

const BRIEF = `
You are working in /home/user/slothfulchat-web. The app is a browser port of
deltachat-desktop; upstream lives as patches over a vendored tree. The patched
source you edit is the git worktree build/desktop (branch-less, patches already
applied, pnpm install already done). Do NOT touch vendor/, patches/, or the
main repo — only files under build/desktop, committed there.

Project style: ponytail (lazy senior dev) — reuse existing patterns, stdlib
first, shortest working diff, no new dependencies, no speculative abstraction.
Mark deliberate shortcuts with a "ponytail:" comment naming the ceiling.
This fork writes plain-English UI labels (no i18n keys) for its own features.

FEATURE (decided UX, do not redesign):
One setting, two automatic intervention points, visibility instead of consent.

1. Shared pure module packages/frontend/src/utils/trackingParams.ts:
   export function stripTrackingParams(url: string): string | null
   Returns the cleaned URL, or null if nothing was stripped / URL unparsable
   (use new URL(), try/catch). Strip ONLY a known-tracker allowlist, never
   "all query params" (t= on YouTube is a timestamp, v= is the video):
   - any host: params matching utm_* prefix; fbclid, gclid, dclid, gbraid,
     wbraid, msclkid, mc_eid, igshid
   - per-domain (host === domain or endsWith('.'+domain)):
     youtube.com + youtu.be: si, pp, feature
     instagram.com: igsh
     x.com + twitter.com: s, t, ref_src, ref_url
     open.spotify.com: si
     tiktok.com: _t, _r
     amazon.* (any TLD): also strip tag, linkCode, ref, ref_, qid, sr,
       sprefix, crid, dib, dib_tag, pd_rd_* and pf_rd_* prefixes, and a
       trailing /ref=... path segment. Keep th and other functional params.
   Preserve scheme, port, hash, and all other params/order. http(s) only.

2. Open side: packages/frontend/src/hooks/useOpenLinkSafely.ts —
   in useOpenNonMailtoLinkSafely, before runtime.openLink(url), replace the
   url with stripTrackingParams(url) ?? url when the setting is on. Silent,
   no UI. Do not alter the non-http confirm/copy flow.

3. Setting stripTrackingLinks, DEFAULT ON:
   - packages/shared/shared-types.d.ts: add to DesktopSettingsType next to
     linkPreviewSuggestions
   - packages/shared/state.ts: default true
   - packages/frontend/src/components/Settings/ChatsAndMedia.tsx: a
     DesktopSettingsSwitch label 'Remove tracking from links', description
     e.g. 'Strips known tracking parameters (utm_*, YouTube si=, …) when you
     paste or open a link' — place beside the fork's other plain-label
     switches there.

4. Composer paste chip (packages/frontend/src/components/composer/):
   Nobody types utm_ by hand — tracking arrives via paste, and paste is the
   only safe moment to rewrite draft text. When the setting is on and pasted
   plain text contains http(s) URLs with strippable params: insert the
   cleaned text instead, and show a quiet one-line chip in the composer
   upper-bar (same slot/pattern as LinkPreviewGhost, see its styles.module.scss
   .bar) reading "Tracking removed from link" with Undo and dismiss (✕)
   buttons. Undo replaces the cleaned URL(s) in the draft with the originals
   and hides the chip. Chip clears on dismiss, undo, send/draft clear, or
   chat switch — per-message, like the ghost's dismissedRef. Wire the paste
   interception into Composer.tsx's existing onPaste path
   (ComposerMessageInput already forwards onPaste; there is an existing
   handlePaste for editing mode — do not break it; compose-mode-only is fine
   if that keeps the diff smaller, note it with a ponytail: comment).
   NEVER lose user text: on any doubt (multiple URLs, rich clipboard,
   mid-IME), fall back to the default paste untouched.

VERIFY commands (run from build/desktop):
  pnpm --filter @deltachat-desktop/frontend test         # mocha src/tests/**
  pnpm --filter @deltachat-desktop/frontend check:types
Failures already present on an untouched tree are not yours; confirm by
checking whether your files are involved before reporting them.

COMMIT: exactly ONE commit in build/desktop carries the whole feature (later
agents amend it). Subject: "web-app: strip tracking params from links
(open-side + paste chip + setting)" with a body explaining what/why — this
becomes a patch file in the repo's patch stack, write it like the neighboring
patches (git -C build/desktop log for examples). No model names in the commit.
`

const RESULT = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'files_touched', 'tests'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'verbatim result of the verify commands' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const FINDINGS = {
  type: 'object', additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'summary', 'failure_scenario', 'must_fix'],
        properties: {
          file: { type: 'string' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string', description: 'concrete input/state -> wrong outcome' },
          must_fix: { type: 'boolean', description: 'true only for real defects, not taste' },
        },
      },
    },
  },
}

phase('Implement')
const core = await agent(
  `${BRIEF}
Your task is parts 1-3 ONLY (module + tests + open-side + setting). Also write
the mocha test packages/frontend/src/tests/trackingParams.test.ts (same shape
as the neighboring tests there): YouTube si stripped while t=/v= kept, utm_*
on any host, x.com s/t, amazon query+/ref= cleanup with th kept, hash/port
preserved, unchanged URL -> null, unparsable -> null. Run the verify commands.
Commit as specified. Return the structured result.`,
  { label: 'implement:core', model: 'opus', schema: RESULT }
)
if (core?.status !== 'done') return { aborted: 'core implementation blocked', core }

const chip = await agent(
  `${BRIEF}
Parts 1-3 are already committed (git -C build/desktop show HEAD to see them).
Your task is part 4 ONLY: the paste-time chip. Reuse the committed
stripTrackingParams. Run the verify commands. Then git commit --amend into
the existing commit (keep its subject; extend the body with the paste-chip
paragraph). Return the structured result.`,
  { label: 'implement:chip', model: 'opus', schema: RESULT }
)
if (chip?.status !== 'done') return { aborted: 'chip implementation blocked', core, chip }

phase('Review')
const LENSES = [
  ['correctness', `URL and editing edge cases: subdomain matching, youtu.be, ports,
hash, encoded params, param order, amazon path handling, the undo replacement
logic, cursor position after modified paste, chip lifecycle across chat
switches and drafts, setting default plumbing (state.ts vs shared-types).`],
  ['trust-boundary', `Safety and data loss: paste interception must never drop or
mangle user clipboard text (rich content, files, multiple URLs, IME); the
useOpenLinkSafely change must not weaken the unopenable-link confirm flow or
open a URL the user did not click; stripping must not turn a valid URL into a
different resource (e.g. amazon path surgery).`],
  ['ponytail', `Over-engineering: anything to delete, an existing helper not
reused, an abstraction nobody asked for, a smaller diff that still meets the
spec. Also flag missing "ponytail:" comments on deliberate shortcuts. must_fix
only when the simplification is clearly load-bearing.`],
]
const reviews = await parallel(LENSES.map(([lens, detail]) => () =>
  agent(
    `Adversarial code review, single lens: ${lens}.
${detail}
Review ONLY the feature commit: run git -C /home/user/slothfulchat-web/build/desktop show HEAD
and read any touched file in full where the diff is unclear. Repo brief for
context (do not re-litigate the decided UX):
${BRIEF}
Report only verified defects/simplifications with a concrete failure scenario;
no taste-only nits as must_fix. Empty findings array is a fine answer.`,
    { label: `review:${lens}`, phase: 'Review', schema: FINDINGS }
  )
))
const findings = reviews.filter(Boolean).flatMap(r => r.findings)
const mustFix = findings.filter(f => f.must_fix)
log(`review: ${findings.length} findings, ${mustFix.length} must-fix`)

let fix = null
if (mustFix.length) {
  phase('Fix')
  fix = await agent(
    `${BRIEF}
The feature is committed (git -C build/desktop show HEAD). Reviewers confirmed
these defects — fix each (or return status blocked with a reason if one is
wrong, do not silently skip):
${JSON.stringify(mustFix, null, 2)}
Re-run the verify commands, git commit --amend, return the structured result.`,
    { label: 'fix', model: 'opus', schema: RESULT }
  )
  const recheck = await agent(
    `Verify a fix round. These defects were reported and supposedly fixed in the
single commit at HEAD of the git worktree /home/user/slothfulchat-web/build/desktop:
${JSON.stringify(mustFix, null, 2)}
Fixer's report: ${JSON.stringify(fix)}
Check the code (git show HEAD, read the files); report any of them NOT actually
fixed, or newly introduced defects, as must_fix findings.`,
    { label: 'recheck', phase: 'Fix', schema: FINDINGS }
  )
  return { core, chip, findings, fix, unresolved: recheck?.findings ?? [] }
}
return { core, chip, findings, fix: null, unresolved: [] }
