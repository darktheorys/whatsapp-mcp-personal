#!/usr/bin/env python3
"""
Turns an image or a video clip into a WhatsApp sticker in state/stickers/.

WhatsApp will not negotiate on the format: a sticker is a 512x512 WebP, static or animated, and
anything else is rejected outright rather than degraded. So this exists to make the one correct
thing, not to expose an encoder.

Everything it uses is already installed for other reasons -- ffmpeg from the voice pipeline, and
cwebp/img2webp from libwebp (`brew install webp`). No new dependency.

A fixed-argument wrapper on purpose: the repo's rule is that raw ffmpeg/cwebp are never allowlisted,
because a trailing wildcard in a Bash permission pattern cannot stop a dangerous flag being smuggled
in after whatever looked scoped. This takes an input path and a name, and nothing that reaches the
underlying tools is caller-controlled beyond those.

Usage:
  make_sticker.py <input> <name> [--animated] [--fps N] [--duration S] [--no-pad]

  <name>       becomes state/stickers/<name>.webp; letters, digits, dash, underscore only
  --animated   sample the input as a moving sticker (video/gif input)
  --no-pad     fill the 512x512 square instead of padding to it (crops the edges)
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
OUT_DIR = REPO / "state" / "stickers"

# WhatsApp's own ceilings. Going over does not degrade the sticker, it stops being accepted, so
# these are targets to encode down to rather than advisory limits.
SIZE = 512
MAX_STATIC_BYTES = 100 * 1024
MAX_ANIMATED_BYTES = 500 * 1024
MAX_ANIMATED_SECONDS = 9.0

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")


def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def need(binary, install_hint):
    if shutil.which(binary) is None:
        die(f"{binary} not found -- {install_hint}")


def run(cmd, what):
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        die(f"{what} failed:\n{result.stderr.strip()[:800]}")
    return result


def scale_filter(pad):
    """Fit into 512x512. Padding keeps the whole image and fills the rest with transparency, which
    is what a sticker of a wide photo should look like; cropping is the alternative when the subject
    is centred and the edges are not worth keeping."""
    if pad:
        return (
            f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=decrease,"
            f"pad={SIZE}:{SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=rgba"
        )
    return f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=increase,crop={SIZE}:{SIZE},format=rgba"


CUTOUT_BIN = REPO / "state" / "bin" / "cutout"


def lift_subject(src, work_dir):
    """Die-cut the subject onto transparency using macOS subject lifting (state/bin/cutout).

    This is the difference between a sticker and a small photo in a box. A padded screenshot keeps
    its background and its black bars; a cutout is the subject alone with an alpha channel, which is
    what every sticker anyone actually sends looks like.

    Returns the cutout path, or None when there is nothing to lift -- a crowd scene, a landscape or
    a flat caption card genuinely has no single foreground subject, and falling back to padding is
    the right answer rather than an error.
    """
    if not CUTOUT_BIN.exists():
        print(f"note: {CUTOUT_BIN} not built, keeping the background "
              f"(run: bash scripts/setup-text-extract.sh)", file=sys.stderr)
        return None
    cut = work_dir / "cutout.png"
    result = subprocess.run([str(CUTOUT_BIN), str(src), str(cut)], capture_output=True, text=True, timeout=120)
    if result.returncode != 0 or not cut.exists():
        print(f"note: no subject lifted ({result.stderr.strip()[:120]}), keeping the background",
              file=sys.stderr)
        return None
    return cut


def make_static(src, out, pad, cutout=False):
    with tempfile.TemporaryDirectory(prefix="sticker-") as tmp:
        frame = Path(tmp) / "frame.png"
        source = src
        if cutout:
            lifted = lift_subject(src, Path(tmp))
            # Padding, not cropping, once the background is gone: the subject is already tight to
            # its own edges, so cropping would cut into it rather than trim empty space.
            if lifted is not None:
                source, pad = lifted, True
        run(["ffmpeg", "-y", "-i", str(source), "-vf", scale_filter(pad), "-frames:v", "1", str(frame)],
            "ffmpeg (scaling to 512x512)")
        # Walk the quality down until it fits. Starting high and stepping is simpler to reason about
        # than predicting a quality from the source, and a sticker is small enough that a few passes
        # cost nothing.
        for quality in (90, 80, 70, 60, 50, 40, 30):
            run(["cwebp", "-quiet", "-q", str(quality), "-alpha_q", "100", str(frame), "-o", str(out)],
                "cwebp")
            if out.stat().st_size <= MAX_STATIC_BYTES:
                return quality, out.stat().st_size
        return quality, out.stat().st_size


def make_animated(src, out, pad, fps, duration):
    duration = min(duration, MAX_ANIMATED_SECONDS)
    with tempfile.TemporaryDirectory(prefix="sticker-") as tmp:
        frames_dir = Path(tmp)
        run(
            # No -vsync: it was removed in ffmpeg 8 ("Unrecognized option 'vsync'"), and the fps=
            # filter above already fixes the output rate, so it was redundant even while it existed.
            ["ffmpeg", "-y", "-t", str(duration), "-i", str(src),
             "-vf", f"fps={fps}," + scale_filter(pad),
             str(frames_dir / "f%04d.png")],
            "ffmpeg (extracting frames)",
        )
        frames = sorted(frames_dir.glob("f*.png"))
        if not frames:
            die("no frames came out of the input -- is it actually a video?")
        # -d is the per-frame delay in ms and must match the rate the frames were sampled at, or the
        # sticker plays at the wrong speed. Computed per attempt below, since dropping frames means
        # each remaining one has to be held proportionally longer.
        #
        # -lossy is not optional here: img2webp encodes losslessly by default, so -q is ignored
        # without it and every quality step produced the identical oversized file (5.3MB at
        # "quality 20"). -m 6 is the slowest/smallest compression method, which is free at this size.
        #
        # Dropping frames beats dropping quality once quality stops helping: a busy scene at 512x512
        # is dominated by frame count, and a sticker at 6fps still reads as motion where a smeared
        # one at 20 quality does not.
        for quality, keep_every in ((75, 1), (60, 1), (45, 1), (60, 2), (45, 2), (40, 3)):
            used = frames[::keep_every]
            run(["img2webp", "-loop", "0", "-lossy", "-m", "6",
                 "-d", str(int(round(1000 / fps)) * keep_every), "-q", str(quality),
                 *[str(f) for f in used], "-o", str(out)],
                "img2webp")
            if out.stat().st_size <= MAX_ANIMATED_BYTES:
                return quality, out.stat().st_size, len(used)
        return quality, out.stat().st_size, len(used)


def main():
    parser = argparse.ArgumentParser(description="Build a WhatsApp sticker (512x512 WebP)")
    parser.add_argument("input", help="Source image or video")
    parser.add_argument("name", help="Sticker name -> state/stickers/<name>.webp")
    parser.add_argument("--animated", action="store_true", help="Make a moving sticker from a video/gif")
    parser.add_argument("--fps", type=float, default=12, help="Frames per second when animated (default 12)")
    parser.add_argument("--duration", type=float, default=MAX_ANIMATED_SECONDS,
                        help=f"Seconds to use when animated (default/max {MAX_ANIMATED_SECONDS})")
    parser.add_argument("--no-pad", action="store_true", help="Crop to the square instead of padding with transparency")
    parser.add_argument("--cutout", action="store_true",
                        help="Die-cut the subject onto transparency first (macOS subject lifting). "
                             "This is what makes it look like a sticker rather than a photo in a box.")
    args = parser.parse_args()

    if not NAME_RE.match(args.name):
        die("name must be 1-48 characters of letters, digits, dash or underscore")
    src = Path(args.input)
    if not src.exists():
        die(f"no such file: {src}")

    need("ffmpeg", "brew install ffmpeg")
    need("cwebp", "brew install webp")
    if args.animated:
        need("img2webp", "brew install webp")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(OUT_DIR, 0o700)
    out = OUT_DIR / f"{args.name}.webp"

    if args.animated:
        quality, size, frames = make_animated(src, out, not args.no_pad, args.fps, args.duration)
        limit = MAX_ANIMATED_BYTES
        detail = f"{frames} frames at {args.fps}fps"
    else:
        quality, size = make_static(src, out, not args.no_pad, args.cutout)
        limit = MAX_STATIC_BYTES
        detail = "static, cut out" if args.cutout else "static"

    ok = size <= limit
    print(f"{'✓' if ok else '⚠'} {out}")
    print(f"  {detail}, quality {quality}, {size / 1024:.0f}KB (limit {limit // 1024}KB)")
    if not ok:
        # Reported rather than raised: the file exists and may well still send, but WhatsApp can
        # refuse it, and silently handing back something oversized would look like a send bug later.
        print("  still over the limit -- try --no-pad, a lower --fps, or a shorter --duration",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
