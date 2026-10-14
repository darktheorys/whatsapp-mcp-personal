#!/usr/bin/env bash
# Adds a cloned voice to state/voices/ from an audio file, for the voice-note pipeline.
#
#   bash scripts/add-voice.sh <name> <audio-file> --consent "<whose consent, and when>" \
#        --allow <jid> [--allow <jid> ...] [--default <jid> ...]
#
# Example:
#   bash scripts/add-voice.sh burak state/media/3ADF51BA4F1D847B9620.ogg \
#        --consent "Alice, her own voice, 2026-10-03" --allow 4917012345678@s.whatsapp.net
#
# What it does: converts the file to a 24 kHz mono wav (the first 28 seconds, which is what the model
# uses), writes it to state/voices/<name>.wav, and registers it in state/voices/voices.json.
#
# What it refuses: a voice with no --consent note, and a voice with no --allow chat. Both are required
# on purpose. A synthetic voice note has no text marker, so a clone that reached the wrong chat could
# pass as the real person. The chats listed in --allow are the only places the daemon will ever use
# it (never a group unless you list that group), and --default makes it the voice Claude's own notes
# use in that chat. Only clone your own voice, or someone who has said yes. Public figures, and
# anyone who has not agreed, are out of bounds whatever the source recording is.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VOICES="$REPO/state/voices"

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

[[ $# -ge 2 ]] || usage
NAME="$1"; AUDIO="$2"; shift 2
[[ "$NAME" =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "Name must be lowercase letters, digits, - or _ (max 40)." >&2; exit 2; }
[[ -f "$AUDIO" ]] || { echo "No such file: $AUDIO" >&2; exit 2; }

CONSENT=""; ALLOW=(); DEFAULT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --consent) CONSENT="${2:-}"; shift 2 ;;
    --allow) ALLOW+=("${2:-}"); shift 2 ;;
    --default) DEFAULT+=("${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done
[[ ${#CONSENT} -ge 8 ]] || { echo "--consent is required: say whose voice this is and that they agreed (8+ characters)." >&2; exit 2; }
[[ ${#ALLOW[@]} -ge 1 ]] || { echo "--allow <jid> is required: name at least one chat this voice may be used in." >&2; exit 2; }
for jid in "${DEFAULT[@]:-}"; do
  [[ -z "$jid" ]] && continue
  printf '%s\n' "${ALLOW[@]}" | grep -qx "$jid" || { echo "--default $jid must also be listed with --allow." >&2; exit 2; }
done

mkdir -m 700 -p "$VOICES"
ffmpeg -y -loglevel error -i "$AUDIO" -t 28 -ar 24000 -ac 1 -c:a pcm_s16le "$VOICES/$NAME.wav"
chmod 600 "$VOICES/$NAME.wav"

SECONDS_LONG="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VOICES/$NAME.wav")"
python3 - "$VOICES/voices.json" "$NAME" "$CONSENT" "$(printf '%s\n' "${ALLOW[@]}")" "$(printf '%s\n' "${DEFAULT[@]:-}")" <<'PY'
import json, os, sys
path, name, consent, allow, default = sys.argv[1:6]
voices = json.load(open(path)) if os.path.exists(path) else {}
entry = {"ref": f"{name}.wav", "consent": consent, "allowed_jids": [j for j in allow.split("\n") if j]}
defaults = [j for j in default.split("\n") if j]
if defaults:
    entry["default_jids"] = defaults
voices[name] = entry
json.dump(voices, open(path, "w"), indent=2)
os.chmod(path, 0o600)
PY

echo "Added voice '$NAME' ($(printf '%.0f' "$SECONDS_LONG") s reference). Allowed in: ${ALLOW[*]}"
echo "Use it with wa_send_voice, clone: \"$NAME\". The daemon reads voices.json on every send, so no restart is needed."
if (( $(printf '%.0f' "$SECONDS_LONG") < 6 )); then
  echo "Warning: under 6 seconds of audio gives a weak clone. 20 to 30 seconds of clean speech is best." >&2
fi
