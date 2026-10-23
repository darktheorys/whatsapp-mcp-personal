#!/usr/bin/env python3
"""A whole narrated pps-style video from one storyboard file: slides drawn from templates, the
narration timed by the rules in SKILL.md, a music bed and effects, the mix, the video, and the
before-sending check.

    pps.py lines STORYBOARD.json    # prints the `lines` list to pass to wa_render_voice
    pps.py build STORYBOARD.json    # after rendering: slides, timeline, mix, video, check report

The voice render is the one step a script cannot do (it goes through the WhatsApp server's
wa_render_voice tool). Line files are state/outbox/<name>-<slide>-<line>.wav.

STORYBOARD.json:
{
  "name": "lira",                                  # file prefix, lowercase
  "voice": "6",                                    # default narrator voice (an approved clone)
  "bed": {"mood": "happy", "bpm": 108},
  "slides": [
    {"style": "title", "title": "LİRAMIZ NEDEN ERİYOR?", "sub": "a smaller line",
     "lines": ["Sevgili dostlar, ..."]},
    {"style": "text", "heading": "ESKİDEN:", "body": ["line one", "line two"], "note": "small print",
     "lines": ["...", {"voice": "1", "text": "a line in another voice", "fx": "boing"}]},
    {"style": "wordart", "title": "BÜYÜK YAZI!", "body": ["..."], "lines": ["..."]},
    {"style": "reveal", "title": "PEKİ DURSUN NE YAPMIŞ?", "lines": ["Peki Dursun ne yapmış?"]},
    {"style": "image", "image": "path/to/own.png", "lines": ["..."]},
    {"style": "closing", "title": "GÜLMEK SİZE YAKIŞIYOR...", "sub": "hazırlayan: Makine", "lines": ["..."]}
  ]
}
A "reveal" slide gets a drum roll after its lines and the next slide arrives on a ta-da. The last
slide ends on a rimshot and applause. Every slide change gets a quiet whoosh. Colours, stars and
transitions rotate on their own; "colors": ["#rrggbb", "#rrggbb"] or "transition" override them.
"""

import json
import math
import os
import random
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
VENV_PY = REPO / "state" / "imggen-venv" / "bin" / "python"
try:
    from PIL import Image, ImageDraw, ImageFont  # pyright: ignore[reportMissingImports]
except ImportError:
    if VENV_PY.exists() and Path(sys.executable).resolve() != VENV_PY.resolve():
        os.execv(VENV_PY, [str(VENV_PY), *sys.argv])
    print(json.dumps({"ok": False, "error": "Pillow is missing (state/imggen-venv)"}))
    sys.exit(1)

W, H = 960, 540
FONTS = Path("/System/Library/Fonts/Supplemental")
COMIC = str(FONTS / "Comic Sans MS Bold.ttf")
IMPACT = str(FONTS / "Impact.ttf")
RAINBOW = [
    (255, 0, 0),
    (255, 140, 0),
    (255, 230, 0),
    (0, 200, 0),
    (0, 120, 255),
    (160, 0, 255),
]
PALETTES = [
    ((70, 0, 140), (0, 60, 200)),
    ((120, 0, 90), (230, 90, 0)),
    ((0, 90, 160), (0, 170, 140)),
    ((0, 100, 40), (0, 40, 120)),
    ((10, 10, 10), (90, 0, 0)),
    ((255, 170, 0), (200, 40, 0)),
    ((0, 40, 110), (40, 0, 90)),
    ((60, 0, 120), (200, 0, 160)),
]
TRANSITIONS = [
    "radial",
    "wipeleft",
    "circleopen",
    "slidedown",
    "pixelize",
    "dissolve",
    "wiperight",
    "circleclose",
]
OUTBOX = REPO / "state" / "outbox"
KIT = REPO / "state" / "tmp" / "sfx-kit"

# Timing measured from narrated references (SKILL.md).
INTRO, GAP, TAIL, LEAD = 2.5, 0.9, 3.5, 0.25


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def gradient(top, bottom):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / (H - 1)
        d.line(
            [(0, y), (W, y)],
            fill=tuple(int(a + (b - a) * k) for a, b in zip(top, bottom)),
        )
    return img


def fit(d, text, font_path, size, max_w):
    """The largest size up to `size` at which the text fits the width."""
    while size > 14:
        font = ImageFont.truetype(font_path, size)
        if d.textlength(text, font=font) <= max_w:
            return font, size
        size -= 2
    return ImageFont.truetype(font_path, size), size


def wordart(d, text, y, size, wave=12):
    font, size = fit(d, text, IMPACT, size, W - 60)
    widths = [d.textlength(ch, font=font) for ch in text]
    x = (W - sum(widths)) / 2
    for i, ch in enumerate(text):
        dy = math.sin(i / 1.6) * wave
        d.text((x + 5, y + dy + 6), ch, font=font, fill=(40, 0, 60))
        d.text(
            (x, y + dy),
            ch,
            font=font,
            fill=RAINBOW[i % len(RAINBOW)],
            stroke_width=3,
            stroke_fill=(20, 20, 20),
        )
        x += widths[i]
    return size


def body(d, lines, y, size=40, fill=(255, 255, 255), stroke=(0, 0, 90)):
    for line in lines:
        font, s = fit(d, line, COMIC, size, W - 60)
        w = d.textlength(line, font=font)
        d.text(
            ((W - w) / 2, y),
            line,
            font=font,
            fill=fill,
            stroke_width=2,
            stroke_fill=stroke,
        )
        y += int(s * 1.35)
    return y


def stars(d, n, seed, avoid=(170, 470)):
    """Sparkles in the margins only, never over the text band."""
    r = random.Random(seed)
    for _ in range(n):
        x, y, s = r.randint(10, W - 10), r.randint(10, H - 10), r.randint(6, 14)
        if avoid[0] < y < avoid[1] and 60 < x < W - 60:
            continue
        d.polygon(
            [
                (x, y - s),
                (x + s / 3, y - s / 3),
                (x + s, y),
                (x + s / 3, y + s / 3),
                (x, y + s),
                (x - s / 3, y + s / 3),
                (x - s, y),
                (x - s / 3, y - s / 3),
            ],
            fill=(255, 255, 160),
        )


def draw_slide(slide, i, out):
    if slide.get("style") == "image":
        img = Image.open(slide["image"]).convert("RGB").resize((W, H))
        img.save(out)
        return
    top, bottom = (
        tuple(hexrgb(c) for c in slide["colors"])
        if slide.get("colors")
        else PALETTES[i % len(PALETTES)]
    )
    img = gradient(top, bottom)
    d = ImageDraw.Draw(img)
    style = slide.get("style", "text")
    if style == "title":
        stars(d, 16, i)
        wordart(d, slide["title"], 130, 72)
        if slide.get("sub"):
            body(d, [slide["sub"]], 290, 30, (255, 255, 0), (120, 0, 0))
        body(
            d,
            ["!!! BİLGİSAYARINIZIN SESİNİ AÇINIZ !!!"],
            410,
            28,
            (255, 255, 255),
            (160, 0, 0),
        )
    elif style in ("wordart", "reveal", "closing"):
        stars(d, 20 if style != "wordart" else 10, i)
        y = 90 if slide.get("body") else 190
        wordart(d, slide["title"], y, 80 if style == "wordart" else 66, 12)
        if slide.get("body"):
            body(d, slide["body"], 270, 38)
        if slide.get("sub"):
            body(
                d,
                [slide["sub"]],
                360 if style == "closing" else 420,
                32,
                (255, 255, 200),
            )
    else:
        y = 50
        if slide.get("heading"):
            y = body(d, [slide["heading"]], y, 44, (255, 255, 120)) + 20
        y = body(d, slide.get("body", []), max(y, 140), 40)
        if slide.get("note"):
            body(d, [slide["note"]], max(y + 30, 400), 32, (255, 230, 200), (120, 0, 0))
    img.save(out)


def line_specs(sb):
    """Every narration line with its file name, text and voice, in order."""
    specs = []
    for si, slide in enumerate(sb["slides"]):
        for li, line in enumerate(slide.get("lines", [])):
            line = {"text": line} if isinstance(line, str) else line
            specs.append(
                {
                    "slide": si,
                    "line": li,
                    "name": f"{sb['name']}-{si}-{li}",
                    "text": line["text"],
                    "voice": line.get("voice", sb.get("voice", "6")),
                    "fx": line.get("fx"),
                }
            )
    return specs


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
            str(path),
        ],
        capture_output=True,
        text=True,
    ).stdout
    return float(out.strip() or 0)


def py(script, *args):
    res = subprocess.run(
        [sys.executable, str(HERE / script), *map(str, args)],
        capture_output=True,
        text=True,
    )
    if res.returncode:
        raise SystemExit(
            json.dumps(
                {"ok": False, "step": script, "error": (res.stdout + res.stderr)[-600:]}
            )
        )
    return json.loads(res.stdout.strip().splitlines()[-1])


def build(sb):
    work = REPO / "state" / "tmp" / f"pps-{sb['name']}"
    work.mkdir(parents=True, exist_ok=True)
    specs = line_specs(sb)
    missing = [s["name"] for s in specs if not (OUTBOX / f"{s['name']}.wav").exists()]
    if missing:
        raise SystemExit(
            json.dumps(
                {
                    "ok": False,
                    "error": "render these lines first with wa_render_voice",
                    "missing": missing,
                }
            )
        )
    if not (KIT / "tada.wav").exists():
        py("sfx.py", "kit", KIT)

    voice, fx, slide_at = [], [], []
    t = INTRO
    slides = sb["slides"]
    fx.append({"file": str(KIT / "ding.wav"), "at": 0.3, "gain_db": -4})
    after_reveal = False
    for si, slide in enumerate(slides):
        lines = [s for s in specs if s["slide"] == si]
        if si == 0:
            slide_at.append(0.0)
        else:
            at = round(t if after_reveal else t - LEAD, 2)
            slide_at.append(at)
            fx.append(
                {
                    "file": str(KIT / "whoosh.wav"),
                    "at": round(max(0, at - 0.5), 2),
                    "gain_db": -10,
                }
            )
            if after_reveal:
                fx.append({"file": str(KIT / "tada.wav"), "at": at, "gain_db": -2})
                t += 1.0
        after_reveal = False
        for k, line in enumerate(lines):
            f = OUTBOX / f"{line['name']}.wav"
            if line.get("fx"):
                fx.append(
                    {
                        "file": str(KIT / f"{line['fx']}.wav"),
                        "at": round(max(0, t - 0.5), 2),
                        "gain_db": -4,
                    }
                )
            voice.append({"file": str(f), "at": round(t, 2)})
            last_on_slide = k == len(lines) - 1
            t += duration(f) + (
                0.2 if last_on_slide and slide.get("style") == "reveal" else GAP
            )
        if slide.get("style") == "reveal":
            fx.append({"file": str(KIT / "drumroll.wav"), "at": round(t, 2)})
            t += 2.4
            after_reveal = True
        if not lines:
            t += 3.0
    fx.append({"file": str(KIT / "rimshot.wav"), "at": round(t - GAP + 0.2, 2)})
    fx.append(
        {
            "file": str(KIT / "applause.wav"),
            "at": round(t - GAP + 1.1, 2),
            "gain_db": -3,
        }
    )
    length = round(t - GAP + TAIL, 2)

    bed = sb.get("bed", {})
    py(
        "sfx.py",
        "bed",
        work / "bed.wav",
        "--seconds",
        length,
        "--mood",
        bed.get("mood", "happy"),
        "--bpm",
        bed.get("bpm", 108),
    )
    timeline = {
        "length": length,
        "bed": {"file": str(work / "bed.wav")},
        "voice": voice,
        "fx": fx,
    }
    (work / "timeline.json").write_text(json.dumps(timeline, indent=1))
    mixed = py("mix.py", work / "timeline.json", work / "soundtrack.wav")

    for i, slide in enumerate(slides):
        draw_slide(slide, i, work / f"s{i}.png")
    show = {
        "audio": str(work / "soundtrack.wav"),
        "fade": 0.5,
        "slides": [
            {
                "image": str(work / f"s{i}.png"),
                "at": at,
                **(
                    {
                        "transition": slides[i].get(
                            "transition", TRANSITIONS[(i - 1) % len(TRANSITIONS)]
                        )
                    }
                    if i
                    else {}
                ),
            }
            for i, at in enumerate(slide_at)
        ],
    }
    (work / "slides.json").write_text(json.dumps(show, indent=1))
    out = OUTBOX / f"{sb['name']}.mp4"
    py("slideshow.py", work / "slides.json", out)

    (work / "script.txt").write_text("\n".join(s["text"] for s in specs))
    check = py(
        "check_av.py", out, "--script", work / "script.txt", "--out", work / "check"
    )
    print(
        json.dumps(
            {
                "ok": True,
                "out": str(out),
                "seconds": length,
                "mix_lufs": mixed.get("lufs"),
                "problems": check["problems"],
                "lines": check.get("lines"),
                "contact_sheet": check.get("contact_sheet"),
                "spectrum": check.get("spectrum"),
            },
            ensure_ascii=False,
        )
    )


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("lines", "build"):
        print(__doc__)
        sys.exit(2)
    path = Path(sys.argv[2])
    sb = json.loads(path.read_text())
    if (
        not str(sb.get("name", "")).replace("-", "").isalnum()
        or sb["name"] != sb["name"].lower()
    ):
        raise SystemExit(
            json.dumps(
                {"ok": False, "error": "name must be lowercase letters, digits or -"}
            )
        )
    if sys.argv[1] == "lines":
        print(
            json.dumps(
                [
                    {"name": s["name"], "text": s["text"], "clone": s["voice"]}
                    for s in line_specs(sb)
                ],
                ensure_ascii=False,
            )
        )
    else:
        build(sb)


if __name__ == "__main__":
    main()
