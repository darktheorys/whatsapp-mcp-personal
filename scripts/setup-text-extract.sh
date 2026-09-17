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
OUT_DIR="$ROOT/state/bin"
# name:source pairs — both are small Swift CLIs over macOS frameworks, built the same way
BUILDS="extract-text:$ROOT/scripts/extract-text.swift cutout:$ROOT/scripts/cutout.swift"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "setup-text-extract: not macOS — skipping (Vision/PDFKit are macOS frameworks)."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "setup-text-extract: swiftc not found — skipping."
  echo "  Install the Xcode command line tools to enable OCR: xcode-select --install"
  exit 0
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

for build in $BUILDS; do
  name="${build%%:*}"
  src="${build##*:}"
  out="$OUT_DIR/$name"

  # Skip the rebuild when the binary is already newer than its source. postinstall runs on every
  # `pnpm install`, and a Swift compile is slow enough to be worth not repeating for nothing.
  if [ -x "$out" ] && [ "$out" -nt "$src" ]; then
    echo "setup-text-extract: $name is up to date."
    continue
  fi

  echo "setup-text-extract: building $name…"
  if swiftc -O -o "$out" "$src" 2>&1; then
    chmod 700 "$out"
    echo "setup-text-extract: built $out"
  else
    # Deliberately not fatal: a failed optional build must not fail `pnpm install`, and one binary
    # failing must not stop the other being built.
    echo "setup-text-extract: $name failed to build — that capability will be unavailable."
  fi
done
exit 0
