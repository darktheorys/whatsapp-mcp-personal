#!/usr/bin/env python3
"""
Watch a public Instagram reel/post: download it, then sample frames + transcript so the
content can actually be reviewed rather than guessed at from the caption.

This is the "reel watching" path -- chains ig_download.py (fetch) into the yt-dlp skill's
watch_video.py (frames + whisper transcript). Emits one merged JSON blob: Instagram metadata
(owner/caption/duration) plus contact_sheet / first_frame / transcript to read.

No login, no credentials. Public posts only.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
IG_DOWNLOAD = HERE / "ig_download.py"
WATCH_VIDEO = REPO / ".claude" / "skills" / "yt-dlp" / "scripts" / "watch_video.py"


def run_json(cmd, what):
    proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        print(f"{what} failed (exit {proc.returncode})", file=sys.stderr)
        sys.exit(proc.returncode)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"{what} did not return JSON:\n{proc.stdout[:500]}", file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="Download and watch a public Instagram reel/post (no login)")
    p.add_argument("target", help="Post/reel URL or bare shortcode")
    p.add_argument("--fps", type=float, default=1.0, help="Frames per second to sample (default: 1)")
    p.add_argument("-o", "--out-dir", default=None, help="Directory for the download (default: state/tmp)")
    args = p.parse_args()

    if not WATCH_VIDEO.exists():
        print(f"Missing dependency: {WATCH_VIDEO}", file=sys.stderr)
        sys.exit(1)

    dl_cmd = [IG_DOWNLOAD, args.target, "--json"]
    if args.out_dir:
        dl_cmd += ["-o", args.out_dir]
    dl = run_json(dl_cmd, "ig_download.py")

    videos = [f for f in dl.get("files", []) if f.lower().endswith(".mp4")]
    if not videos:
        # Image post: nothing to transcribe, just hand back the stills to look at.
        print(json.dumps({**dl, "watch": None,
                          "tip": "Image post -- Read the files[] directly."}, indent=2, ensure_ascii=False))
        return

    # watch_video.py defaults to a system temp dir, which sits outside the repo and is
    # therefore unreadable (the deny-outside-repo hook confines reads to the repo + scratchpad).
    # Always land frames somewhere readable, next to the download.
    watch_dir = Path(videos[0]).parent / f"watch-{dl.get('shortcode')}"
    watch = run_json(
        [WATCH_VIDEO, videos[0], "--fps", str(args.fps), "--out-dir", str(watch_dir)],
        "watch_video.py",
    )

    print(json.dumps({
        "shortcode": dl.get("shortcode"),
        "owner": dl.get("owner"),
        "duration": dl.get("duration"),
        "caption": dl.get("caption"),
        "video": videos[0],
        "first_frame": watch.get("first_frame"),
        "contact_sheet": watch.get("contact_sheet"),
        "transcript": watch.get("transcript"),
        "frames": watch.get("frames"),
        "tip": "Read first_frame for a quick check, then contact_sheet for the whole flow. "
               "Transcript is whisper output and may be empty for music-only reels.",
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
