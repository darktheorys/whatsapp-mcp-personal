---
name: yt-dlp
description: Download videos and extract audio from various platforms using yt-dlp. Use when user provides a video URL, asks to download a video, or when conversation contains video links from YouTube, Twitter/X, Vimeo, TikTok, Instagram, etc.
---

# yt-dlp Video Downloader Skill

This skill provides tools for downloading videos and extracting audio from various platforms using yt-dlp.

## Features

- Download videos from multiple platforms (YouTube, Twitter/X, Vimeo, TikTok, Instagram, Facebook, etc.)
- Extract audio from videos
- Auto-detect video URLs in conversations
- Support for different quality settings and formats

## Usage Patterns

### 1. Command-based Download

When user explicitly asks to download a video:

```
User: Download this video https://youtube.com/watch?v=...
```

**Action**: Extract URL and call download script

### 2. Auto-detection in Conversations

When conversation contains video URLs:

```
User: Check out this video https://twitter.com/... and let me know what you think
```

**Action**: Detect video URL, ask user if they want to download it

### 3. Audio Extraction

When user wants to extract audio only:

```
User: Extract the audio from https://youtu.be/...
```

**Action**: Use audio extraction script

## Available Scripts

Note: Scripts are located in the `scripts/` directory

### download_video.py

Main video downloader with quality and format options.

**Usage**:

```bash
# Download video
scripts/download_video.py <url> -o <output_dir>

# Download with specific quality
scripts/download_video.py <url> --quality 720p
scripts/download_video.py <url> --quality audio  # For audio only

# Custom format selector
scripts/download_video.py <url> --format "bestvideo[height<=1080]+bestaudio/best"

# Extract info only
scripts/download_video.py <url> --info-only
```

**Quality options**: `best`, `1080p`, `720p`, `480p`, `audio`

### extract_audio.py

Extract audio from videos in various formats.

**Usage**:

```bash
# Extract as MP3 (default)
/scripts/extract_audio.py <url> -o <output_dir>

# Extract as M4A
/scripts/extract_audio.py <url> --format m4a

# Custom quality
/scripts/extract_audio.py <url> --quality 320
```

**Formats**: `mp3`, `m4a`, `opus`, `flac`, `wav`

### extract_urls.py

Extract video URLs from text or files.

**Usage**:

```bash
# Extract from text argument
/scripts/extract_urls.py "Check https://youtube.com/watch?v=..."

# Extract from file
/scripts/extract_urls.py <file_path>

# Read from stdin
cat file.txt | /scripts/extract_urls.py
```

### search_videos.py

Search YouTube directly via yt-dlp's `ytsearch` (no API key, no download) — title, url, duration,
uploader, view count per hit. Prefer this over `WebSearch` once the target is known to be a
YouTube video: duration is visible up front, so filtering for a short clip doesn't require
downloading a candidate first.

**Usage**:

```bash
scripts/search_videos.py "query" --limit 10
scripts/search_videos.py "query" --json  # structured output
```

### watch_video.py

Samples frames + a transcript from a downloaded video so its content can be checked before
sending, rather than guessed from the filename/title. See the README's "Watching a downloaded
video before sending it" section for the full behavior (frame sampling, subsampling for long
clips, the `first_frame` → `contact_sheet` → `frames[]` read order).

**Usage**:

```bash
scripts/watch_video.py <path> [--fps 1] [--out-dir DIR]
```

## Video Platform Support

The skill recognizes URLs from:

- YouTube (youtube.com, youtu.be)
- Twitter/X (twitter.com, x.com)
- Vimeo (vimeo.com)
- TikTok (tiktok.com)
- Instagram (instagram.com)
- Facebook (facebook.com, fb.watch)
- Twitch (twitch.tv, clips.twitch.tv)
- Dailymotion (dailymotion.com)
- Reddit (reddit.com)
- Streamable (streamable.com)
- And many more supported by yt-dlp

## Workflow

### When User Provides Video URL

1. Extract URL from user's input using `extract_urls.py`
2. Confirm with user what action to take:
   - Download video
   - Extract audio
   - Show video info
3. Execute appropriate script based on user's choice
4. Notify user of success/failure and file location

### When Auto-detecting URLs

1. Scan conversation text with `extract_urls.py` (can process stdin)
2. If video URLs found, ask user: "I found video URLs in this conversation. Would you like me to download them?"
3. If yes, proceed with download workflow
4. If no, continue with conversation

### Handling Multiple URLs

- For single URL: Direct download
- For multiple URLs: Ask user if they want to download all or select specific ones
- Provide option to download as playlist if URLs are from the same source

### YouTube to WhatsApp Workflow

The repo README's "YouTube / video tools" and "Meme Tools" → "When the Gist has no match" sections
are the source of truth for this workflow — read those first if this file and the README disagree,
the README wins (this file gets stale faster). Summary, kept in sync as of 2026-08-16:

1. **Search for a video** — prefer the dedicated script over hand-rolling the `ytsearch:` call:

   ```bash
   scripts/search_videos.py "query" --limit 5
   ```

   Structured output (title/url/duration/uploader/views), no download, no API key. Check duration
   here before committing to a download — catches a 6-minute compilation when a short clip was
   wanted, cheaply. `WebSearch` is still the better first move for a scene/quote that might not
   even be on YouTube (TikTok reposts, etc.).

2. **Download raw footage into `state/tmp/`, never `state/memes/` and never the repo root**:

   ```bash
   scripts/download_video.py <url> -o /path/to/repo/state/tmp -q 480p
   ```

   `-q 480p` avoids a 403 the unconstrained "best" format selector can hit on some URLs — if it
   still 403s, try `-f "best[height<=480]"` instead. **Check the video's title first**
   (`yt-dlp --print title <url>`) if it might contain a URL itself (some reposted/aggregator
   uploads title the video as its own source link) — the `%(title)s` output template turns
   slashes in the title into literal nested directories otherwise.

3. **Convert to MP4 and place the finished file in `state/memes/`** (the only sendable directory,
   besides the session scratchpad) — use the meme-tools skill's converter, not a hand-rolled
   `ffmpeg` call:

   ```bash
   ../meme-tools/scripts/convert_to_mp4.py state/tmp/<downloaded>.webm -o state/memes/<name>.mp4
   ```

   Then `rm -rf state/tmp/*` to clear the raw download and its `.info.json`/`.webp` sidecars.

4. **Watch it before sending**, if the content isn't already known/confirmed:

   ```bash
   scripts/watch_video.py state/memes/<name>.mp4
   ```

   Read `first_frame` first (catches a bad source — bootleg screen recording, wrong scene, ad
   overlay — cheaply), then `contact_sheet` for the whole flow in one image, only falling back to
   individual `frames[]` for a specific moment. Don't skip this for anything going to someone other
   than the owner.

5. **Send to WhatsApp**:
   - **`wa_send_video`** → the finished file in `state/memes/`, with a caption.
   - **`wa_send_text_only`** → link/metadata/transcript as text, if the chat is voice-only and the
     info is more useful read than heard (structured data doesn't survive TTS well).

6. **Add it to `state/memes/description.md`** once confirmed — what it shows, when to send it —
   so a future request for the same meme never needs re-searching, re-downloading, or
   re-`watch_video`-ing it.

## Quality and Format Selection

When user doesn't specify preferences:

- Default to best available quality
- For audio: Default to MP3 at 192kbps

When options needed:

```bash
# Ask user for quality preference if not specified
# Options: best (default), 1080p, 720p, 480p, audio

# Ask for format if extracting audio
# Options: mp3 (default), m4a, opus, flac, wav
```

## Error Handling

Common issues and solutions:

1. **yt-dlp not installed**:
   - Check with `yt-dlp --version`
   - Install with `pip install yt-dlp` or `brew install yt-dlp`

2. **ffmpeg not installed** (required for format conversion):
   - Install with `brew install ffmpeg` (macOS)
   - Or `apt install ffmpeg` (Linux)

3. **Video not available**:
   - Check if URL is accessible
   - Some videos may require authentication
   - Age-restricted content may need cookies

4. **Network errors**:
   - Retry download
   - Check internet connection

## Dependencies

- `yt-dlp`: Main video downloader
- `ffmpeg`: Audio/video processing (required for format conversion)
- `python3` with standard library

All scripts are self-contained and use only built-in Python modules.
