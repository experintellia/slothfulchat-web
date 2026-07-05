#!/usr/bin/env bash
# Recreate build/ worktrees from the pinned submodule commits and apply the patch stacks.
# Source of truth = submodule pins + patches/. build/ is throwaway.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

apply() {
  local name=$1 sub=$2
  git -C "$sub" worktree remove --force "$root/build/$name" 2>/dev/null || rm -rf "$root/build/$name"
  git -C "$sub" worktree prune
  git -C "$sub" worktree add --detach "$root/build/$name" HEAD >/dev/null
  local patches=("$root/patches/$name"/*.patch)
  if [[ -e ${patches[0]} ]]; then
    git -C "$root/build/$name" am "${patches[@]}"
    echo "$name: applied ${#patches[@]} patch(es)"
  else
    echo "$name: no patches"
  fi
}

apply core vendor/core
apply desktop vendor/deltachat-desktop
