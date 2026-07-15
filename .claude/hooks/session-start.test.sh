#!/bin/bash
# Self-check for session-start.sh: the hook must NOT depend on CLAUDE_CODE_REMOTE
# (which is absent at real hook-spawn time), and must be idempotent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/session-start.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Stub `claude` that records the subcommand it was asked to run.
cat >"$tmp/claude" <<EOF
#!/bin/bash
echo "\$@" >>"$tmp/calls"
case "\$1 \$2" in
  "plugin list") [ -f "$tmp/installed" ] && echo "ponytail@ponytail" ;;
  "plugin install") touch "$tmp/installed" ;;
esac
EOF
chmod +x "$tmp/claude"

run() { PATH="$tmp:$PATH" bash "$hook" >"$tmp/out" 2>&1; }

# 1) Fresh container, CLAUDE_CODE_REMOTE UNSET (the exact bootstrap condition
#    that used to make the hook a no-op) -> it must install.
rm -f "$tmp/installed" "$tmp/calls"
( unset CLAUDE_CODE_REMOTE; run )
grep -q "plugin install ponytail@ponytail" "$tmp/calls" \
  || { echo "FAIL: did not install when CLAUDE_CODE_REMOTE unset"; cat "$tmp/out"; exit 1; }

# 2) Second run (now installed) -> idempotent no-op, no re-install.
: >"$tmp/calls"
( unset CLAUDE_CODE_REMOTE; run )
grep -q "plugin install" "$tmp/calls" \
  && { echo "FAIL: re-installed when already present"; exit 1; }
grep -q "already installed" "$tmp/out" \
  || { echo "FAIL: expected 'already installed' message"; cat "$tmp/out"; exit 1; }

# 3) No claude binary resolvable -> exit 0, no crash (must not wedge startup).
#    Use a real-but-claude-free PATH (coreutils present, no claude on it).
rm -f "$tmp/claude"
PATH="/usr/bin:/bin" CLAUDE_CODE_EXECPATH="/nonexistent/claude" bash "$hook" >/dev/null 2>&1 \
  || { echo "FAIL: hook errored when claude binary missing"; exit 1; }

echo "PASS"
