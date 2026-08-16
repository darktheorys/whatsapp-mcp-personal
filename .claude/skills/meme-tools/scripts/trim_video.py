#!/usr/bin/env python3
"""
Trim a local video file to a start/end (or start/duration) range and re-encode to MP4. Fixed
argument list only (a start time, an end/duration, in/out paths, a quality preset) -- no
passthrough of arbitrary ffmpeg flags, same reasoning as convert_to_mp4.py and probe_media.py:
a wrapper whose CLI surface can't express a dangerous flag is safe to allowlist, a raw `ffmpeg`
invocation is not (see README's Security notes).

Use this whenever a downloaded clip is longer than wanted (e.g. "kısa olsun" but the source is a
whole scene) -- trim to just the moment, rather than sending the full thing.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

QUALITY_PRESETS = {
    "low": {"scale": "480", "bitrate": "1000k"},
    "medium": {"scale": "720", "bitrate": "2500k"},
    "high": {"scale": "1080", "bitrate": "5000k"},
}


def parse_timestamp(value):
    """Accepts seconds ("12.5") or MM:SS / HH:MM:SS -- ffmpeg understands both natively, so no
    conversion needed; this just validates the shape so a typo fails fast with a clear message
    instead of ffmpeg silently misinterpreting it."""
    import re

    if re.fullmatch(r"\d+(\.\d+)?", value) or re.fullmatch(
        r"(\d+:)?\d+:\d+(\.\d+)?", value
    ):
        return value
    raise argparse.ArgumentTypeError(
        f"'{value}' isn't a valid timestamp (use seconds, MM:SS, or HH:MM:SS)"
    )


def trim_video(input_file, output_file, start, end, duration, quality):
    if not os.path.isfile(input_file):
        print(f"Error: Input file not found: {input_file}", file=sys.stderr)
        return False

    preset = QUALITY_PRESETS[quality]
    cmd = ["ffmpeg", "-y"]
    if start:
        # -ss before -i: fast seek to a keyframe near `start`, then decode forward -- accurate
        # enough for trimming a meme clip and much faster than -ss after -i on a long source.
        cmd += ["-ss", start]
    cmd += ["-i", input_file]
    if end:
        cmd += ["-to", end]
    elif duration:
        cmd += ["-t", duration]

    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-b:v",
        preset["bitrate"],
        # Same force_divisible_by=2 fix as convert_to_mp4.py -- see that file's comment for why.
        "-vf",
        f"scale=min(iw\\,{preset['scale']}):min(ih\\,{preset['scale']}):force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        output_file,
    ]

    print(
        f"Trimming {os.path.basename(input_file)} ({start or '0'} -> {end or ('+' + duration if duration else 'end')})...",
        file=sys.stderr,
    )
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error: Trim failed: {e}", file=sys.stderr)
        return False

    file_size = os.path.getsize(output_file) / (1024 * 1024)
    print(
        f"✓ Trimmed: {os.path.basename(output_file)} ({file_size:.1f}MB)",
        file=sys.stderr,
    )
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Trim a video to a start/end (or start/duration) range"
    )
    parser.add_argument("input", help="Input video file")
    parser.add_argument(
        "-o", "--output", help="Output MP4 file (default: input_name-trimmed.mp4)"
    )
    parser.add_argument(
        "--start",
        type=parse_timestamp,
        help="Start time (seconds, MM:SS, or HH:MM:SS) -- omit to start from 0",
    )
    parser.add_argument(
        "--end",
        type=parse_timestamp,
        help="End time -- mutually exclusive with --duration",
    )
    parser.add_argument(
        "--duration",
        type=parse_timestamp,
        help="Duration from --start -- mutually exclusive with --end",
    )
    parser.add_argument(
        "-q",
        "--quality",
        choices=["low", "medium", "high"],
        default="medium",
        help="Output quality (default: medium)",
    )
    args = parser.parse_args()

    if args.end and args.duration:
        print("Error: pass --end or --duration, not both", file=sys.stderr)
        sys.exit(1)

    output_file = args.output or f"{Path(args.input).stem}-trimmed.mp4"
    success = trim_video(
        args.input, output_file, args.start, args.end, args.duration, args.quality
    )

    if success:
        print(output_file)
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
