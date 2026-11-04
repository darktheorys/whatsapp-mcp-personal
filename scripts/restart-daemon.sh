#!/usr/bin/env bash
# Restarts the WhatsApp daemon so it loads edited code under src/. The shim reconnects and replays
# the client's initialize by itself, so no /mcp is needed afterwards unless src/shim.mjs changed.
set -euo pipefail

LABEL="com.whatsapp-mcp-personal.daemon"
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "$LABEL is not loaded. Run: bash scripts/install-daemon.sh (it also replaces an agent installed under an older label)." >&2
  exit 1
fi
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Restarted $LABEL. Tail the log with: tail -f \"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/state/daemon.log\""
