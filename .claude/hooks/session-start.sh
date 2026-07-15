#!/bin/bash
# Install the ponytail Claude Code plugin so it's available in web sessions.
# ponytail is declared in .claude/settings.json (marketplace + enabledPlugins),
# but the plugin still has to be fetched into ~/.claude/plugins on a fresh
# container. This hook does that non-interactively at session start.
set -euo pipefail

# Resolve the claude binary. At SessionStart-hook spawn time the environment
# is not the same as the agent's interactive shell: PATH may not yet include
# claude, and session env vars (e.g. CLAUDE_CODE_REMOTE) are applied *after*
# the hook runs. So we don't gate on CLAUDE_CODE_REMOTE (doing so made this
# hook a silent no-op on every fresh web container) and we don't rely on PATH.
claude_bin="$(command -v claude || true)"
[ -x "$claude_bin" ] || claude_bin="${CLAUDE_CODE_EXECPATH:-/opt/claude-code/bin/claude}"
# Can't find claude? Nothing to do, and never wedge session startup.
[ -x "$claude_bin" ] || exit 0

# Idempotency IS the gate: if ponytail is already installed (local dev machines,
# or a re-run), this exits fast and touches nothing. On a fresh container it's
# absent, so we install. This works regardless of which env vars are populated.
if "$claude_bin" plugin list 2>/dev/null | grep -q 'ponytail@ponytail'; then
  echo "ponytail already installed"
  exit 0
fi

# Add the marketplace (honors the pinned ref in settings.json) and install.
# Both commands are safe to re-run.
"$claude_bin" plugin marketplace add DietrichGebert/ponytail
"$claude_bin" plugin install ponytail@ponytail --scope user

echo "ponytail installed"
