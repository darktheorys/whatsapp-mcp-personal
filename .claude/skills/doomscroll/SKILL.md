---
name: doomscroll
description: Pull fresh items from public RSS/Atom feeds (Reddit subs, Hacker News, YouTube channels) to autonomously discover content rather than waiting for links. Use when asked to find something fresh/trending, hunt for new meme material, or check what a community is posting right now.
---

# Doomscroll (public feeds)

Autonomous discovery over feeds that actually permit unauthenticated reads. Stdlib only, no
dependencies, read-only GETs.

## Why RSS and not the obvious platforms

Measured 2026-09-14, not assumed:

| Source | Result |
|---|---|
| Reddit **RSS** (`/.rss`) | **200, works** |
| Reddit JSON (`/.json`, `api.reddit.com`) | 403 block page |
| Hacker News RSS | **200, works** |
| YouTube channel RSS | works (`yt:<channel_id>`) |
| Instagram profile/feed | 401, anonymous access refused |
| Instagram audio-cluster listing | 200 but returns the HTML app shell, zero reel data |

**Instagram has no anonymous discovery path via HTTP** -- but it does via a real browser.
Corrected 2026-09-14 after testing with Playwright:

- **Raw HTTP**: dead. A post fetched by shortcode exposes 95 fields, none pointing at another
  post (`clips_metadata` is only audio attribution). Cookie-bootstrapped curl still 302s.
- **Real browser**: works. Opening a reel URL and pressing ArrowDown genuinely advances the
  URL to new shortcodes (measured: `DdKCEQnhzAW` -> `Dc_wuKehJVY` -> ... -> `Dc3JobMOQyv`).
  Instagram preloads ~4 video elements ahead.
- **Ceiling: 6 reels.** Then a "See what you're missing" modal appears whose only controls are
  Sign up / Log in -- no close button, no dismiss affordance. That is a deliberate hard gate,
  so it is where anonymous browsing legitimately ends. Do not JS-remove it or cycle sessions to
  reset the counter; that is circumventing an access control, not browsing.

## Usage

```bash
.claude/skills/doomscroll/scripts/scroll.py kgbtr --limit 10
.claude/skills/doomscroll/scripts/scroll.py kgbtr hn --limit 5      # several at once
.claude/skills/doomscroll/scripts/scroll.py reddit:Turkiye --json
.claude/skills/doomscroll/scripts/scroll.py yt:UCxxxxxxxx           # a YouTube channel
.claude/skills/doomscroll/scripts/scroll.py "https://example.com/feed.xml"
```

Presets: `kgbtr`, `turkey`, `turkiye`, `hn`. Anything else via `reddit:<sub>`, `yt:<channel_id>`,
or a raw feed URL.

Parses both Atom (Reddit, YouTube) and RSS 2.0 (Hacker News) with stdlib `xml.etree`.

## Rate limiting

Reddit 429s on rapid successive feed pulls -- confirmed by getting a 429 on a second feed
requested immediately after a successful one. The script sleeps 2s between sources and backs
off on 429 with up to 2 retries. Don't remove those delays; a burst gets the IP throttled and
then *every* feed returns nothing.

## Feeding the meme pipeline

Discovery -> content, chained with the existing skills:

1. `scroll.py kgbtr --limit 15` -- see what the sub is posting now.
2. Pick something promising; Reddit links often point at v.redd.it / YouTube / imgur.
3. `yt-dlp` skill's `download_video.py` to fetch, `watch_video.py` to actually view it
   (pass `--out-dir` inside the repo, or the frames are unreadable).
4. Trim, convert, index into `state/memes/description.md` per the meme-tools skill.

## Limits

- Titles and links only. RSS gives no media, no comments, no scores -- fetch the link for those.
- Reddit RSS returns hot-sorted items, not a personalized feed. There is no algorithm here,
  which is the point: it is reproducible and needs no account.
