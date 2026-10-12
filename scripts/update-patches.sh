#!/usr/bin/env bash
# Regenerate patches/ from commits made in the build/ worktrees.
# Workflow: edit in build/<name>, git commit there (one commit per logical patch), run this.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

update() {
  local name=$1 sub=$2
  local base wt=$root/build/$name
  base=$(git -C "$sub" rev-parse HEAD)
  # Upstream bug fixes (a `Patch-Range: upstream-fix` trailer) go first and take
  # 0001-0099; everything else starts at 0100, so adding a fix never renumbers
  # the patches after it. Checked before anything is deleted.
  local commits=() c fixes=0
  mapfile -t commits < <(git -C "$wt" rev-list --reverse "$base..HEAD")
  for c in "${commits[@]}"; do
    if [[ $(git -C "$wt" log -1 --format='%(trailers:key=Patch-Range,valueonly)' "$c") == upstream-fix ]]; then
      [[ ${commits[$fixes]} == "$c" ]] || {
        echo "$name: upstream-fix commit $c comes after a non-fix commit; move it below them" >&2
        exit 1
      }
      fixes=$((fixes + 1))
    fi
  done
  (( fixes < 100 )) || { echo "$name: more than 99 upstream-fix commits" >&2; exit 1; }
  rm -f "$root/patches/$name"/*.patch
  # Only a patch's own commit may change its file, or a one-patch change touches
  # every file and any two open PRs conflict on all of them.
  # --no-numbered: no [PATCH NN/MM] counter, which changes whenever a patch is
  #   added or dropped. Apply order comes from the NNNN- file names.
  # --full-index: abbreviated `index <sha>..<sha>` hashes get longer when they turn
  #   ambiguous, which depends on how much history the clone has.
  local fmt=(format-patch --no-numbered --full-index --zero-commit --no-signature -o "$root/patches/$name")
  local split=$base
  if (( fixes )); then
    split=${commits[$((fixes - 1))]}
    git -C "$wt" "${fmt[@]}" "$base..$split" >/dev/null
  fi
  if (( fixes < ${#commits[@]} )); then
    git -C "$wt" "${fmt[@]}" --start-number=100 "$split..HEAD" >/dev/null
  fi
  # Authorship in the stack is throwaway; format-patch bakes in whatever git
  # identity the worktree commit happened to use, which has leaked real email
  # addresses. Pin the From: header (first one = the mail header) to a dummy.
  sed -i '0,/^From: /s/^From: .*/From: slothfulchat <patches@slothfulchat.invalid>/' "$root/patches/$name"/*.patch
  echo "$name: $(ls "$root/patches/$name" | wc -l) patch(es)"
}

update core vendor/core
update desktop vendor/deltachat-desktop
