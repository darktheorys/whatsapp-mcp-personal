#!/usr/bin/env bash
# Installs the resident VoxCPM2 voice-clone service as a per-user launchd agent. Run it yourself, in a
# terminal, after state/tts-mlx-venv exists: it writes outside the repo (~/Library/LaunchAgents).
#
#   bash scripts/install-voxcpm.sh              install (or reinstall) and start
#   bash scripts/install-voxcpm.sh --uninstall  stop and remove
#
# The service holds the VoxCPM2 model in memory (about 100 seconds to load, then 1.6 to 3 times real
# time). It clones only. While it is loading the socket does not exist and the WhatsApp daemon uses the
# XTTS service for cloned voices, so installing or restarting it never breaks voice notes.
set -euo pipefail

LABEL="com.whatsapp-mcp-personal.voxcpm"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PY="$REPO/state/tts-mlx-venv/bin/python"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
X_REPO="$(xml "$REPO")"

# An older version of these scripts installed the agent under a different label. Unload and remove any
# other agent whose plist launches this repo's file $1, and wait until it is gone, so two copies never
# run side by side.
remove_older_agents() {
  local old label
  for old in "$HOME"/Library/LaunchAgents/*.plist; do
    [[ -f "$old" && "$old" != "$PLIST" ]] || continue
    grep -qF "<string>$X_REPO/$1</string>" "$old" 2>/dev/null || continue
    label="$(basename "$old" .plist)"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break
      sleep 0.5
    done
    rm -f "$old"
    echo "Removed the older agent $label."
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  remove_older_agents scripts/voxcpm_service.py
  rm -f "$PLIST"
  echo "Removed $LABEL. Cloned voices use XTTS only."
  exit 0
fi

[[ -x "$PY" ]] || { echo "Missing $PY. Create the venv first (python3.12 -m venv state/tts-mlx-venv, then pip install mlx-audio)." >&2; exit 1; }
[[ -f "$REPO/state/daemon.token" ]] || { echo "Missing state/daemon.token. Install and start the WhatsApp daemon first." >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"

X_LABEL="$(xml "$LABEL")"
X_PY="$(xml "$PY")"
X_HOME="$(xml "$HOME")"

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$X_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$X_PY</string>
    <string>$X_REPO/scripts/voxcpm_service.py</string>
  </array>
  <key>WorkingDirectory</key><string>$X_REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$X_HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$X_REPO/state/voxcpm.log</string>
  <key>StandardErrorPath</key><string>$X_REPO/state/voxcpm.log</string>
</dict>
</plist>
PLIST

remove_older_agents scripts/voxcpm_service.py

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL (log: $REPO/state/voxcpm.log). It is ready when the log says 'ready on'."
echo "Restart after editing scripts/voxcpm_service.py with: launchctl kickstart -k $DOMAIN/$LABEL"
