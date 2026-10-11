#!/usr/bin/env bash
# Regenerate patches/ from commits made in the build/ worktrees.
# Workflow: edit in build/<name>, git commit there (one commit per logical patch), run this.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

update() {
  local name=$1 sub=$2
  local base
  base=$(git -C "$sub" rev-parse HEAD)
  rm -f "$root/patches/$name"/*.patch
  # Only a patch's own commit may change its file, or a one-patch change touches
  # every file and any two open PRs conflict on all of them.
  # --no-numbered: no [PATCH NN/MM] counter, which changes whenever a patch is
  #   added or dropped. Apply order comes from the NNNN- file names.
  # --full-index: abbreviated `index <sha>..<sha>` hashes get longer when they turn
  #   ambiguous, which depends on how much history the clone has.
  git -C "$root/build/$name" format-patch --no-numbered --full-index --zero-commit --no-signature -o "$root/patches/$name" "$base" >/dev/null
  # Authorship in the stack is throwaway; format-patch bakes in whatever git
  # identity the worktree commit happened to use, which has leaked real email
  # addresses. Pin the From: header (first one = the mail header) to a dummy.
  sed -i '0,/^From: /s/^From: .*/From: slothfulchat <patches@slothfulchat.invalid>/' "$root/patches/$name"/*.patch
  echo "$name: $(ls "$root/patches/$name" | wc -l) patch(es)"
}

update core vendor/core
update desktop vendor/deltachat-desktop
