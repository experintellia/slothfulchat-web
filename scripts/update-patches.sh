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
  # core.abbrev is pinned: git auto-scales it from the object count, so a shallow
  # submodule clone would rewrite the `index <sha>..<sha>` line of every patch and
  # bury a one-patch change in hundreds of lines of churn. `git am` ignores it.
  git -c core.abbrev=7 -C "$root/build/$name" format-patch --zero-commit --no-signature -o "$root/patches/$name" "$base" >/dev/null
  echo "$name: $(ls "$root/patches/$name" | wc -l) patch(es)"
}

update core vendor/core
update desktop vendor/deltachat-desktop
