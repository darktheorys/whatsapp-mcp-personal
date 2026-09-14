#!/usr/bin/env bash
# Builds scripts/extract-text.swift into state/bin/extract-text, the on-device OCR/PDF text
# extractor used for inbound images and documents.
#
# macOS-only and no-op-safe, same contract as setup-voice.sh: on any other platform, or without the
# Swift toolchain, it prints why and exits 0. Text extraction then simply doesn't happen — messages
# still log, media still downloads, nothing breaks. This runs from `postinstall`, and an install
# must never fail because an optional local capability isn't available.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/extract-text.swift"
OUT_DIR="$ROOT/state/bin"
OUT="$OUT_DIR/extract-text"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "setup-text-extract: not macOS — skipping (Vision/PDFKit are macOS frameworks)."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "setup-text-extract: swiftc not found — skipping."
  echo "  Install the Xcode command line tools to enable OCR: xcode-select --install"
  exit 0
fi

# Skip the rebuild when the binary is already newer than its source. postinstall runs on every
# `pnpm install`, and a Swift compile is slow enough to be worth not repeating for nothing.
if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "setup-text-extract: $OUT is up to date."
  exit 0
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

echo "setup-text-extract: building extract-text…"
if swiftc -O -o "$OUT" "$SRC" 2>&1; then
  chmod 700 "$OUT"
  echo "setup-text-extract: built $OUT"
else
  # Deliberately still exit 0: a failed optional build must not fail `pnpm install`.
  echo "setup-text-extract: build failed — OCR and PDF text extraction will be unavailable."
  exit 0
fi
