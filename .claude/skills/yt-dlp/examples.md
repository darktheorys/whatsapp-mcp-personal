# yt-dlp Skill Examples

## Example 1: Download a YouTube Video

**User Input**: "Download this video <https://www.youtube.com/watch?v=dQw4w9WgXcQ>"

**Skill Response**:

```text
I'll download this video for you at best quality by default.
[Running download_video.py with the URL]

Video downloaded successfully: The_File_Name.mp4
Location: /current/directory/The_File_Name.mp4
```

## Example 2: Download at Specific Quality

**User Input**: "Can you download this in 720p? <https://youtu.be/abc123>"

**Skill Response**:

```text
I'll download the video at 720p quality.
[Running download_video.py with --quality 720p]

Video downloaded successfully: Video_Title.mp4
```

## Example 3: Extract Audio Only

**User Input**: "Extract the audio from <https://twitter.com/user/status/123456789>"

**Skill Response**:

```text
I'll extract the audio from this tweet in MP3 format.
[Running extract_audio.py with the URL]

Audio extracted successfully: Tweet_Audio_Title.mp3
```

## Example 4: Auto-detect Video URLs

**Conversation Excerpt**:

```text
User: "I found a really interesting talk on Vimeo: https://vimeo.com/123456789. Also, there's a good tutorial on YouTube: https://www.youtube.com/watch?v=def456"

Skill detects two video URLs and asks:
"I found 2 video URLs in this conversation:
1. https://vimeo.com/123456789
2. https://www.youtube.com/watch?v=def456

Would you like me to download them? [Yes/No/Select specific ones]"

If user confirms:
- Download both videos
- Report success with file locations
```

## Example 5: Multiple URLs with Quality Preference

**User Input**: "Download these videos at 1080p:

- <https://youtube.com/watch?v=video1>
- <https://youtube.com/watch?v=video2>"

**Skill Response**:

```text
I'll download both videos at 1080p quality.
[Running download_video.py for each URL with --quality 1080p]

Videos downloaded:
1. Video1_Title.mp4
2. Video2_Title.mp4
```

## Example 6: Download Failed

**User Input**: "Download <https://private-video.com/abc123>"

**Skill Response**:

```text
I encountered an issue downloading the video. The URL may be:
- Private or requiring authentication
- From an unsupported platform
- No longer available

Error: [specific error message from yt-dlp]
```

## Example 7: Audio Extraction with Custom Format

**User Input**: "Extract this video's audio as FLAC: <https://www.youtube.com/watch?v=hi-def-audio>"

**Skill Response**:

```text
I'll extract the audio in FLAC format (lossless quality).
[Running extract_audio.py with --format flac]

Audio extracted successfully: The_Title.flac
```

## Example 8: URL Extraction from File

**User Input**: "I have a text file with a bunch of video links. Can you download them?"

**Skill Workflow**:

```text
1. Ask user for the file path
2. Use extract_urls.py to extract all video URLs from the file
3. List found URLs and ask for confirmation
4. Download confirmed videos
5. Provide status report for each download
```

## Example 9: Send Video + Audio to WhatsApp

**User Input**: "search for kolpacino video and send to chat"

**Skill Workflow**:

```text
1. Search for videos: yt-dlp "ytsearch:kolpacino" --print "%(title)s - %(duration)ds - https://youtu.be/%(id)s"
   → Found: "Kolpaçino - eliminen dayı eliminen - 17s - https://youtu.be/e6c_GaZGzMA"

2. Download to state/memes:
   scripts/download_video.py "https://youtu.be/e6c_GaZGzMA" -o state/memes
   → Creates: Kolpaçino - eliminen dayı eliminen.webm

3. Convert WebM to MP4 (WhatsApp compatibility):
   ffmpeg -i input.webm -c:v libx264 -c:a aac output.mp4

4. Extract audio:
   scripts/extract_audio.py "https://youtu.be/e6c_GaZGzMA" -o state/memes
   → Creates: Kolpaçino - eliminen dayı eliminen.mp3

5. Send to WhatsApp:
   - wa_send_text_only: metadata + link + duration
   - wa_send_video: the MP4 file with caption
   - wa_send_audio: the MP3 file
```
