#!/usr/bin/env python3
"""
Searches YouTube directly via yt-dlp's ytsearch pseudo-URL (no download, no API key) and returns
structured results: title, url, duration, uploader, view count. Complements WebSearch -- a general
web search often surfaces blog posts *about* a video rather than the video listing itself, while
this queries YouTube's own search the way the site would.
"""

import argparse
import json
import subprocess
import sys


def search(query, limit):
    cmd = [
        "yt-dlp",
        f"ytsearch{limit}:{query}",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print(f"Search failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    entries = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        entries.append(
            {
                "title": data.get("title"),
                "url": data.get("url")
                or data.get("webpage_url")
                or f"https://www.youtube.com/watch?v={data.get('id')}",
                "duration": data.get("duration"),
                "uploader": data.get("uploader") or data.get("channel"),
                "view_count": data.get("view_count"),
            }
        )
    return entries


def format_duration(seconds):
    if seconds is None:
        return "?"
    seconds = int(seconds)
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def main():
    parser = argparse.ArgumentParser(
        description="Search YouTube via yt-dlp (no download)"
    )
    parser.add_argument("query", help="Search query")
    parser.add_argument(
        "--limit", type=int, default=10, help="Max results (default: 10)"
    )
    parser.add_argument(
        "--json", action="store_true", help="Print raw JSON instead of a formatted list"
    )
    args = parser.parse_args()

    entries = search(args.query, args.limit)

    if args.json:
        print(json.dumps(entries, indent=2))
        return

    if not entries:
        print("No results found.")
        return

    for i, e in enumerate(entries, 1):
        views = f"{e['view_count']:,} views" if e["view_count"] else "? views"
        print(f"{i}. {e['title']}")
        print(
            f"   {e['url']}  [{format_duration(e['duration'])}]  {e['uploader']}  ({views})"
        )


if __name__ == "__main__":
    main()
