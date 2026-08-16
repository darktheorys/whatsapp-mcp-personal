#!/usr/bin/env python3
"""
Convert video files to MP4 format (WhatsApp compatible).
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


def get_video_info(input_file):
    """Get video duration and resolution."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,duration",
                "-of",
                "csv=p=0",
                input_file,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split(",")
            return {"width": int(parts[0]), "height": int(parts[1])}
    except Exception as e:
        print(f"Warning: Could not get video info: {e}", file=sys.stderr)
    return None


def convert_to_mp4(input_file, output_file, quality="medium"):
    """Convert video to MP4 format."""
    if not os.path.isfile(input_file):
        print(f"Error: Input file not found: {input_file}", file=sys.stderr)
        return False

    if quality not in QUALITY_PRESETS:
        print(
            f"Error: Invalid quality. Choose from: {', '.join(QUALITY_PRESETS.keys())}",
            file=sys.stderr,
        )
        return False

    preset = QUALITY_PRESETS[quality]

    print(
        f"Converting {os.path.basename(input_file)} to MP4 ({quality})...",
        file=sys.stderr,
    )

    cmd = [
        "ffmpeg",
        "-i",
        input_file,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-b:v",
        preset["bitrate"],
        # force_divisible_by=2: without it, force_original_aspect_ratio=decrease can land on an
        # odd dimension for a non-square source (e.g. 1280x720 -> 720x405 fitting a 720 box) --
        # h264 requires even width/height, so libx264 refuses to even open the encoder. Found
        # 2026-08-17 on kolpacino.mp4 (a file that had converted fine before, at a different
        # target scale that happened to land even) -- not new breakage, a latent bug that any
        # source/scale combination landing on an odd dimension was always going to hit.
        "-vf",
        f"scale=min(iw\\,{preset['scale']}):min(ih\\,{preset['scale']}):force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-y",
        output_file,
    ]

    try:
        result = subprocess.run(cmd, check=True)
        if result.returncode == 0:
            file_size = os.path.getsize(output_file) / (1024 * 1024)
            print(
                f"✓ Converted: {os.path.basename(output_file)} ({file_size:.1f}MB)",
                file=sys.stderr,
            )
            return True
    except subprocess.CalledProcessError as e:
        print(f"Error: Conversion failed: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Convert video to MP4 format")
    parser.add_argument("input", help="Input video file")
    parser.add_argument(
        "-o", "--output", help="Output MP4 file (default: input_name.mp4)"
    )
    parser.add_argument(
        "-q",
        "--quality",
        choices=["low", "medium", "high"],
        default="medium",
        help="Output quality (default: medium)",
    )

    args = parser.parse_args()

    # Determine output file
    if args.output:
        output_file = args.output
    else:
        base = Path(args.input).stem
        output_file = f"{base}.mp4"

    # Convert
    success = convert_to_mp4(args.input, output_file, args.quality)

    if success:
        print(output_file)
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
