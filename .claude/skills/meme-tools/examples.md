# Meme Tools Examples

## Example 1: Search for a meme

**User Input**: "Find me a funny video about cats"

**Workflow**:
```bash
scripts/search_gist_memes.py "cat"
```

**Output**:
```
[042] My cat is crazy
    https://youtube.com/watch?v=DXCsiSfg-ms
```

## Example 2: Convert WebM to MP4

**User Input**: "Convert this video to MP4"

**Workflow**:
```bash
scripts/convert_to_mp4.py Flutterbye_fairy.webm -o output.mp4 -q medium
```

**Output**:
```
Converting Flutterbye_fairy.webm to MP4 (medium)...
✓ Converted: output.mp4 (2.5MB)
```

## Example 3: Search and get random meme

**User Input**: "Send me a random funny video"

**Workflow**:
```bash
scripts/search_gist_memes.py "funny" --random
```

**Output**:
```
[015] Flutterbye fairy toy flies into fire O'Fortuna
    https://youtube.com/watch?v=GzgavGowD_A
```

## Example 4: Complete workflow (search → download → convert → send)

**User Input**: "Search for cinnamon video and send to chat"

**Workflow**:
```bash
scripts/fetch_and_send_meme.py "cinnamon"
```

**Steps**:
1. Searches Gist for matching video
2. Downloads using yt-dlp to state/memes
3. Converts to MP4 if needed
4. Outputs JSON with file path ready to send

**Output**:
```json
{
  "title": "HERE I COME I AM CINNAMON",
  "url": "https://youtube.com/watch?v=AZdgxWV4SgU",
  "file": "./state/memes/HERE_I_COME_I_AM_CINNAMON.mp4",
  "ready": true
}
```

Then send via WhatsApp:
```bash
wa_send_video to=4917012345678@s.whatsapp.net path=./state/memes/HERE_I_COME_I_AM_CINNAMON.mp4
```

## Example 5: Search with specific quality

**User Input**: "Get a low-quality version of that video for quick send"

**Workflow**:
```bash
scripts/fetch_and_send_meme.py "keyword" --quality low
```

Quality options:
- `low`: 480p, 1000kbps (smallest file)
- `medium`: 720p, 2500kbps (default)
- `high`: 1080p, 5000kbps (best quality)

## Example 6: Get search results as JSON

**User Input**: "Search for all videos related to yee"

**Workflow**:
```bash
scripts/search_gist_memes.py "yee" --limit 10 --json
```

**Output**:
```json
[
  {
    "index": "001",
    "title": "Yee",
    "url": "https://youtube.com/watch?v=q6EoRBvdVPQ"
  },
  {
    "index": "010",
    "title": "It's The Most Wonderful Time Of The Yee",
    "url": "https://youtube.com/watch?v=v3i8vsIUA7Q"
  }
]
```

Use this JSON output to programmatically select or display options.

## Safety Notes

All scripts:
- ✅ Validate all inputs (URLs, file paths, keywords)
- ✅ Use subprocess with explicit argument lists (no shell injection)
- ✅ Confine files to `state/memes` directory
- ✅ Handle network errors gracefully
- ✅ Never execute untrusted code
- ✅ Log operations to stderr for debugging
