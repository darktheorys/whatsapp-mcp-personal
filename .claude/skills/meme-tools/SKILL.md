---
name: meme-tools
description: Tools for searching, downloading, converting, and sending memes. Use when user asks for memes, wants to send funny videos, or needs to convert video formats.
---

# Meme Tools Skill

Dedicated tools for working with the meme video collection and video format conversions.

## Available Scripts

### search_gist_memes.py

Search the meme collection Gist for videos by keyword.

**Usage**:
```bash
scripts/search_gist_memes.py "keyword"
scripts/search_gist_memes.py "keyword" --random  # Get random match
scripts/search_gist_memes.py "keyword" --limit 5  # Get top 5 matches
```

**Output**: Formatted list with index, title, YouTube link

### convert_to_mp4.py

Convert video files to MP4 format (WhatsApp compatible).

**Usage**:
```bash
scripts/convert_to_mp4.py input.webm
scripts/convert_to_mp4.py input.webm -o output.mp4
scripts/convert_to_mp4.py input.webm --quality high  # Default: medium
```

**Quality options**: `low` (480p), `medium` (720p, default), `high` (1080p)

### fetch_and_send_meme.py

Complete workflow: search → download → convert → send to WhatsApp.

**Usage**:
```bash
scripts/fetch_and_send_meme.py "keyword"
scripts/fetch_and_send_meme.py "keyword" --random
```

**What it does**:
1. Searches Gist for matching video
2. Downloads to `state/memes` using yt-dlp
3. Converts to MP4 if needed
4. Sends to WhatsApp self-chat via `wa_send_video`

## Workflow Examples

### 1. Search for a meme
```
User: Find me a funny video about cats

→ search_gist_memes.py "cat"
→ Returns matching meme entries with links
```

### 2. Convert a video
```
User: Convert this WebM to MP4

→ convert_to_mp4.py input.webm
→ Creates output.mp4 in state/memes
```

### 3. Send random meme
```
User: Send me a random meme

→ fetch_and_send_meme.py --random
→ Searches, downloads, converts, sends automatically
```

## Gist Integration

All tools use the official meme collection Gist:
```
https://gist.githubusercontent.com/jcahill/e42b20f91fd0f82fd7023ad7ddc6146c/raw/...
```

The Gist contains 100+ curated funny videos with YouTube links organized by index.

## Safety & Permissions

All scripts:
- ✅ Validate inputs (URLs, file paths, keywords)
- ✅ Use safe subprocess calls (no shell injection)
- ✅ Require files to be in `state/memes` (sendable directory)
- ✅ Handle errors gracefully with helpful messages
- ✅ Log operations to stderr for debugging

These tools are allowlisted in `.claude/settings.json` to run without permission prompts.
