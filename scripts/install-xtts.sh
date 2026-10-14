#!/usr/bin/env bash
# Installs the resident XTTS-v2 voice service as a per-user launchd agent. Run it yourself, in a
# terminal, after state/xtts-venv exists: it writes outside the repo (~/Library/LaunchAgents).
#
#   bash scripts/install-xtts.sh              install (or reinstall) and start
#   bash scripts/install-xtts.sh --uninstall  stop and remove
#
# The service holds the voice model in memory (about 80 seconds to load, then it answers in roughly
# real time). While it is loading the socket does not exist and the WhatsApp daemon falls back to
# Piper, so installing or restarting it never breaks voice notes.
#
# COQUI_TOS_AGREED below accepts Coqui's non-commercial model license (CPML). It is meant for this
# personal, non-commercial bot. Do not run this where that does not hold.
set -euo pipefail

LABEL="com.burak.whatsapp-xtts"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PY="$REPO/state/xtts-venv/bin/python"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. Voice notes use Piper only."
  exit 0
fi

[[ -x "$PY" ]] || { echo "Missing $PY. Create the venv first (python3 -m venv state/xtts-venv, then pip install coqui-tts torch torchaudio torchcodec 'transformers<5')." >&2; exit 1; }
[[ -f "$REPO/state/daemon.token" ]] || { echo "Missing state/daemon.token. Install and start the WhatsApp daemon first." >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
X_LABEL="$(xml "$LABEL")"
X_PY="$(xml "$PY")"
X_REPO="$(xml "$REPO")"
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
    <string>$X_REPO/scripts/xtts_service.py</string>
  </array>
  <key>WorkingDirectory</key><string>$X_REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$X_HOME</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    <key>COQUI_TOS_AGREED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>$X_REPO/state/xtts.log</string>
  <key>StandardErrorPath</key><string>$X_REPO/state/xtts.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL (log: $REPO/state/xtts.log). It is ready when the log says 'ready on'."
echo "Restart after editing scripts/xtts_service.py with: launchctl kickstart -k $DOMAIN/$LABEL"
