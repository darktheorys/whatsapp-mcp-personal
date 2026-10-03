#!/usr/bin/env bash
# Installs the WhatsApp daemon as a per-user launchd agent, so it runs on its own and survives
# Claude Code restarts and `/mcp` reconnects. Run it yourself, in a terminal: it writes outside the
# repo (~/Library/LaunchAgents), which is deliberately beyond what Claude Code's tools may touch.
#
#   bash scripts/install-daemon.sh            install (or reinstall) and start
#   bash scripts/install-daemon.sh --uninstall  stop and remove
#
# Only one process may hold the WhatsApp connection. Starting the daemon takes it over from a
# running stdio server, which then exits by design, so expect the current MCP tools to go away until
# you re-register the server as the shim (printed at the end) and run /mcp.
set -euo pipefail

LABEL="com.burak.whatsapp-mcp"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. Re-register the MCP server as the stdio server to go back:"
  printf '  claude mcp remove whatsapp-personal && claude mcp add whatsapp-personal -- node %q\n' "$REPO/src/server.mjs"
  exit 0
fi

# The absolute node that is running this script, not a shim: launchd has no fnm/nvm shell setup, so
# a bare `node` would not resolve there.
NODE="$(node -p 'process.execPath')"
mkdir -p "$HOME/Library/LaunchAgents"
# 0700 on creation: state/ holds credentials, and the daemon socket and token live in it.
[[ -d "$REPO/state" ]] || mkdir -m 700 "$REPO/state"

# These go into XML, and a path containing & or < would otherwise produce a plist launchd rejects
# (or one that means something else).
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
X_LABEL="$(xml "$LABEL")"
X_NODE="$(xml "$NODE")"
X_REPO="$(xml "$REPO")"
X_HOME="$(xml "$HOME")"

# PATH matters: the server shells out to ffmpeg, whisper-cli, piper's venv, say and afconvert, and
# launchd's default PATH has none of the Homebrew locations.
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$X_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$X_NODE</string>
    <string>$X_REPO/src/daemon.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$X_REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$X_HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$X_REPO/state/daemon.log</string>
  <key>StandardErrorPath</key><string>$X_REPO/state/daemon.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone, and a bootstrap straight after can fail with an I/O error.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL (log: $REPO/state/daemon.log)."
echo
echo "Next, point Claude Code at the shim instead of the stdio server, then run /mcp:"
printf '  claude mcp remove whatsapp-personal && claude mcp add whatsapp-personal -- %q %q\n' "$NODE" "$REPO/src/shim.mjs"
echo
echo "Restart the daemon after code changes with: bash scripts/restart-daemon.sh"
