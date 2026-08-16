#!/usr/bin/env python3
"""
Prints title/duration/uploader for a video URL, no download. Fixed argument list only (no
passthrough of arbitrary yt-dlp flags) so this can be safely allowlisted -- unlike a raw `yt-dlp`
invocation, there is no way to smuggle a flag like `--exec` through this script's CLI surface.
"""

import argparse
import json
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description="Print video metadata (title/duration/uploader), no download")
    parser.add_argument("url", help="Video URL")
    parser.add_argument("--json", action="store_true", help="Print raw JSON instead of plain lines")
    args = parser.parse_args()

    cmd = ["yt-dlp", "--no-download", "--print", "%(title)s", "--print", "%(duration)s", "--print", "%(uploader)s", args.url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"Failed to fetch info: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    lines = result.stdout.strip().split("\n")
    title = lines[0] if len(lines) > 0 else None
    duration = lines[1] if len(lines) > 1 else None
    uploader = lines[2] if len(lines) > 2 else None

    if args.json:
        print(json.dumps({"title": title, "duration": duration, "uploader": uploader}, indent=2))
    else:
        print(f"title: {title}")
        print(f"duration: {duration}")
        print(f"uploader: {uploader}")


if __name__ == "__main__":
    main()
