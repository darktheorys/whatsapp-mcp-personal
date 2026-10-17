#!/usr/bin/env python3
"""Local text-to-video and image-to-video on Apple Silicon (diffusers, LTX-Video).

    python3 scripts/vidgen.py --prompt "a cat walking on a roof at sunset" --out state/outbox/cat.mp4
    python3 scripts/vidgen.py --image photo.jpg --prompt "the person waves" --out state/outbox/wave.mp4

--model is a folder under state/models/ (install one with scripts/install_model.py --local-dir NAME) or a
Hugging Face repo that is already in the cache. Nothing is downloaded unless --online is passed, so a
typo cannot start a multi-gigabyte fetch. The default is state/models/ltx-video.

Sizes: width and height are multiples of 32, frames are 8n+1 (9, 17, 25, 33, 41, 49, ...). The defaults
(512x320, 49 frames at 24 fps, about 2 seconds) are what a 32 GB M1 Pro handles. Larger sizes and more
frames cost memory and time quickly, so raise them one step at a time.

There is no resident service. A call loads the model, renders and exits, so nothing stays in memory. A lock
file shared with imggen.py serialises calls, because an image model and a video model do not fit together
next to the voice service. The result is an mp4. Only state/outbox/ and a session scratchpad's outbox/ are
send sources, so write there if the result is meant for a chat.

The Hugging Face token is read from state/hf-token and passed through the environment only. It is never
printed. Prints one JSON line: {"ok": true, "out": ..., "seconds": ...} or {"ok": false, "error": ...}.
"""

import argparse
import fcntl
import json
import os
import sys
import time
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[1]
VENV = REPO / "state" / "vidgen-venv"
TOKEN_FILE = REPO / "state" / "hf-token"
LOCK_FILE = REPO / "state" / "imggen.lock"
LOG_FILE = REPO / "state" / "vidgen.log"
MODELS_DIR = REPO / "state" / "models"
DEFAULT_MODEL = "ltx-video"


def fail(message, code=1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def reexec_in_venv():
    """The heavy imports live in their own environment, so run this file with that Python."""
    python = VENV / "bin" / "python"
    if not python.exists():
        fail("the video venv is missing (state/vidgen-venv), see the README")
    if Path(sys.prefix).resolve() != VENV.resolve():
        os.execv(python, [str(python), *sys.argv])


def resolve_model(value):
    """A folder name under state/models/, a path, or a Hub repo id (looked up offline unless --online)."""
    for candidate in (MODELS_DIR / value, Path(value)):
        if candidate.is_dir():
            return str(candidate.resolve())
    if "/" in value:
        return value
    fail(f"no model folder '{value}' under state/models/ (see install_model.py --list)")


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True, help="an .mp4 path")
    p.add_argument("--image", help="start frame for image-to-video")
    p.add_argument("--negative", default="worst quality, blurry, jittery, distorted")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--width", type=int, default=512)
    p.add_argument("--height", type=int, default=320)
    p.add_argument("--frames", type=int, default=49)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--steps", type=int, default=30)
    p.add_argument("--guidance", type=float, default=3.0)
    p.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    p.add_argument(
        "--online", action="store_true", help="allow downloading a missing repo"
    )
    p.add_argument(
        "--wait",
        type=int,
        default=1800,
        help="seconds to wait for another render to finish",
    )
    a = p.parse_args()

    out = Path(a.out)
    if out.suffix.lower() != ".mp4":
        fail("--out must end in .mp4")
    if a.width % 32 or a.height % 32:
        fail("--width and --height must be multiples of 32")
    if a.frames % 8 != 1:
        fail("--frames must be 8n+1 (9, 17, 25, 33, 41, 49, ...)")
    if a.image and not Path(a.image).is_file():
        fail("--image must point at an existing file")
    model = resolve_model(a.model)

    reexec_in_venv()

    env_token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else ""
    if env_token:
        os.environ["HF_TOKEN"] = env_token
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    if not a.online:
        os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_FILE, "w")
    deadline = time.time() + a.wait
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                fail("another render is still running", code=3)
            time.sleep(5)

    # Send our own output to the log, so a failed render says why without flooding the terminal.
    log = open(LOG_FILE, "ab", buffering=0)
    log.write(f"\n== {time.strftime('%F %T')} {model} seed={a.seed}\n".encode())
    os.dup2(log.fileno(), 2)

    start = time.time()
    try:
        import torch  # pyright: ignore[reportMissingImports]
        from diffusers import (  # pyright: ignore[reportMissingImports]
            LTXImageToVideoPipeline,
            LTXPipeline,
        )
        from diffusers.utils import (  # pyright: ignore[reportMissingImports]
            export_to_video,
            load_image,
        )

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.bfloat16
        generator = torch.Generator("cpu").manual_seed(a.seed)
        common = dict(
            prompt=a.prompt,
            negative_prompt=a.negative,
            width=a.width,
            height=a.height,
            num_frames=a.frames,
            num_inference_steps=a.steps,
            guidance_scale=a.guidance,
            generator=generator,
        )
        if a.image:
            pipe = LTXImageToVideoPipeline.from_pretrained(model, torch_dtype=dtype)
            common["image"] = load_image(a.image)
        else:
            pipe = LTXPipeline.from_pretrained(model, torch_dtype=dtype)
        pipe.to(device)
        pipe.vae.enable_tiling()
        frames = pipe(**common).frames[0]
        out.parent.mkdir(parents=True, exist_ok=True)
        export_to_video(frames, str(out), fps=a.fps)
    except Exception as err:  # noqa: BLE001 - one JSON line for the caller, details in the log
        import traceback

        traceback.print_exc()
        fail(
            f"the render failed: {type(err).__name__}: {str(err)[:240]}, see state/vidgen.log"
        )
    print(
        json.dumps({"ok": True, "out": str(out), "seconds": round(time.time() - start)})
    )


if __name__ == "__main__":
    main()
