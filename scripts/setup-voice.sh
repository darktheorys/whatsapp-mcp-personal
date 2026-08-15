#!/usr/bin/env bash
# Sets up voice (TTS/STT) support: whisper.cpp + a model, Piper + a Turkish voice, in an isolated
# uv venv. Runs from `pnpm install`'s postinstall, but never fails the install — voice is optional
# (see README "Voice: speaking and listening"), text/images work fine without any of this.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/state"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "setup-voice: not macOS, skipping (say/whisper-cpp/afconvert are macOS-only here)."
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "setup-voice: Homebrew not found, skipping voice setup. Install https://brew.sh and re-run: bash scripts/setup-voice.sh"
  exit 0
fi

echo "setup-voice: installing whisper-cpp, ffmpeg, uv (no-op if already installed)..."
brew install whisper-cpp ffmpeg uv || echo "setup-voice: brew install failed, voice setup incomplete."

mkdir -p "$STATE/whisper-models" "$STATE/piper-models"

# Which whisper model to fetch. Defaults to the "low" tier so a plain `pnpm install` still costs
# ~500MB rather than 1.6GB; pass a tier to get a better one: `bash scripts/setup-voice.sh high`.
# The tier names match S2T_MODELS in src/config.mjs — keep the two in step.
case "${1:-low}" in
  low)  WHISPER_MODEL=ggml-small.bin;           WHISPER_SIZE="~500MB" ;;
  mid)  WHISPER_MODEL=ggml-medium.bin;          WHISPER_SIZE="~1.5GB" ;;
  high) WHISPER_MODEL=ggml-large-v3-turbo.bin;  WHISPER_SIZE="~1.6GB" ;;
  *) echo "setup-voice: unknown tier '$1' (use low, mid or high)."; exit 1 ;;
esac

if [[ ! -f "$STATE/whisper-models/$WHISPER_MODEL" ]]; then
  echo "setup-voice: downloading whisper model $WHISPER_MODEL ($WHISPER_SIZE)..."
  # -C - resumes a partial file: these are big enough that a dropped connection halfway through
  # shouldn't mean starting over. Downloaded to .part first so an interrupted run can never leave
  # a truncated file that looks like a valid model to the tier check in src/server.mjs.
  curl -fL -C - -o "$STATE/whisper-models/$WHISPER_MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL" \
    && mv "$STATE/whisper-models/$WHISPER_MODEL.part" "$STATE/whisper-models/$WHISPER_MODEL" \
    || echo "setup-voice: whisper model download failed."
else
  echo "setup-voice: whisper model $WHISPER_MODEL already present, skipping."
fi

if [[ ! -f "$STATE/piper-models/tr_TR-dfki-medium.onnx" ]]; then
  echo "setup-voice: downloading Piper Turkish voice (~60MB)..."
  curl -fL -o "$STATE/piper-models/tr_TR-dfki-medium.onnx" \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx \
    && curl -fL -o "$STATE/piper-models/tr_TR-dfki-medium.onnx.json" \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx.json \
    || echo "setup-voice: Piper model download failed."
else
  echo "setup-voice: Piper model already present, skipping."
fi

if [[ ! -x "$STATE/piper-venv/bin/piper" ]]; then
  echo "setup-voice: creating Piper venv..."
  uv venv "$STATE/piper-venv" --python 3.12 \
    && source "$STATE/piper-venv/bin/activate" \
    && uv pip install piper-tts \
    && deactivate \
    || echo "setup-voice: Piper venv setup failed."
else
  echo "setup-voice: Piper venv already present, skipping."
fi

echo "setup-voice: done."
