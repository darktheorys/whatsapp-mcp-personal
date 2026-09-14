#!/usr/bin/env python3
"""
List recent public posts for an Instagram profile: shortcode, date, likes, type, caption.
No login, no credentials, no media download -- this is the "scan what's there" step before
picking something to fetch with ig_download.py.

Uses the instaloader library directly (not the CLI) so --post-filter (arbitrary Python eval)
is not reachable through this script's argument surface.
"""

import argparse
import json
import os
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

MAX_LIMIT = 50


def main():
    p = argparse.ArgumentParser(description="List recent public Instagram posts (no login, no download)")
    p.add_argument("username", help="Instagram username, with or without leading @")
    p.add_argument("--limit", type=int, default=12, help=f"How many recent posts to list (default 12, max {MAX_LIMIT})")
    p.add_argument("--json", action="store_true", help="Print raw JSON instead of plain lines")
    args = p.parse_args()

    limit = max(1, min(args.limit, MAX_LIMIT))
    username = args.username.lstrip("@").strip("/").split("/")[-1]

    L = instaloader.Instaloader(quiet=True)
    try:
        prof = instaloader.Profile.from_username(L.context, username)
    except instaloader.exceptions.ProfileNotExistsException:
        print(f"No such profile: {username}", file=sys.stderr)
        sys.exit(2)
    except instaloader.exceptions.ConnectionException as e:
        print(f"Instagram refused the request (rate limit or anonymous access blocked): {e}", file=sys.stderr)
        sys.exit(3)

    if prof.is_private:
        print(f"{username} is private -- posts require an approved follower login, which this tool deliberately does not do.", file=sys.stderr)
        sys.exit(4)

    rows = []
    try:
        for i, post in enumerate(prof.get_posts()):
            if i >= limit:
                break
            caption = (post.caption or "").replace("\n", " ").strip()
            rows.append({
                "shortcode": post.shortcode,
                "url": f"https://www.instagram.com/p/{post.shortcode}/",
                "date_utc": post.date_utc.isoformat(),
                "type": "video" if post.is_video else ("carousel" if post.typename == "GraphSidecar" else "image"),
                "likes": post.likes,
                "comments": post.comments,
                "video_duration": getattr(post, "video_duration", None) if post.is_video else None,
                "caption": caption,
            })
    except instaloader.exceptions.ConnectionException as e:
        if not rows:
            print(f"Instagram refused the request (rate limit or anonymous access blocked): {e}", file=sys.stderr)
            sys.exit(3)
        print(f"Stopped early after {len(rows)} posts: {e}", file=sys.stderr)

    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        for r in rows:
            dur = f" {r['video_duration']:.0f}s" if r.get("video_duration") else ""
            cap = r["caption"][:110] + ("..." if len(r["caption"]) > 110 else "")
            print(f"{r['shortcode']}  [{r['type']}{dur}]  {r['date_utc'][:10]}  likes={r['likes']}  {cap}")
            print(f"    {r['url']}")


if __name__ == "__main__":
    main()
