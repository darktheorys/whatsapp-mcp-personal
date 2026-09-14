#!/usr/bin/env bash
# Sets up the Instagram skill's Instaloader venv (see README "Instagram" and
# .claude/skills/instagram/SKILL.md). Runs from `pnpm install`'s postinstall, but never fails the
# install -- the Instagram skill is optional and everything else works without it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/state/instaloader-venv"

if ! command -v python3 >/dev/null 2>&1; then
  echo "setup-instaloader: python3 not found, skipping. Install Python 3 and re-run: bash scripts/setup-instaloader.sh"
  exit 0
fi

if [[ -x "$VENV/bin/python3" ]] && "$VENV/bin/python3" -c "import instaloader" >/dev/null 2>&1; then
  echo "setup-instaloader: already set up, skipping."
  exit 0
fi

echo "setup-instaloader: creating venv at state/instaloader-venv..."
python3 -m venv "$VENV" || { echo "setup-instaloader: venv creation failed, skipping."; exit 0; }

echo "setup-instaloader: installing instaloader..."
"$VENV/bin/pip" install --quiet --upgrade pip instaloader \
  || { echo "setup-instaloader: pip install failed. Re-run later: bash scripts/setup-instaloader.sh"; exit 0; }

"$VENV/bin/python3" -c "import instaloader; print('setup-instaloader: instaloader ' + instaloader.__version__ + ' ready.')" \
  || echo "setup-instaloader: install finished but import failed."
