#!/usr/bin/env python3
"""
Search meme collection Gist for videos by keyword.
"""

import argparse
import sys
import subprocess
import json
import random

GIST_URL = "https://gist.githubusercontent.com/jcahill/e42b20f91fd0f82fd7023ad7ddc6146c/raw/0d8b627d629e9ab75a3690e48a7d439bb980a663/important%2520videos.md"


def fetch_gist():
    """Fetch meme collection from Gist."""
    try:
        result = subprocess.run(
            ["curl", "-s", GIST_URL],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            print("Error: Failed to fetch Gist", file=sys.stderr)
            return None
        return result.stdout
    except subprocess.TimeoutExpired:
        print("Error: Gist fetch timed out", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None


def parse_gist(content):
    """Parse Gist markdown table to extract videos."""
    videos = []
    for line in content.split('\n'):
        if '|' in line and 'youtube.com' in line:
            parts = [p.strip() for p in line.split('|')]
            if len(parts) >= 5:
                try:
                    index = parts[2]
                    title = parts[3]
                    url = parts[4]
                    if url.startswith('http'):
                        videos.append({
                            'index': index,
                            'title': title,
                            'url': url
                        })
                except (IndexError, ValueError):
                    pass
    return videos


def search_videos(videos, keyword):
    """Search videos by keyword (case-insensitive)."""
    keyword_lower = keyword.lower()
    matches = [v for v in videos if keyword_lower in v['title'].lower()]
    return matches


def format_results(results, limit=None):
    """Format search results for display."""
    if not results:
        print("No videos found matching that keyword.")
        return

    if limit:
        results = results[:limit]

    for video in results:
        print(f"[{video['index']}] {video['title']}")
        print(f"    {video['url']}\n")


def main():
    parser = argparse.ArgumentParser(description="Search meme video collection")
    parser.add_argument("keyword", help="Keyword to search for")
    parser.add_argument("--random", action="store_true", help="Return random match")
    parser.add_argument("--limit", type=int, default=5, help="Number of results (default: 5)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    # Fetch Gist
    print(f"Searching meme collection for: {args.keyword}", file=sys.stderr)
    content = fetch_gist()
    if not content:
        sys.exit(1)

    # Parse and search
    videos = parse_gist(content)
    matches = search_videos(videos, args.keyword)

    if not matches:
        print("No videos found.")
        sys.exit(1)

    # Handle random
    if args.random:
        matches = [random.choice(matches)]

    # Output
    if args.json:
        print(json.dumps(matches[:args.limit], indent=2))
    else:
        format_results(matches, args.limit)


if __name__ == "__main__":
    main()
