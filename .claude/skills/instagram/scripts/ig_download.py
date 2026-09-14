#!/usr/bin/env python3
"""
Download the media for ONE public Instagram post/reel by URL or shortcode. No login.

Defaults to state/tmp (scratch), matching the repo rule that raw downloads never land in
state/memes/ or the repo root -- only a cleaned, indexed result belongs in state/memes/.
Sidecar clutter (metadata json, thumbnails, geotags, comments) is disabled.

Uses the instaloader library directly (not the CLI) so --post-filter (arbitrary Python eval)
is not reachable through this script's argument surface.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VENV_PY = REPO / "state" / "instaloader-venv" / "bin" / "python3"

try:
    import instaloader
except ImportError:
    if VENV_PY.exists() and Path(sys.prefix) != VENV_PY.parent.parent:
        os.execv(str(VENV_PY), [str(VENV_PY), str(Path(__file__).resolve())] + sys.argv[1:])
    print("instaloader not installed (expected at state/instaloader-venv)", file=sys.stderr)
    sys.exit(1)

SHORTCODE_RE = re.compile(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")


def extract_shortcode(raw: str) -> str:
    m = SHORTCODE_RE.search(raw)
    if m:
        return m.group(1)
    cleaned = raw.strip().strip("/")
    if re.fullmatch(r"[A-Za-z0-9_-]+", cleaned):
        return cleaned
    print(f"Could not parse a post shortcode from: {raw}", file=sys.stderr)
    sys.exit(2)


def main():
    p = argparse.ArgumentParser(description="Download one public Instagram post/reel (no login)")
    p.add_argument("target", help="Post/reel URL or bare shortcode")
    p.add_argument("-o", "--out-dir", default=None, help="Output directory (default: state/tmp)")
    p.add_argument("--json", action="store_true", help="Print raw JSON instead of plain lines")
    args = p.parse_args()

    shortcode = extract_shortcode(args.target)
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else (REPO / "state" / "tmp")
    out_dir.mkdir(parents=True, exist_ok=True)

    L = instaloader.Instaloader(
        quiet=True,
        dirname_pattern=str(out_dir),
        filename_pattern="{shortcode}",
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        post_metadata_txt_pattern="",
    )

    try:
        post = instaloader.Post.from_shortcode(L.context, shortcode)
    except instaloader.exceptions.BadResponseException as e:
        print(f"Post not reachable anonymously (deleted, private, or blocked): {e}", file=sys.stderr)
        sys.exit(3)
    except instaloader.exceptions.ConnectionException as e:
        print(f"Instagram refused the request (rate limit or anonymous access blocked): {e}", file=sys.stderr)
        sys.exit(3)

    try:
        L.download_post(post, target=Path(out_dir).name)
    except instaloader.exceptions.ConnectionException as e:
        print(f"Download failed: {e}", file=sys.stderr)
        sys.exit(3)

    # Glob by shortcode rather than diffing the directory: instaloader silently skips a file
    # it has already downloaded, so a before/after diff comes back empty on re-runs and the
    # caller wrongly concludes there is no media.
    MEDIA_EXT = {".mp4", ".jpg", ".jpeg", ".png", ".webp"}
    media = sorted(
        f for f in out_dir.glob(f"{shortcode}*")
        if f.is_file() and f.suffix.lower() in MEDIA_EXT
    )
    # Prefer video when both a video and its poster frame landed.
    if any(f.suffix.lower() == ".mp4" for f in media):
        media = [f for f in media if f.suffix.lower() == ".mp4"]

    caption = (post.caption or "").replace("\n", " ").strip()
    info = {
        "shortcode": post.shortcode,
        "owner": post.owner_username,
        "type": "video" if post.is_video else "image",
        "duration": round(post.video_duration, 1) if (post.is_video and getattr(post, "video_duration", None)) else None,
        "caption": caption,
        "files": [str(f) for f in media],
    }

    if args.json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
    else:
        for k in ("shortcode", "owner", "type"):
            print(f"{k}: {info[k]}")
        if info["duration"]:
            print(f"duration: {info['duration']}s")
        if caption:
            print(f"caption: {caption[:300]}")
        for f in info["files"]:
            print(f"file: {f}")

    if not media:
        print("WARNING: no media file detected in output dir", file=sys.stderr)


if __name__ == "__main__":
    main()
