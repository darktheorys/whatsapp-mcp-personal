---
name: instagram
description: Watch and download public Instagram reels/posts anonymously via Instaloader - samples frames and transcribes audio so reel content can actually be reviewed. Use whenever an Instagram post/reel link appears in a chat and its content matters, for the meme pipeline, or when asked about Instagram integration. No login, no credentials, no account required.
---

# Instagram (Instaloader)

Anonymous, credential-free access to **public** Instagram content. There is no account, no
session, no stored login — so there is nothing to get banned, and nothing is attributed to
the repo owner (this setup deliberately has no Instagram account).

Backed by `instaloader` 4.15.3 in `state/instaloader-venv/`. The scripts import the instaloader
**library** directly rather than shelling out to the `instaloader` CLI, because that CLI exposes
`--post-filter` / `--storyitem-filter`, which evaluate arbitrary Python expressions — a
trailing-wildcard allowlist over the raw binary would be a code-execution hole, exactly the
lesson learned from yt-dlp's `--exec`. These scripts' argument surfaces cannot express those flags.

## Setup (once per clone)

`state/` is gitignored, so a fresh clone has no venv and every script exits with
"instaloader not installed". Create it:

```bash
python3 -m venv state/instaloader-venv
state/instaloader-venv/bin/pip install instaloader
```

The scripts locate that venv relative to their own file and re-exec into it automatically, so
nothing needs activating and no path needs editing.

## What actually works (tested 2026-09-14)

| Script | Status | Notes |
|---|---|---|
| `ig_watch.py` | **works** | Download **and watch** a reel: frames + whisper transcript |
| `ig_download.py` | **works** | Just fetch the media, no frame sampling |
| `ig_posts.py` | **blocked** | Instagram 401s anonymous profile queries |
| `ig_profile.py` | **blocked** | Same endpoint, same 401 |

Instagram's `api/v1/users/web_profile_info/` endpoint now rejects anonymous requests with
`401 - "Please wait a few minutes before you try again."` — verified against two different
public institutional accounts (`nasa`, `natgeo`) on a fresh install, so this is a standing
auth requirement, not a transient rate limit on this machine. **Anonymous profile browsing
and post-listing are not available.** The two scripts are kept because they fail cleanly with
an explicit message and may work from a different IP or if Meta relaxes the endpoint, but do
not plan around them.

Single-post fetch by shortcode uses a different endpoint and is unaffected.

## Usage

```bash
# WATCH a reel: download + sample frames + transcribe audio (the main entry point)
.claude/skills/instagram/scripts/ig_watch.py "https://www.instagram.com/reel/SHORTCODE/"
.claude/skills/instagram/scripts/ig_watch.py SHORTCODE --fps 0.5   # fewer frames, long reels

# Just fetch the media, no watching
.claude/skills/instagram/scripts/ig_download.py "https://www.instagram.com/reel/SHORTCODE/"
.claude/skills/instagram/scripts/ig_download.py SHORTCODE --json -o /some/dir
```

`ig_watch.py` emits one JSON blob: `owner`, `caption`, `video`, `first_frame`, `contact_sheet`,
`transcript`, `frames[]`. **Read `first_frame` for a quick sanity check, then `contact_sheet` to
see the whole reel at once** — only open individual `frames[]` to inspect one moment closely.
Transcript is whisper output and comes back empty for music-only reels, which is normal.

Frames are written to `state/tmp/watch-<shortcode>/`, deliberately **not** a system temp dir:
`watch_video.py` defaults to `tempfile.mkdtemp()`, which lands outside the repo where the
deny-outside-repo hook blocks reads — so the frames would be unreadable, defeating the point.

`ig_download.py` disables sidecar clutter (metadata json, thumbnails, geotags, comments), so only
the media file lands on disk. It globs output by shortcode rather than diffing the directory,
because instaloader silently skips an already-downloaded file and a diff comes back empty on re-runs.

Invoke scripts **by path**, never prefixed with `python3 ` — the allowlist pattern in
`.claude/settings.json` matches the literal command prefix, and `python3 <path>` does not match.

## Where downloads go

Defaults to `state/tmp/` (gitignored scratch), never `state/memes/` or the repo root. Only a
cleaned, verified, indexed result belongs in `state/memes/` — see the meme-tools skill and
`state/memes/description.md`.

## Relationship to yt-dlp

`yt-dlp` also downloads Instagram reels and is already wired into this repo. `ig_download.py`
overlaps with it; what it adds is caption + owner metadata in the same call. If `ig_download.py`
fails on a given link, try the yt-dlp skill's `download_video.py` as a fallback and vice versa —
they hit Instagram through different code paths.

## Hard limits (do not try to route around these)

- **Private profiles**: unreachable. They require an approved follower login, which this tool
  deliberately does not do.
- **Stories**: not accessible anonymously. Viewing a story requires a logged-in session, and
  Instagram always attributes the view to that account — there is no anonymous story read.
  Do not build or run a workaround for view-tracking; that is circumventing platform mechanics.
- **Feed discovery over HTTP**: not exposed by any endpoint here, and Meta does not expose it
  officially either. A *real browser* is different -- Playwright testing (2026-09-14) showed
  ArrowDown does advance through reels anonymously, but only **6 deep** before a Sign up / Log in
  modal with no dismiss control. See the doomscroll skill for the measurements. Logging in was
  considered and rejected (2026-09-14): it makes every view attributable to the account and carries
  automation-ban risk, which defeats the point of an anonymous tool. Don't re-litigate this unless
  the owner raises it.

## The realistic reel-watching workflow

Discovery is the missing half, not playback. Watching any **given** reel works fully (see
`ig_watch.py`); what cannot be done is *finding* reels without a link. In practice that is fine,
because links arrive constantly in chat — people paste Instagram/X links all day. The working
loop is:

1. Someone drops a reel link in a chat.
2. `ig_watch.py <link>` -> frames + transcript.
3. Read `contact_sheet`, react to what is actually in the reel rather than guessing from the caption.
4. If it is meme-worthy, convert/trim and index it per the meme-tools skill.

This also replaces the old habit of asking "what is in this video?" -- just watch it.
