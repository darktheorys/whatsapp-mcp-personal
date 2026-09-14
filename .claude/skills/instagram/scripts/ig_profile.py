#!/usr/bin/env python3
"""
Print public metadata for one Instagram profile. No login, no credentials, no download.

Uses the instaloader *library* directly rather than shelling out to the `instaloader` CLI:
the CLI exposes --post-filter / --storyitem-filter, which eval arbitrary Python expressions,
so a trailing-wildcard allowlist over the raw binary would be a code-execution hole (same
lesson as yt-dlp's --exec). This script's argument surface cannot express those flags.
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VENV_PY = REPO / "state" / "instaloader-venv" / "bin" / "python3"

try:
    import instaloader
except ImportError:
    if VENV_PY.exists() and Path(sys.prefix) != VENV_PY.parent.parent:
        os.execv(str(VENV_PY), [str(VENV_PY), str(Path(__file__).resolve())] + sys.argv[1:])
    print("instaloader not installed (expected at state/instaloader-venv)", file=sys.stderr)
    sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="Print public Instagram profile metadata (no login, no download)")
    p.add_argument("username", help="Instagram username, with or without leading @")
    p.add_argument("--json", action="store_true", help="Print raw JSON instead of plain lines")
    args = p.parse_args()

    username = args.username.lstrip("@").strip("/").split("/")[-1]

    L = instaloader.Instaloader(quiet=True)
    try:
        prof = instaloader.Profile.from_username(L.context, username)
    except instaloader.exceptions.ProfileNotExistsException:
        print(f"No such profile: {username}", file=sys.stderr)
        sys.exit(2)
    except instaloader.exceptions.ConnectionException as e:
        print(f"Instagram refused the request (rate limit or anonymous access blocked): {e}", file=sys.stderr)
        sys.exit(3)

    info = {
        "username": prof.username,
        "full_name": prof.full_name,
        "biography": prof.biography,
        "followers": prof.followers,
        "following": prof.followees,
        "posts": prof.mediacount,
        "is_private": prof.is_private,
        "is_verified": prof.is_verified,
        "external_url": prof.external_url,
    }

    if args.json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
    else:
        for k, v in info.items():
            print(f"{k}: {v}")
        if prof.is_private:
            print("\nNOTE: profile is private -- posts are not retrievable without an approved follower login.", file=sys.stderr)


if __name__ == "__main__":
    main()
