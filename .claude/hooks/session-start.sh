#!/bin/bash
# Install the ponytail Claude Code plugin so it's available in web sessions.
# ponytail is declared in .claude/settings.json (marketplace + enabledPlugins),
# but the plugin still has to be fetched into ~/.claude/plugins on a fresh
# container. This hook does that non-interactively at session start.
set -euo pipefail

# Web (Claude Code on the web) only — local installs already have their plugins.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Already installed? Nothing to do (idempotent, keeps startup fast).
if claude plugin list 2>/dev/null | grep -q 'ponytail@ponytail'; then
  echo "ponytail already installed"
  exit 0
fi

# Add the marketplace (honors the pinned ref in settings.json) and install.
# Both commands are safe to re-run.
claude plugin marketplace add DietrichGebert/ponytail
claude plugin install ponytail@ponytail --scope user

echo "ponytail installed"
