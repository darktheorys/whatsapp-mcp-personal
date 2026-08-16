#!/usr/bin/env python3
"""
Prints duration/codec/resolution for a local media file via ffprobe. Fixed argument list only
(no passthrough of arbitrary ffprobe flags) so this can be safely allowlisted -- unlike a raw
`ffprobe`/`ffmpeg` invocation, there is no way to smuggle a dangerous protocol/output flag through
this script's CLI surface.
"""

import argparse
import json
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description="Probe a local media file's duration/codec/resolution")
    parser.add_argument("path", help="Path to a local media file")
    parser.add_argument("--json", action="store_true", help="Print raw ffprobe JSON instead of a summary line")
    args = parser.parse_args()

    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
        "-of", "json",
        args.path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"Probe failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(result.stdout)
        return

    data = json.loads(result.stdout)
    duration = data.get("format", {}).get("duration")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)

    print(f"duration: {float(duration):.1f}s" if duration else "duration: unknown")
    if video:
        print(f"video: {video.get('codec_name')} {video.get('width')}x{video.get('height')}")
    if audio:
        print(f"audio: {audio.get('codec_name')}")


if __name__ == "__main__":
    main()
