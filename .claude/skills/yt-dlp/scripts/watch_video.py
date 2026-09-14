#!/usr/bin/env python3
"""
Extracts sampled frames + a transcript from a video file, so Claude can look at
the frames directly (Read tool) instead of guessing what a downloaded clip
shows before sending it anywhere. Call this when you don't know much about a
video yet -- e.g. right after downloading it and before wa_send_video.

Uses ffmpeg (frame extraction, audio extraction) and whisper-cli (transcript),
same tools src/server.mjs uses for voice notes -- no new dependency.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

DEFAULT_MODEL_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "state", "whisper-models"
)
MODEL_PREFERENCE = ["ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin"]
MAX_FRAMES = 40  # a 1fps sample past this many seconds gets subsampled, not silently truncated


def pick_model(model_dir):
    for name in MODEL_PREFERENCE:
        path = os.path.join(model_dir, name)
        if os.path.exists(path):
            return path
    return None


def probe_duration(path):
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return None


def extract_frames(path, out_dir, fps):
    duration = probe_duration(path)
    effective_fps = fps
    if duration and duration * fps > MAX_FRAMES:
        effective_fps = MAX_FRAMES / duration
        print(
            f"Video is {duration:.0f}s; {fps}fps would make {int(duration * fps)} frames. "
            f"Subsampling to ~{MAX_FRAMES} frames (fps={effective_fps:.3f}) instead of truncating.",
            file=sys.stderr,
        )

    pattern = os.path.join(out_dir, "frame-%04d.jpg")
    cmd = [
        "ffmpeg", "-y",
        "-i", path,
        "-vf", f"fps={effective_fps}",
        "-qscale:v", "3",
        pattern,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=180)
    return sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("frame-")
    )


def build_contact_sheet(frames, out_dir, tile_width=160):
    # One cheap low-res grid to see the whole flow at once, instead of reading every
    # full-res frame individually -- read this after frame-0001, before pulling more frames.
    n = len(frames)
    cols = math.ceil(math.sqrt(n * 16 / 9))  # bias wider than tall, matches typical video aspect
    cols = max(1, min(cols, n))
    rows = math.ceil(n / cols)

    list_path = os.path.join(out_dir, "contact-sheet-frames.txt")
    with open(list_path, "w") as f:
        for frame in frames:
            f.write(f"file '{frame}'\n")

    sheet_path = os.path.join(out_dir, "contact-sheet.jpg")
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", list_path,
        "-vf", f"scale={tile_width}:-1,tile={cols}x{rows}",
        "-frames:v", "1", "-qscale:v", "3",
        sheet_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
    os.remove(list_path)
    return sheet_path


def extract_transcript(path, out_dir, model_dir):
    model = pick_model(model_dir)
    if model is None:
        print(f"No whisper model found under {model_dir}; skipping transcript.", file=sys.stderr)
        return None

    wav = os.path.join(out_dir, "audio.wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-ar", "16000", "-ac", "1", wav],
            check=True, capture_output=True, text=True, timeout=120,
        )
    except subprocess.CalledProcessError:
        print("No audio track found or extraction failed; skipping transcript.", file=sys.stderr)
        return None

    try:
        result = subprocess.run(
            ["whisper-cli", "-m", model, "-f", wav, "-nt", "-l", "auto"],
            capture_output=True, text=True, timeout=180,
        )
    except FileNotFoundError:
        print("whisper-cli not installed; skipping transcript.", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(f"whisper-cli failed: {result.stderr.strip()}", file=sys.stderr)
        return None
    return result.stdout.strip() or None


def main():
    parser = argparse.ArgumentParser(description="Sample frames + transcript from a video for review")
    parser.add_argument("path", help="Path to the video file")
    parser.add_argument("--fps", type=float, default=1.0, help="Frames per second to sample (default: 1)")
    parser.add_argument("--out-dir", help="Directory to write frames/audio into (default: a temp dir)")
    parser.add_argument("--model-dir", default=os.path.normpath(DEFAULT_MODEL_DIR), help="Directory holding whisper ggml models")
    args = parser.parse_args()

    if not os.path.exists(args.path):
        print(f"No such file: {args.path}", file=sys.stderr)
        sys.exit(1)

    out_dir = os.path.abspath(args.out_dir or tempfile.mkdtemp(prefix="wa-watch-"))
    os.makedirs(out_dir, exist_ok=True)

    frames = extract_frames(args.path, out_dir, args.fps)
    contact_sheet = build_contact_sheet(frames, out_dir)
    transcript = extract_transcript(args.path, out_dir, args.model_dir)

    print(json.dumps({
        "out_dir": out_dir,
        "first_frame": frames[0] if frames else None,
        "contact_sheet": contact_sheet,
        "frames": frames,
        "transcript": transcript,
        "tip": "Read first_frame for a quick quality/source check, then contact_sheet for the whole flow at once. Only fall back to individual frames[] for a closer look at one moment.",
    }, indent=2))


if __name__ == "__main__":
    main()
