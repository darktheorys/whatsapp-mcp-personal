#!/usr/bin/env python3
"""Turns slide images and a finished soundtrack into an mp4, each slide arriving with a transition at
its own moment, so the pictures follow the narration instead of a fixed rhythm.

    slideshow.py SPEC.json OUT.mp4

SPEC.json:
    {
      "audio": "soundtrack.wav",
      "slides": [{"image": "s0.png", "at": 0}, {"image": "s1.png", "at": 7.0, "transition": "wipeleft"}],
      "fade": 0.5
    }

`at` is when the slide is fully on screen; the transition runs in the `fade` seconds before it.
Transitions are ffmpeg xfade names (radial, wipeleft, slidedown, pixelize, circleopen, dissolve...).
The video runs as long as the audio. Prints one JSON line.
"""

import json
import subprocess
import sys
from pathlib import Path


def duration(path):
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            path,
        ],
        capture_output=True,
        text=True,
    ).stdout
    return float(out.strip() or 0)


def main():
    spec, out = json.loads(Path(sys.argv[1]).read_text()), sys.argv[2]
    slides, fade = spec["slides"], float(spec.get("fade", 0.5))
    total = duration(spec["audio"])
    starts = [float(s["at"]) for s in slides]
    if (
        starts[0] != 0
        or any(b - a <= fade for a, b in zip(starts, starts[1:]))
        or starts[-1] >= total
    ):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "slides must start at 0, be more than `fade` apart and begin before the audio ends",
                }
            )
        )
        sys.exit(1)
    inputs, vf, last = [], [], "[0:v]"
    for i, s in enumerate(slides):
        end = starts[i + 1] if i + 1 < len(slides) else total
        inputs += [
            "-loop",
            "1",
            "-t",
            f"{end - starts[i] + fade:.2f}",
            "-framerate",
            "25",
            "-i",
            s["image"],
        ]
    for i in range(1, len(slides)):
        kind = slides[i].get("transition", "fade")
        vf.append(
            f"{last}[{i}:v]xfade=transition={kind}:duration={fade}:offset={starts[i] - fade:.2f}[v{i}]"
        )
        last = f"[v{i}]"
    vf.append(f"{last}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[vout]")
    a = len(slides)
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        *inputs,
        "-i",
        spec["audio"],
        "-filter_complex",
        ";".join(vf),
        "-map",
        "[vout]",
        "-map",
        f"{a}:a",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "22",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        "-t",
        f"{total:.2f}",
        out,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode:
        print(json.dumps({"ok": False, "error": res.stderr.strip()[-400:]}))
        sys.exit(1)
    print(json.dumps({"ok": True, "out": out, "seconds": round(total, 2)}))


if __name__ == "__main__":
    main()
