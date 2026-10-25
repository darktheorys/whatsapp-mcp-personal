#!/usr/bin/env python3
"""A whole narrated pps-style video from one storyboard file: slides drawn from templates, the
narration timed by the rules in SKILL.md, a music bed and effects, the mix, the video, and the
before-sending check.

    pps.py lines STORYBOARD.json    # prints the `lines` list to pass to wa_render_voice
    pps.py build STORYBOARD.json    # after rendering: slides, timeline, mix, video, check report
    pps.py build STORYBOARD.json --aspect 16:9   # or 9:16: override the storyboard's format; the
                                                 # video is then <name>-16x9.mp4 / <name>-9x16.mp4

The voice render is the one step a script cannot do (it goes through the WhatsApp server's
wa_render_voice tool). Line files are state/outbox/<name>-<slide>-<line>.wav.

STORYBOARD.json:
{
  "name": "lira",                                  # file prefix, lowercase
  "voice": "6",                                    # default narrator voice (an approved clone)
  "bed": {"mood": "happy", "bpm": 108},
  # or a free-to-use recording, switching on a slide:
  # "bed": {"file": "a.flac", "switch": {"file": "b.flac", "slide": 7, "start": 0, "gain_db": -3}},
  "aspect": "9:16",                               # optional, default 16:9 (9:16 is 720x1280)
  "lang": "en",                                    # optional, language of the "sound on" line
  "slides": [
    {"style": "title", "title": "LİRAMIZ NEDEN ERİYOR?", "sub": "a smaller line",
     "lines": ["Sevgili dostlar, ..."]},
    {"style": "text", "heading": "ESKİDEN:", "body": ["line one", "line two"], "note": "small print",
     "lines": ["...", {"voice": "1", "text": "a line in another voice", "fx": "boing"}]},
    {"style": "wordart", "title": "BÜYÜK YAZI!", "body": ["..."], "lines": ["..."]},
    {"style": "reveal", "title": "PEKİ DURSUN NE YAPMIŞ?", "lines": ["Peki Dursun ne yapmış?"]},
    {"style": "image", "image": "path/to/own.png", "lines": ["..."]},
    {"style": "picture", "title": "BAŞLIK", "picture": "path/to/own.png", "body": ["caption"],
     "lines": ["..."]},                            # heading, framed picture, caption
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
# Slide layouts are written for a 540-high frame. A vertical (9:16) deck draws the same layout
# into a 720x1280 frame, stretched by YS and centred by YOFF, so the text sits mid-screen where a
# phone shows it. set_aspect() switches these.
YS, YOFF, FS = 1.0, 0, 1.0  # FS scales text sizes
SOUND_ON = {
    "tr": "!!! BİLGİSAYARINIZIN SESİNİ AÇINIZ !!!",
    "en": "!!! TURN YOUR SOUND ON !!!",
}


def set_aspect(aspect):
    global W, H, YS, YOFF, FS
    if aspect == "9:16":
        W, H, YS, FS = 720, 1280, 1.5, 1.5
        YOFF = int((H - 540 * YS) / 2)
    elif aspect == "16:9":
        W, H, YS, YOFF, FS = 960, 540, 1.0, 0, 1.0
    else:
        raise SystemExit(json.dumps({"ok": False, "error": "aspect is 16:9 or 9:16"}))


def Y(y):
    """A y position from the 540-high layout, placed in the current frame."""
    return int(YOFF + y * YS)


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


def lerp(a, b, k):
    return tuple(int(x + (y - x) * k) for x, y in zip(a, b))


def background(kind, top, bottom):
    """The slide's backdrop. pps files were never uniform: plain gradients, but also stripes,
    checkerboards and radial glows, often all in one deck."""
    # The outer colour fills whatever a pattern leaves open.
    img = Image.new("RGB", (W, H), bottom)
    d = ImageDraw.Draw(img)
    if kind == "radial":
        cx, cy, far = W / 2, H / 2, math.hypot(W / 2, H / 2)
        for r in range(int(far), 0, -6):
            d.ellipse(
                [cx - r, cy - r * 0.75, cx + r, cy + r * 0.75],
                fill=lerp(top, bottom, r / far),
            )
    elif kind == "diagonal":
        for x in range(-H, W, 3):
            d.line(
                [(x, H), (x + H, 0)], fill=lerp(top, bottom, (x + H) / (W + H)), width=4
            )
    elif kind == "stripes":
        for x in range(0, W + H, 40):
            col = top if (x // 40) % 2 else lerp(top, bottom, 0.5)
            d.polygon([(x, 0), (x + 20, 0), (x + 20 - H, H), (x - H, H)], fill=col)
    elif kind == "checker":
        for gx in range(0, W, 60):
            for gy in range(0, H, 60):
                col = top if (gx // 60 + gy // 60) % 2 else bottom
                d.rectangle([gx, gy, gx + 60, gy + 60], fill=col)
    elif kind == "horizontal":
        for x in range(W):
            d.line([(x, 0), (x, H)], fill=lerp(top, bottom, x / (W - 1)))
    else:
        for y in range(H):
            d.line([(0, y), (W, y)], fill=lerp(top, bottom, y / (H - 1)))
    return img


def fit(d, text, font_path, size, max_w):
    """The largest size up to `size` at which the text fits the width."""
    while size > 14:
        font = ImageFont.truetype(font_path, size)
        if d.textlength(text, font=font) <= max_w:
            return font, size
        size -= 2
    return ImageFont.truetype(font_path, size), size


WORDART_SCHEMES = {
    "rainbow": RAINBOW,
    "fire": [(255, 230, 0), (255, 150, 0), (255, 60, 0)],
    "ice": [(255, 255, 255), (150, 220, 255), (60, 160, 255)],
    "gold": [(255, 220, 80), (230, 170, 30), (255, 240, 150)],
    "candy": [(255, 80, 180), (255, 255, 255), (120, 220, 255)],
}


def wrap(d, text, font_path, size, max_w):
    """Greedy word wrap at `size`. Only a vertical deck wraps: a 16:9 deck keeps one line per
    entry and shrinks it instead, the way the old slides looked."""
    if FS == 1.0:
        return [text]
    font = ImageFont.truetype(font_path, size)
    rows, row = [], ""
    for word in text.split():
        cand = f"{row} {word}".strip()
        if row and d.textlength(cand, font=font) > max_w:
            rows.append(row)
            row = word
        else:
            row = cand
    return rows + ([row] if row else [])


def wordart(d, text, y, size, wave=12, scheme="rainbow", tilt=0.0):
    size = int(size * FS)
    rows = wrap(d, text, IMPACT, size, W - 60)
    for row in rows[:-1]:
        _wordart_row(d, row, y, size, wave, scheme, tilt)
        y += int(size * 1.1)
    size = _wordart_row(d, rows[-1], y, size, wave, scheme, tilt)
    return y + int(size * 1.25)  # the first free y below the art


def _wordart_row(d, text, y, size, wave, scheme, tilt):
    font, size = fit(d, text, IMPACT, size, W - 60)
    colors = WORDART_SCHEMES.get(scheme, RAINBOW)
    widths = [d.textlength(ch, font=font) for ch in text]
    x = (W - sum(widths)) / 2
    for i, ch in enumerate(text):
        dy = math.sin(i / 1.6) * wave + (i - len(text) / 2) * tilt
        d.text((x + 5, y + dy + 6), ch, font=font, fill=(40, 0, 60))
        d.text(
            (x, y + dy),
            ch,
            font=font,
            fill=colors[i % len(colors)],
            stroke_width=3,
            stroke_fill=(20, 20, 20),
        )
        x += widths[i]
    return size


def body(d, lines, y, size=40, fill=(255, 255, 255), stroke=(0, 0, 90), align="center"):
    size = int(size * FS)
    rows = [row for entry in lines for row in wrap(d, entry, COMIC, size, W - 100)]
    for line in rows:
        font, s = fit(d, line, COMIC, size, W - 100)
        w = d.textlength(line, font=font)
        x = {"left": 60, "right": W - 60 - w}.get(align, (W - w) / 2)
        d.text((x, y), line, font=font, fill=fill, stroke_width=2, stroke_fill=stroke)
        y += int(s * 1.35)
    return y


def decor(d, kind, n, seed, avoid=(170, 470)):
    """Sparkles, hearts or bubbles in the margins, never over the text band."""
    if kind == "none":
        return
    r = random.Random(seed)
    avoid = (Y(avoid[0]), Y(avoid[1]))
    for _ in range(n):
        x, y, s = r.randint(10, W - 10), r.randint(10, H - 10), r.randint(6, 16)
        if avoid[0] < y < avoid[1] and 60 < x < W - 60:
            continue
        if kind == "bubbles":
            d.ellipse([x - s, y - s, x + s, y + s], outline=(255, 255, 255), width=2)
        elif kind == "hearts":
            d.ellipse([x - s, y - s, x, y], fill=(255, 90, 150))
            d.ellipse([x, y - s, x + s, y], fill=(255, 90, 150))
            d.polygon(
                [(x - s, y - s / 2), (x + s, y - s / 2), (x, y + s)],
                fill=(255, 90, 150),
            )
        else:
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


HEAD_COLORS = [
    (255, 255, 120),
    (120, 255, 255),
    (255, 170, 230),
    (255, 255, 255),
    (180, 255, 150),
]
STROKES = [(0, 0, 90), (90, 0, 0), (0, 60, 0), (40, 0, 60), (0, 0, 0)]


def look_for(slide, seed):
    """A different look per slide, picked from the deck's seed so a rebuild draws the same deck.
    Anything set in the slide's own "look" wins."""
    r = random.Random(seed)
    look = {
        "bg": r.choice(
            [
                "vertical",
                "vertical",
                "horizontal",
                "diagonal",
                "radial",
                "stripes",
                "checker",
            ]
        ),
        "palette": r.choice(PALETTES),
        "align": r.choice(["center", "center", "left"]),
        "scale": r.choice([0.85, 0.95, 1.0, 1.1, 1.2]),
        "scheme": r.choice(list(WORDART_SCHEMES)),
        "wave": r.choice([4, 8, 12, 18]),
        "tilt": r.choice([0.0, 0.0, -0.6, 0.6]),
        "decor": r.choice(["stars", "stars", "bubbles", "hearts", "none"]),
        "head": r.choice(HEAD_COLORS),
        "stroke": r.choice(STROKES),
        "panel": r.random() < 0.35,
    }
    look.update(slide.get("look", {}))
    if slide.get("colors"):
        look["palette"] = tuple(hexrgb(c) for c in slide["colors"])
    return look


def draw_slide(slide, i, out, seed="deck", lang="tr"):
    if slide.get("style") == "image":
        Image.open(slide["image"]).convert("RGB").resize((W, H)).save(out)
        return
    lk = look_for(slide, f"{seed}-{i}")
    top, bottom = lk["palette"]
    img = background(lk["bg"], top, bottom)
    d = ImageDraw.Draw(img, "RGBA")
    if lk["panel"]:  # a translucent box behind the text, the "text frame" look
        d.rounded_rectangle([40, Y(120), W - 40, Y(500)], radius=24, fill=(0, 0, 0, 90))
    k, style = lk["scale"], slide.get("style", "text")
    art = dict(scheme=lk["scheme"], wave=lk["wave"], tilt=lk["tilt"])
    if style == "title":
        decor(d, lk["decor"], 16, i)
        y = wordart(d, slide["title"], Y(130), int(72 * k), **art)
        if slide.get("sub"):
            y = body(
                d, [slide["sub"]], max(y, Y(290)), int(30 * k), lk["head"], (120, 0, 0)
            )
        body(
            d,
            [SOUND_ON.get(lang, SOUND_ON["tr"])],
            max(y + 20, Y(410)),
            28,
            (255, 255, 255),
            (160, 0, 0),
        )
    elif style == "picture":
        # The pps classic: a heading, a picture in a white frame, one line under it.
        # Laid out on the whole frame, not the 540-high band: a picture wants the full height.
        y = int(H * 0.05)
        if slide.get("title"):
            y = wordart(d, slide["title"], y, int(54 * k), **art) + 10
        cap = H - int(H * (0.18 if H > W else 0.16))  # the caption band starts here
        room = cap - y - 20
        side = max(120, min(W - 80, room))
        pic = Image.open(slide["picture"]).convert("RGB")
        pic.thumbnail((side, side))
        px, py = (W - pic.width) // 2, y + (room - pic.height) // 2
        d.rectangle(
            [px - 8, py - 8, px + pic.width + 8, py + pic.height + 8],
            fill=(255, 255, 255),
        )
        img.paste(pic, (px, py))
        body(
            d,
            slide.get("body", []),
            max(py + pic.height + 22, cap),
            int(34 * k),
            stroke=lk["stroke"],
            align="center",
        )
    elif style in ("wordart", "reveal", "closing"):
        decor(d, lk["decor"], 20 if style != "wordart" else 10, i)
        y = Y(90 if slide.get("body") else 190)
        y = wordart(
            d, slide["title"], y, int((80 if style == "wordart" else 66) * k), **art
        )
        if slide.get("body"):
            y = body(
                d,
                slide["body"],
                max(y, Y(270)),
                int(38 * k),
                stroke=lk["stroke"],
                align=lk["align"],
            )
        if slide.get("sub"):
            body(
                d,
                [slide["sub"]],
                max(y + 20, Y(360 if style == "closing" else 420)),
                32,
                (255, 255, 200),
            )
    else:
        y = Y(50)
        if slide.get("heading"):
            y = (
                body(
                    d, [slide["heading"]], y, int(44 * k), lk["head"], align=lk["align"]
                )
                + 20
            )
        y = body(
            d,
            slide.get("body", []),
            max(y, Y(140)),
            int(40 * k),
            stroke=lk["stroke"],
            align=lk["align"],
        )
        if slide.get("note"):
            body(
                d,
                [slide["note"]],
                max(y + 30, Y(400)),
                32,
                (255, 230, 200),
                (120, 0, 0),
                align=lk["align"],
            )
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


def make_file_bed(bed, slide_at, length, out):
    """A bed from a recording instead of the synth: looped or cut to the video's length, and
    optionally switching to a second recording on one slide ("switch": {"file", "slide"}) with
    a short crossfade, for a story whose mood turns. Use only recordings that are free to use
    (public domain or a licence that allows it), never a song cut out of someone's video."""
    first = Path(bed["file"])
    sw = bed.get("switch")
    if not sw:
        cmd = ["-stream_loop", "-1", "-i", str(first), "-t", str(length)]
        ff = ["-af", f"afade=t=out:st={max(0, length - 2.5)}:d=2.5"]
    else:
        cut = slide_at[sw["slide"]]
        fade = 1.2
        cmd = [
            "-stream_loop",
            "-1",
            "-i",
            str(first),
            "-stream_loop",
            "-1",
            "-i",
            str(sw["file"]),
        ]
        # Each recording is levelled on its own first: a brass march is far louder than a solo
        # piano, and levelling the joined bed as one would bury the voice after the switch.
        lv = "aresample=44100,loudnorm=I=-24:TP=-2:LRA=11"
        ff = [
            "-filter_complex",
            f"[0:a]atrim=0:{cut + fade},asetpts=N/SR/TB,{lv}[a];"
            f"[1:a]atrim={sw.get('start', 0)}:{sw.get('start', 0) + length - cut + fade},"
            f"asetpts=N/SR/TB,{lv},volume={sw.get('gain_db', 0)}dB[b];"
            f"[a][b]acrossfade=d={fade}[x];"
            f"[x]atrim=0:{length},afade=t=out:st={max(0, length - 2.5)}:d=2.5",
        ]
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            *cmd,
            *ff,
            "-ar",
            "44100",
            "-ac",
            "2",
            str(out),
        ],
        check=True,
    )


def build(sb):
    work = REPO / "state" / "tmp" / f"pps-{sb.get('out', sb['name'])}"
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
    if bed.get("file"):
        make_file_bed(bed, slide_at, length, work / "bed.wav")
    else:
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
        draw_slide(slide, i, work / f"s{i}.png", sb["name"], sb.get("lang", "tr"))
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
    out = OUTBOX / f"{sb.get('out', sb['name'])}.mp4"
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
    args = sys.argv[1:]
    aspect = None
    if len(args) == 4 and args[2] == "--aspect":
        aspect = args.pop()
        args.pop()
    if len(args) != 2 or args[0] not in ("lines", "build"):
        print(__doc__)
        sys.exit(2)
    path = Path(args[1])
    sb = json.loads(path.read_text())
    set_aspect(aspect or sb.get("aspect", "16:9"))
    # A forced format gets its own file, so both versions can sit side by side.
    if aspect:
        sb["out"] = f"{sb['name']}-{aspect.replace(':', 'x')}"
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
