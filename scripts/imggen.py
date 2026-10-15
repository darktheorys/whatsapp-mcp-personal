#!/usr/bin/env python3
"""Local image generation and photo editing for chat requests (Apple Silicon, mflux).

    python3 scripts/imggen.py generate --prompt "a red fez on a desk" --out <scratchpad>/outbox/fez.png
    python3 scripts/imggen.py edit --image <photo> --prompt "make the fez blue" --out <scratchpad>/outbox/fez2.png

generate  Z-Image-Turbo, 4-bit, 8 steps, 768px by default. About 2 minutes on an M1 Pro, 7.6 GB peak.
edit      FLUX.1 Kontext dev, 4-bit, 20 steps. About 11 minutes, 13.8 GB peak. Colour and style changes work
          well, adding new objects is unreliable.

There is no resident service. Each call loads the model (15 to 20 seconds), renders, and exits, so nothing
holds memory between requests. A lock file serialises calls: two image models do not fit next to the voice
service on 32 GB, so a second request waits for the first. The result is written under a session
scratchpad's outbox/ folder, the only scratchpad folder the send tools accept.

The Hugging Face token is read from state/hf-token and passed to the child process through its environment
only. It is never printed or logged. Output goes to state/imggen.log (gitignored), progress bars off.
Prints one JSON line: {"ok": true, "out": ..., "seconds": ...} or {"ok": false, "error": ...}.
"""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[1]
BIN = REPO / "state" / "imggen-venv" / "bin"
TOKEN_FILE = REPO / "state" / "hf-token"
LOCK_FILE = REPO / "state" / "imggen.lock"
LOG_FILE = REPO / "state" / "imggen.log"
TMP_ROOT = Path(f"/private/tmp/claude-{os.getuid()}")


def fail(message, code=1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def check_out(path):
    """The output must land in a session scratchpad's outbox/, the only scratchpad folder a send tool accepts."""
    out = Path(path)
    if out.suffix.lower() != ".png":
        fail("--out must end in .png")
    parent = out.parent.resolve()
    try:
        rel = parent.relative_to(TMP_ROOT.resolve())
    except ValueError:
        fail(f"--out must be under {TMP_ROOT}/<session>/scratchpad/outbox/")
    parts = rel.parts
    if "scratchpad" not in parts or parts[parts.index("scratchpad") + 1 :][:1] != (
        "outbox",
    ):
        fail("--out must be inside a scratchpad outbox/ folder")
    return parent / out.name


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("mode", choices=["generate", "edit"])
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--image", help="source photo for edit")
    p.add_argument(
        "--model",
        choices=["z", "dev"],
        default="z",
        help="generate only: z = Z-Image-Turbo, dev = FLUX.1 dev (about 6 minutes)",
    )
    p.add_argument(
        "--width", type=int, help="default 768 for generate, the source size for edit"
    )
    p.add_argument(
        "--height", type=int, help="default 768 for generate, the source size for edit"
    )
    p.add_argument("--steps", type=int)
    p.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    p.add_argument(
        "--wait",
        type=int,
        default=1800,
        help="seconds to wait for another render to finish",
    )
    a = p.parse_args()

    out = check_out(a.out)
    if not (BIN / "mflux-generate").exists():
        fail(
            "the image venv is missing (state/imggen-venv), see the image-generation skill"
        )
    if not TOKEN_FILE.exists():
        fail("state/hf-token is missing")
    if a.mode == "edit":
        if not a.image or not Path(a.image).is_file():
            fail("edit needs --image pointing at an existing file")

    if a.mode == "generate" and a.model == "dev":
        cmd = [
            str(BIN / "mflux-generate"),
            "--model",
            "dev",
            "-q",
            "4",
            "--prompt",
            a.prompt,
            "--steps",
            str(a.steps or 20),
            "--seed",
            str(a.seed),
            "--width",
            str(a.width or 768),
            "--height",
            str(a.height or 768),
            "--output",
            str(out),
        ]
    elif a.mode == "generate":
        cmd = [
            str(BIN / "mflux-generate-z-image-turbo"),
            "-q",
            "4",
            "--prompt",
            a.prompt,
            "--steps",
            str(a.steps or 8),
            "--seed",
            str(a.seed),
            "--width",
            str(a.width or 768),
            "--height",
            str(a.height or 768),
            "--output",
            str(out),
        ]
    else:
        cmd = [
            str(BIN / "mflux-generate-kontext"),
            "-q",
            "4",
            "--image-path",
            a.image,
            "--prompt",
            a.prompt,
            "--steps",
            str(a.steps or 20),
            "--seed",
            str(a.seed),
            "--output",
            str(out),
        ]
        if a.width:
            cmd += ["--width", str(a.width)]
        if a.height:
            cmd += ["--height", str(a.height)]

    env = dict(os.environ)
    env["HF_TOKEN"] = TOKEN_FILE.read_text().strip()
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_FILE, "w")
    deadline = time.time() + a.wait
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                fail("another image render is still running", code=3)
            time.sleep(5)

    start = time.time()
    with open(LOG_FILE, "ab") as log:
        log.write(f"\n== {time.strftime('%F %T')} {a.mode} seed={a.seed}\n".encode())
        proc = subprocess.run(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
    seconds = round(time.time() - start)
    if proc.returncode != 0 or not out.exists():
        fail(f"the render failed (exit {proc.returncode}), see state/imggen.log")
    print(json.dumps({"ok": True, "out": str(out), "seconds": seconds}))


if __name__ == "__main__":
    main()
