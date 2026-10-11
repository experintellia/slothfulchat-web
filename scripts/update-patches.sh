#!/usr/bin/env bash
# Regenerate patches/ from commits made in the build/ worktrees.
# Workflow: edit in build/<name>, git commit there (one commit per logical patch), run this.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

update() {
  local name=$1 sub=$2
  local base wt=$root/build/$name
  base=$(git -C "$sub" rev-parse HEAD)
  # Upstream bug fixes (a `Patch-Range: upstream-fix` trailer) go first and take
  # 0001-0999; everything else is 1000 and up. Numbers are permanent: see
  # scripts/patch-numbers.mjs. Everything is checked before anything is deleted.
  local list commits=() c body fixes=0
  # A plain assignment, so a missing worktree stops the script here: set -e
  # doesn't see a failure inside < <(...).
  list=$(git -C "$wt" rev-list --reverse "$base..HEAD")
  [[ -z $list ]] || mapfile -t commits <<<"$list"
  for c in "${commits[@]}"; do
    body=$(git -C "$wt" log -1 --format=%B "$c")
    # Anywhere in the message, any case: a fix whose trailer went unrecognised
    # would leave the fix range and take a number in the 1000s.
    if grep -qiE '^Patch-Range:[[:space:]]*upstream-fix[[:space:]]*$' <<<"$body"; then
      [[ ${commits[$fixes]} == "$c" ]] || {
        echo "$name: upstream-fix commit $c comes after a non-fix commit; move it below them" >&2
        exit 1
      }
      fixes=$((fixes + 1))
    fi
  done
  (( fixes < 1000 )) || { echo "$name: more than 999 upstream-fix commits" >&2; exit 1; }
  local tmp=$tmproot/$name
  mkdir "$tmp"
  # Only a patch's own commit may change its file, or a one-patch change touches
  # every file and any two open PRs conflict on all of them.
  # --no-numbered: no [PATCH NN/MM] counter, which changes whenever a patch is
  #   added or dropped. Apply order comes from the NNNN- file names.
  # --full-index: abbreviated `index <sha>..<sha>` hashes get longer when they turn
  #   ambiguous, which depends on how much history the clone has.
  # --no-cover-letter, --suffix and --filename-max-length pin settings a user's
  #   git config could change; the file names are how numbers are matched.
  local fmt=(format-patch --no-numbered --full-index --zero-commit --no-signature
    --no-cover-letter --suffix=.patch --filename-max-length=64 -o "$tmp")
  local split=$base
  if (( fixes )); then
    split=${commits[$((fixes - 1))]}
    git -C "$wt" "${fmt[@]}" "$base..$split" >/dev/null
  fi
  if (( fixes < ${#commits[@]} )); then
    git -C "$wt" "${fmt[@]}" --start-number=1000 "$split..HEAD" >/dev/null
  fi
  local plan from to
  plan=$(node "$root/scripts/patch-numbers.mjs" "$root/patches/$name" "$tmp")
  local made planned
  made=$(find "$tmp" -type f | wc -l)
  planned=$(grep -c . <<<"$plan" || true)
  (( made == planned )) || { echo "$name: numbered $planned of $made patches; nothing changed" >&2; exit 1; }
  mkdir -p "$root/patches/$name"
  rm -f "$root/patches/$name"/*.patch
  while IFS=$'\t' read -r from to; do
    if [[ -n $from ]]; then mv "$tmp/$from" "$root/patches/$name/$to"; fi
  done <<<"$plan"
  # Authorship in the stack is throwaway; format-patch bakes in whatever git
  # identity the worktree commit happened to use, which has leaked real email
  # addresses. Pin the From: header (first one = the mail header) to a dummy.
  if (( ${#commits[@]} )); then
    sed -i '0,/^From: /s/^From: .*/From: slothfulchat <patches@slothfulchat.invalid>/' "$root/patches/$name"/*.patch
  fi
  echo "$name: $(ls "$root/patches/$name" | wc -l) patch(es)"
}

update core vendor/core
update desktop vendor/deltachat-desktop
update ios vendor/deltachat-ios
