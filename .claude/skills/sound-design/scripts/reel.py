#!/usr/bin/env python3
"""A social-media reel from one storyboard: full-screen vertical pictures that keep moving (slow
zoom or pan, a punch-in on every cut), big word-by-word captions coloured by speaker, a hook title
on the first shot, a progress bar, and an end card with a question. Same voice files, music beds
and mixer as pps.py, a different look: pps.py imitates the old forwarded slideshows, this is what
holds attention on a phone feed.

    reel.py lines STORYBOARD.json    # prints the `lines` list for wa_render_voice
    reel.py build STORYBOARD.json    # after rendering: frames, mix, state/outbox/<name>.mp4, check

STORYBOARD.json:
{
  "name": "reel",                       # file prefix; line files are state/outbox/<name>-<shot>-<line>.wav
  "voice": "6",                         # narrator
  "colors": {"6": "#ffffff", "3": "#7fe7ff"},   # caption colour per voice (defaults exist)
  "music": {"file": "a.flac", "switch": {"file": "b.flac", "shot": 5, "gain_db": -3}},
  "shots": [
    {"image": "state/outbox/x.png", "motion": "in", "title": "HOOK TEXT",
     "lines": ["narration", {"voice": "3", "text": "a character", "fx": "boing",
                             "en": "a translation shown under the caption"}],
     "cut_fx": "scratch"},              # an effect on the cut into this shot
    {"image": "...", "end": ["KISSADAN HİSSE", "big line"], "ask": "Sen olsan söyler miydin?",
     "lines": ["..."]}                  # end card: darkened picture, big text, the question
  ]
}
motion: in, out, up, down, left, right. Keep a reel under 40 seconds and put the hook first.
"""

import importlib.util
import json
import math
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[4]
VENV_PY = REPO / "state" / "imggen-venv" / "bin" / "python"
try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont  # pyright: ignore[reportMissingImports]
except ImportError:
    if VENV_PY.exists() and Path(sys.executable).resolve() != VENV_PY.resolve():
        os.execv(VENV_PY, [str(VENV_PY), *sys.argv])
    print(json.dumps({"ok": False, "error": "Pillow is missing (state/imggen-venv)"}))
    sys.exit(1)

_spec = importlib.util.spec_from_file_location("pps", HERE / "pps.py")
pps = importlib.util.module_from_spec(_spec)  # pyright: ignore[reportArgumentType]
_spec.loader.exec_module(pps)  # pyright: ignore[reportOptionalMemberAccess]

W, H, FPS = 720, 1280, 30
FONTS = Path("/System/Library/Fonts/Supplemental")
CAPTION_FONT = str(FONTS / "Arial Black.ttf")
TITLE_FONT = str(FONTS / "Impact.ttf")
# The "clean" look: one sans family, white text, thin outlines and a soft shadow, crossfades instead
# of punch-ins, a vignette and a dark gradient behind the captions. Reads as produced rather than
# shouted, for a public page.
HEAVY = "/System/Library/Fonts/Avenir Next.ttc#8"
DEMI = "/System/Library/Fonts/Avenir Next.ttc#2"
ACCENT = "#ffc93c"
XFADE = 0.3
VOICE_COLORS = {
    "6": "#ffffff",
    "3": "#7fe7ff",
    "5": "#ffe14d",
    "9": "#ffad5c",
    "1": "#c8ff7a",
    "2": "#ff9ad5",
}
LEAD, GAP, TAIL = 0.15, 0.22, 1.6  # a reel starts talking at once and never pauses long
OUTBOX = REPO / "state" / "outbox"


def specs(sb):
    out = []
    for si, shot in enumerate(sb["shots"]):
        for li, line in enumerate(shot.get("lines", [])):
            line = {"text": line} if isinstance(line, str) else line
            out.append(
                {
                    "shot": si,
                    "name": f"{sb['name']}-{si}-{li}",
                    "text": line["text"],
                    "voice": line.get("voice", sb.get("voice", "6")),
                    "fx": line.get("fx"),
                    "sub": line.get("en"),  # a translation shown under the caption
                }
            )
    return out


def cover(img, w, h, fill_only=False):
    """Scale and centre-crop to fill w x h. A picture far from that shape (a square on a tall
    frame) goes over a blurred, darkened copy of itself instead of losing half its content."""
    ratio = img.width / img.height
    if not fill_only and abs(ratio - w / h) > 0.25:
        bg = cover(
            img.copy().filter(ImageFilter.GaussianBlur(24)), w, h, fill_only=True
        )
        bg = Image.blend(bg, Image.new("RGB", bg.size, (0, 0, 0)), 0.35)
        fg = img.copy()
        fg.thumbnail((w, h))
        bg.paste(fg, ((w - fg.width) // 2, (h - fg.height) // 2))
        return bg
    s = max(w / img.width, h / img.height)
    img = img.resize(
        (math.ceil(img.width * s), math.ceil(img.height * s)), Image.LANCZOS
    )
    x, y = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def chunks(text, n=3, max_chars=18):
    """Caption groups of up to n words, the way reels show them."""
    words, out, cur = text.split(), [], []
    for wd in words:
        if cur and (len(cur) >= n or len(" ".join(cur + [wd])) > max_chars):
            out.append(" ".join(cur))
            cur = []
        cur.append(wd)
        if wd[-1] in ".!?:,":
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return out


def font(path, size, cache={}):
    """A font by path, or path#index for one face of a .ttc collection."""
    key = (path, size)
    if key not in cache:
        file, _, index = path.partition("#")
        cache[key] = ImageFont.truetype(file, size, index=int(index or 0))
    return cache[key]


def outlined(d, xy, text, f, fill, stroke=7, anchor="mm"):
    d.text(
        xy,
        text,
        font=f,
        fill=fill,
        stroke_width=stroke,
        stroke_fill=(0, 0, 0),
        anchor=anchor,
    )


def fit_size(d, text, path, size, max_w):
    while size > 20 and d.textlength(text, font=font(path, size)) > max_w:
        size -= 2
    return size


def plan(sb):
    """Times for every shot, line, caption and effect."""
    kit = pps.KIT
    if not (kit / "tada.wav").exists():
        pps.py("sfx.py", "kit", kit)
    sp = specs(sb)
    voice, fx, caps, subs, shots = [], [], [], [], []
    t = LEAD
    for si, shot in enumerate(sb["shots"]):
        start = 0.0 if si == 0 else t
        if si:
            fx.append(
                {
                    "file": str(kit / "whoosh.wav"),
                    "at": round(max(0, t - 0.25), 2),
                    "gain_db": -9,
                }
            )
        if shot.get("cut_fx"):
            fx.append(
                {
                    "file": str(kit / f"{shot['cut_fx']}.wav"),
                    "at": round(max(0, t - 0.1), 2),
                    "gain_db": -3,
                }
            )
            t += 0.35
        if shot.get(
            "end"
        ):  # let the card land before the moral: words on the cut get lost
            t += 0.5
        for line in [s for s in sp if s["shot"] == si]:
            f = OUTBOX / f"{line['name']}.wav"
            if not f.exists():
                raise SystemExit(
                    json.dumps(
                        {
                            "ok": False,
                            "error": "render this line first",
                            "missing": line["name"],
                        }
                    )
                )
            dur = pps.duration(f)
            if line.get("fx"):
                fx.append(
                    {
                        "file": str(kit / f"{line['fx']}.wav"),
                        "at": round(t + dur - 0.05, 2),
                        "gain_db": -4,
                    }
                )  # after the words, never over them
            voice.append({"file": str(f), "at": round(t, 2)})
            if line.get("sub"):
                subs.append({"text": line["sub"], "start": t, "end": t + dur + GAP})
            groups = chunks(line["text"])
            weights = [len(g) + 3 for g in groups]
            acc = t
            color = sb.get("colors", {}).get(line["voice"]) or VOICE_COLORS.get(
                line["voice"], "#ffffff"
            )
            for g, wgt in zip(groups, weights):
                span = dur * wgt / sum(weights)
                caps.append(
                    {
                        "text": g,
                        "start": acc,
                        "end": acc + span,
                        "color": color,
                        "voice": line["voice"],
                    }
                )
                acc += span
            t += dur + GAP
        shots.append({**shot, "t0": start, "t1": t})
    length = round(t - GAP + TAIL, 2)
    shots[-1]["t1"] = length
    fx.append(
        {
            "file": str(kit / "rimshot.wav"),
            "at": round(t - GAP + 0.15, 2),
            "gain_db": -6,
        }
    )
    return sp, voice, fx, caps, subs, shots, length


def moving(shot, base, t, zoom_room, punch):
    """The shot's picture at time t: a slow zoom or pan across the oversized base image."""
    p = min(1.0, max(0.0, (t - shot["t0"]) / max(0.01, shot["t1"] - shot["t0"])))
    motion = shot.get("motion", "in")
    z = {"in": 1 + 0.14 * p, "out": 1.14 - 0.14 * p}.get(motion, 1.1) * (1 + punch)
    cw, ch = min(base.width, W * zoom_room / z), min(base.height, H * zoom_room / z)
    cx, cy = base.width / 2, base.height / 2
    slack_x, slack_y = (base.width - cw) / 2, (base.height - ch) / 2
    if motion == "up":
        cy += slack_y * (1 - 2 * p)
    elif motion == "down":
        cy -= slack_y * (1 - 2 * p)
    elif motion == "left":
        cx += slack_x * (1 - 2 * p)
    elif motion == "right":
        cx -= slack_x * (1 - 2 * p)
    box = (int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))
    return base.crop(box).resize((W, H), Image.BILINEAR)


def clean_overlay():
    """A soft vignette plus a dark band at the top and bottom, so white text reads on any picture."""
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = shade.load()
    for y in range(H):
        fy = y / H
        band = (
            max(0.0, (fy - 0.55) / 0.45) ** 1.6 * 0.78
            + max(0.0, (0.22 - fy) / 0.22) ** 1.8 * 0.55
        )
        for x in range(0, W, 4):
            fx = (x / W - 0.5) * 2
            v = min(0.9, band + 0.22 * fx * fx)
            a = int(255 * v)
            for k in range(4):
                if x + k < W:
                    px[x + k, y] = (0, 0, 0, a)
    return shade


def shadowed(d, xy, text, f, fill, anchor="mm", stroke=3):
    x, y = xy
    d.text((x + 3, y + 4), text, font=f, fill=(0, 0, 0, 150), anchor=anchor)
    d.text(
        xy,
        text,
        font=f,
        fill=fill,
        stroke_width=stroke,
        stroke_fill=(0, 0, 0, 200),
        anchor=anchor,
    )


def wrap_rows(d, text, path, size, max_w):
    rows, row = [], ""
    for wd in text.split():
        cand = f"{row} {wd}".strip()
        if row and d.textlength(cand, font=font(path, size)) > max_w:
            rows.append(row)
            row = wd
        else:
            row = cand
    return rows + ([row] if row else [])


def draw_clean(d, sb, shot, since_cut, t, caps, length, subs=()):
    accent = sb.get("accent", ACCENT)
    speakers = sb.get("speakers", {})
    if shot.get(
        "title"
    ):  # the hook: two clean lines that slide in, an accent bar under them
        k = min(1.0, since_cut / 0.35)
        ease = 1 - (1 - k) ** 3
        rows = wrap_rows(d, shot["title"], HEAVY, 70, W - 90)
        y = int(H * 0.085) - int(30 * (1 - ease))
        alpha = int(255 * ease)
        for row in rows:
            shadowed(d, (W // 2, y), row, font(HEAVY, 70), (255, 255, 255, alpha))
            y += 80
        bar = int(130 * ease)
        d.rounded_rectangle(
            [W // 2 - bar // 2, y - 18, W // 2 + bar // 2, y - 10], 4, fill=accent
        )
    if shot.get("end"):
        k = min(1.0, since_cut / 0.4)
        d.rectangle([0, 0, W, H], fill=(10, 10, 14, int(150 * k)))
        y = int(H * 0.30)
        head, *rest = shot["end"]
        shadowed(d, (W // 2, y), head, font(DEMI, 34), accent, stroke=0)
        y += 70
        for row in rest:
            size = fit_size(d, row, HEAVY, 62, W - 80)
            shadowed(
                d, (W // 2, y), row, font(HEAVY, size), (255, 255, 255, int(255 * k))
            )
            y += int(size * 1.22)
        if shot.get("ask") and since_cut > 0.7:
            y += 50
            size = fit_size(d, shot["ask"], DEMI, 40, W - 140)
            tw = d.textlength(shot["ask"], font=font(DEMI, size))
            d.rounded_rectangle(
                [W // 2 - tw / 2 - 34, y - 38, W // 2 + tw / 2 + 34, y + 38],
                38,
                fill=(255, 255, 255, 235),
            )
            d.text(
                (W // 2, y),
                shot["ask"],
                font=font(DEMI, size),
                fill=(20, 20, 26),
                anchor="mm",
            )
            bob = int(5 * math.sin(t * 5))
            ay = y + 70 + bob
            d.line(
                [(W // 2 - 18, ay), (W // 2, ay + 16), (W // 2 + 18, ay)],
                fill=accent,
                width=6,
            )
    cap = next((c for c in caps if c["start"] <= t < c["end"] + 0.05), None)
    if cap and not shot.get("end"):
        k = min(1.0, (t - cap["start"]) / 0.1)
        size = fit_size(d, cap["text"], HEAVY, int(58 * (1.06 - 0.06 * k)), W - 90)
        y = int(H * 0.78)
        who = speakers.get(cap["voice"])
        if who:  # a speaker tag over a character's line
            tw = d.textlength(who.upper(), font=font(DEMI, 26))
            d.rounded_rectangle(
                [W // 2 - tw / 2 - 18, y - 92, W // 2 + tw / 2 + 18, y - 54],
                19,
                fill=cap["color"],
            )
            d.text(
                (W // 2, y - 73),
                who.upper(),
                font=font(DEMI, 26),
                fill=(20, 20, 26),
                anchor="mm",
            )
        fill = "#ffffff" if not who else cap["color"]
        shadowed(d, (W // 2, y), cap["text"], font(HEAVY, size), fill)
    sub = next((s for s in subs if s["start"] <= t < s["end"]), None)
    if sub:  # the translation, smaller, under the caption, for the whole line
        y = int(H * 0.845)
        for row in wrap_rows(d, sub["text"], DEMI, 30, W - 100)[:3]:
            shadowed(
                d, (W // 2, y), row, font(DEMI, 30), (235, 235, 235, 235), stroke=2
            )
            y += 38
    d.rectangle([0, H - 5, int(W * t / length), H], fill=(255, 255, 255, 170))


def build(sb):
    # House rule (owner, 2026-10-25): every video with non-English audio gets English subtitles.
    if sb.get("lang", "en") != "en":
        bare = [s["name"] for s in specs(sb) if not s["sub"]]
        if bare:
            raise SystemExit(
                json.dumps(
                    {
                        "ok": False,
                        "error": 'non-English audio needs an English subtitle on every line (the "en" field)',
                        "missing": bare,
                    }
                )
            )
    work = REPO / "state" / "tmp" / f"reel-{sb['name']}"
    work.mkdir(parents=True, exist_ok=True)
    sp, voice, fx, caps, subs, shots, length = plan(sb)

    music = sb.get("music", {})
    bed = work / "bed.wav"
    if music.get("file"):
        m = dict(music)
        if m.get("switch"):
            m["switch"] = {**m["switch"], "slide": m["switch"]["shot"]}
        pps.make_file_bed(m, [s["t0"] for s in shots], length, bed)
    else:
        pps.py(
            "sfx.py", "bed", bed, "--seconds", length, "--mood", "happy", "--bpm", 120
        )
    timeline = {"length": length, "bed": {"file": str(bed)}, "voice": voice, "fx": fx}
    (work / "timeline.json").write_text(json.dumps(timeline, indent=1))
    mixed = pps.py("mix.py", work / "timeline.json", work / "soundtrack.wav")

    zoom_room = 1.18
    bases = []
    for shot in shots:
        img = Image.open(REPO / shot["image"]).convert("RGB")
        base = cover(img, int(W * zoom_room), int(H * zoom_room))
        if shot.get("end"):
            base = base.filter(ImageFilter.GaussianBlur(6))
            base = Image.blend(base, Image.new("RGB", base.size, (0, 0, 0)), 0.45)
        bases.append(base)

    out = OUTBOX / f"{sb['name']}.mp4"
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-i",
            str(work / "soundtrack.wav"),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    clean = sb.get("look") == "clean"
    shade = clean_overlay() if clean else None
    frames = int(length * FPS)
    for n in range(frames):
        t = n / FPS
        si = max(i for i, s in enumerate(shots) if s["t0"] <= t)
        shot = shots[si]
        since_cut = t - shot["t0"]
        punch = not clean and si and since_cut < 0.18  # a punch-in on every cut
        frame = moving(
            shot, bases[si], t, zoom_room, 0.08 * (1 - since_cut / 0.18) if punch else 0
        )
        if clean and si and since_cut < XFADE:
            prev = moving(shots[si - 1], bases[si - 1], t, zoom_room, 0)
            frame = Image.blend(prev, frame, since_cut / XFADE)
        if clean:
            frame.paste(shade, (0, 0), shade)
            d = ImageDraw.Draw(frame, "RGBA")
            draw_clean(d, sb, shot, since_cut, t, caps, length, subs)
            ff.stdin.write(frame.tobytes())  # pyright: ignore[reportOptionalMemberAccess]
            continue
        d = ImageDraw.Draw(frame, "RGBA")

        if shot.get("title"):  # the hook, top of the first shot
            k = min(1.0, since_cut / 0.25)
            words = shot["title"].split()
            rows = [
                " ".join(words[: (len(words) + 1) // 2]),
                " ".join(words[(len(words) + 1) // 2 :]),
            ]
            size = min(
                fit_size(d, r, TITLE_FONT, int(104 + 30 * (1 - k)), W - 60)
                for r in rows
                if r
            )
            for i, row in enumerate(r for r in rows if r):
                outlined(
                    d,
                    (W // 2, int(H * 0.10) + i * int(size * 1.08)),
                    row,
                    font(TITLE_FONT, size),
                    "#ffe14d",
                    stroke=9,
                )
        if shot.get("end"):
            y = int(H * 0.30)
            for i, row in enumerate(shot["end"]):
                size = fit_size(d, row, TITLE_FONT, 92 if i == 0 else 64, W - 70)
                outlined(
                    d,
                    (W // 2, y),
                    row,
                    font(TITLE_FONT, size),
                    "#ffe14d" if i == 0 else "#ffffff",
                    stroke=7,
                )
                y += int(size * 1.25)
            if shot.get("ask") and since_cut > 0.6:
                bob = int(6 * math.sin(t * 6))
                size = fit_size(d, shot["ask"], CAPTION_FONT, 50, W - 80)
                d.rounded_rectangle(
                    [40, int(H * 0.56) - 50, W - 40, int(H * 0.56) + 50],
                    26,
                    fill=(255, 40, 90, 235),
                )
                outlined(
                    d,
                    (W // 2, int(H * 0.56)),
                    shot["ask"],
                    font(CAPTION_FONT, size),
                    "#ffffff",
                    stroke=4,
                )
                d.polygon(
                    [
                        (W // 2 - 26, int(H * 0.64) + bob),
                        (W // 2 + 26, int(H * 0.64) + bob),
                        (W // 2, int(H * 0.68) + bob),
                    ],
                    fill="#ffffff",
                )

        cap = next((c for c in caps if c["start"] <= t < c["end"] + 0.05), None)
        if cap and not shot.get("end"):  # the end card carries its own text
            k = min(1.0, (t - cap["start"]) / 0.12)  # each group pops in
            size = fit_size(
                d,
                cap["text"].upper(),
                CAPTION_FONT,
                int(66 * (1.18 - 0.18 * k)),
                W - 70,
            )
            outlined(
                d,
                (W // 2, int(H * 0.74)),
                cap["text"].upper(),
                font(CAPTION_FONT, size),
                cap["color"],
                stroke=8,
            )

        d.rectangle(
            [0, H - 10, int(W * t / length), H], fill=(255, 225, 77, 230)
        )  # progress bar
        ff.stdin.write(frame.tobytes())  # pyright: ignore[reportOptionalMemberAccess]
    ff.stdin.close()  # pyright: ignore[reportOptionalMemberAccess]
    ff.wait()

    (work / "script.txt").write_text("\n".join(s["text"] for s in sp))
    check = pps.py(
        "check_av.py", out, "--script", work / "script.txt", "--out", work / "check"
    )
    print(
        json.dumps(
            {
                "ok": ff.returncode == 0,
                "out": str(out),
                "seconds": length,
                "mix_lufs": mixed.get("lufs"),
                "problems": check["problems"],
                "lines": check.get("lines"),
                "contact_sheet": check.get("contact_sheet"),
            },
            ensure_ascii=False,
        )
    )


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("lines", "build"):
        print(__doc__)
        sys.exit(2)
    sb = json.loads(Path(sys.argv[2]).read_text())
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
                    for s in specs(sb)
                ],
                ensure_ascii=False,
            )
        )
    else:
        build(sb)


if __name__ == "__main__":
    main()
