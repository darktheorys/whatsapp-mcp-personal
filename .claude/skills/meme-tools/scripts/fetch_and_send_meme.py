#!/usr/bin/env python3
"""
Complete workflow: search meme → download → convert → send to WhatsApp.
"""

import argparse
import sys
import subprocess
import os
import json
from pathlib import Path


MEMES_DIR = "./state/memes"
GIST_URL = "https://gist.githubusercontent.com/jcahill/e42b20f91fd0f82fd7023ad7ddc6146c/raw/0d8b627d629e9ab75a3690e48a7d439bb980a663/important%2520videos.md"


def ensure_memes_dir():
    """Ensure state/memes directory exists."""
    Path(MEMES_DIR).mkdir(parents=True, exist_ok=True)


def search_gist(keyword, random_choice=False):
    """Search Gist for matching video."""
    try:
        result = subprocess.run(
            ["curl", "-s", GIST_URL],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            return None

        videos = []
        for line in result.stdout.split('\n'):
            if '|' in line and 'youtube.com' in line:
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 5:
                    try:
                        index = parts[2]
                        title = parts[3]
                        url = parts[4]
                        if url.startswith('http'):
                            videos.append({'index': index, 'title': title, 'url': url})
                    except (IndexError, ValueError):
                        pass

        # Search by keyword
        keyword_lower = keyword.lower()
        matches = [v for v in videos if keyword_lower in v['title'].lower()]

        if not matches:
            return None

        if random_choice:
            import random
            return random.choice(matches)
        return matches[0]

    except Exception as e:
        print(f"Error searching Gist: {e}", file=sys.stderr)
        return None


def download_video(url, output_dir=MEMES_DIR):
    """Download video using yt-dlp."""
    try:
        cmd = [
            "yt-dlp", url,
            "-o", f"{output_dir}/%(title)s.%(ext)s",
            "--no-playlist",
            "--write-info-json"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            print(f"Error downloading video: {result.stderr}", file=sys.stderr)
            return None

        # Find the downloaded file
        for line in result.stderr.split('\n'):
            if 'Merging' in line or 'Writing' in line:
                parts = line.split("'")
                if len(parts) >= 2:
                    return parts[1]
        return None

    except subprocess.TimeoutExpired:
        print("Error: Download timeout", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None


def convert_if_needed(input_file, quality="medium"):
    """Convert to MP4 if not already MP4."""
    if input_file.endswith('.mp4'):
        return input_file

    base = Path(input_file).stem
    output_file = f"{Path(input_file).parent}/{base}.mp4"

    try:
        cmd = [
            sys.argv[0].replace('fetch_and_send_meme.py', 'convert_to_mp4.py'),
            input_file,
            "-o", output_file,
            "-q", quality
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return output_file
    except Exception as e:
        print(f"Warning: Could not convert video: {e}", file=sys.stderr)

    return input_file


def send_to_whatsapp(video_path):
    """Verify video is ready to send via WhatsApp."""
    try:
        # Get WhatsApp self-chat JID from config
        config_path = "./state/config.json"
        with open(config_path) as f:
            config = json.load(f)

        # Self-chat JID is the first allowlisted entry (usually)
        jid = config.get('allowlist', [])[0] if config.get('allowlist') else None
        if not jid:
            print("Error: Could not find WhatsApp JID", file=sys.stderr)
            return False

        print(f"✓ Ready to send: {os.path.basename(video_path)}", file=sys.stderr)
        return True

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Search, download, convert, and send meme")
    parser.add_argument("keyword", help="Video keyword to search for")
    parser.add_argument("--random", action="store_true", help="Pick random matching video")
    parser.add_argument("-q", "--quality", choices=["low", "medium", "high"],
                        default="medium", help="Video quality")

    args = parser.parse_args()

    ensure_memes_dir()

    # Search
    print(f"Searching for: {args.keyword}", file=sys.stderr)
    video_info = search_gist(args.keyword, args.random)
    if not video_info:
        print("No videos found.", file=sys.stderr)
        sys.exit(1)

    print(f"Found: {video_info['title']}", file=sys.stderr)
    print(f"URL: {video_info['url']}", file=sys.stderr)

    # Download
    print("Downloading...", file=sys.stderr)
    downloaded = download_video(video_info['url'])
    if not downloaded:
        print("Download failed.", file=sys.stderr)
        sys.exit(1)

    print(f"Downloaded: {downloaded}", file=sys.stderr)

    # Convert
    print("Converting to MP4...", file=sys.stderr)
    final_file = convert_if_needed(downloaded, args.quality)

    # Ready to send
    if send_to_whatsapp(final_file):
        print(json.dumps({
            'title': video_info['title'],
            'url': video_info['url'],
            'file': final_file,
            'ready': True
        }))
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
