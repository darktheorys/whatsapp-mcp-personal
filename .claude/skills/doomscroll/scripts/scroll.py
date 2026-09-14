#!/usr/bin/env python3
"""
Pull fresh items from public RSS/Atom feeds -- the "go out and find something" half that
Instagram cannot provide (it exposes no anonymous listing endpoint; see the instagram skill).

Stdlib only, no new dependencies. Read-only HTTP GETs against public feed URLs.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

UA = "whatsapp-mcp-personal/1.0 (personal feed reader)"
TIMEOUT = 20

PRESETS = {
    "kgbtr":   "https://www.reddit.com/r/KGBTR/hot/.rss",
    "turkey":  "https://www.reddit.com/r/Turkey/hot/.rss",
    "turkiye": "https://www.reddit.com/r/Turkiye/hot/.rss",
    "hn":      "https://news.ycombinator.com/rss",
}

NS = {"atom": "http://www.w3.org/2005/Atom"}


def resolve(source: str) -> str:
    if source in PRESETS:
        return PRESETS[source]
    if source.startswith("reddit:"):
        return f"https://www.reddit.com/r/{source.split(':', 1)[1]}/hot/.rss"
    if source.startswith("yt:"):
        return f"https://www.youtube.com/feeds/videos.xml?channel_id={source.split(':', 1)[1]}"
    if source.startswith(("http://", "https://")):
        return source
    print(f"Unknown source '{source}'. Presets: {', '.join(sorted(PRESETS))}; "
          f"or reddit:<sub>, yt:<channel_id>, or a feed URL.", file=sys.stderr)
    sys.exit(2)


def fetch(url: str, retries: int = 2) -> bytes:
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            # Reddit rate-limits bursts with 429; back off rather than hammering.
            if e.code == 429 and attempt < retries:
                time.sleep(3 * (attempt + 1))
                continue
            print(f"HTTP {e.code} for {url}", file=sys.stderr)
            return b""
        except Exception as e:
            print(f"Failed {url}: {e}", file=sys.stderr)
            return b""
    return b""


def parse(raw: bytes, limit: int):
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        print(f"Feed did not parse as XML (likely a block page): {e}", file=sys.stderr)
        return []

    out = []
    # Atom (Reddit, YouTube)
    for entry in root.findall(".//atom:entry", NS)[:limit]:
        link_el = entry.find("atom:link", NS)
        out.append({
            "title": (entry.findtext("atom:title", "", NS) or "").strip(),
            "link": (link_el.get("href") if link_el is not None else "") or "",
            "date": (entry.findtext("atom:updated", "", NS)
                     or entry.findtext("atom:published", "", NS) or "").strip(),
            "author": (entry.findtext("atom:author/atom:name", "", NS) or "").strip(),
        })
    if out:
        return out

    # RSS 2.0 (Hacker News and most classic feeds)
    for item in root.findall(".//item")[:limit]:
        out.append({
            "title": (item.findtext("title", "") or "").strip(),
            "link": (item.findtext("link", "") or "").strip(),
            "date": (item.findtext("pubDate", "") or "").strip(),
            "author": (item.findtext("author", "") or "").strip(),
        })
    return out


def main():
    p = argparse.ArgumentParser(description="Scroll public RSS/Atom feeds for fresh items")
    p.add_argument("sources", nargs="+",
                   help=f"Presets ({', '.join(sorted(PRESETS))}), reddit:<sub>, yt:<channel_id>, or feed URLs")
    p.add_argument("--limit", type=int, default=10, help="Items per source (default 10)")
    p.add_argument("--json", action="store_true", help="Print raw JSON")
    args = p.parse_args()

    limit = max(1, min(args.limit, 50))
    results = {}
    for i, src in enumerate(args.sources):
        if i:
            time.sleep(2)  # be polite; Reddit 429s on rapid successive feed pulls
        results[src] = parse(fetch(resolve(src)), limit)

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    for src, items in results.items():
        print(f"\n=== {src} ({len(items)}) ===")
        if not items:
            print("  (nothing returned -- blocked, rate limited, or empty)")
        for it in items:
            who = f"  [{it['author']}]" if it["author"] else ""
            print(f"- {it['title'][:100]}{who}")
            print(f"  {it['link']}")


if __name__ == "__main__":
    main()
