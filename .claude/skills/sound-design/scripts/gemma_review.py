#!/usr/bin/env python3
"""A second pair of ears and eyes before a video goes out: the local Gemma 4 model listens to the
audio and looks at the frames, and this script turns what it says into a short list of leads.

    gemma_review.py VIDEO --script lines.txt [--lang en|tr|de] [--frames 8] [--out DIR]

Speech: the audio goes in 25 second pieces (Gemma only takes about 30 seconds of audio at a time)
and Gemma is asked to transcribe it WITHOUT seeing the script. The joined transcript is then
compared with the script word by word, so a dropped or mangled word shows up as a number, not as
Gemma's opinion. (Told the expected text, it agrees with the text instead of listening to the audio.)
Whisper transcribes the same pieces as a second opinion, because Gemma on its own shortens words,
skips short ones and invents a stray phrase now and then (measured on the Gotham reel: it "missed"
"the moral" and "cannot", both clearly spoken). Only a word BOTH miss is reported as a real lead.

Pictures: four frames at a time, asked for cut-off or overlapping text, odd hands, faces or limbs,
garbled lettering in the artwork and unreadable captions.

Sound problems and picture problems are Gemma's claims, low confidence. Treat each as a lead: open
the frame or replay that second, and fix only what is really there. check_av.py stays the real gate
for loudness and silence. Needs state/llm-venv with mlx-vlm and the Gemma model in the Hugging Face
cache (see state/notes.md). Runs offline.
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VENV_PY = REPO / "state" / "llm-venv" / "bin" / "python"
MODEL = "mlx-community/gemma-4-e4b-it-4bit"
CHUNK = 25
NOISE = (
    "Fetching",
    "it/s",
    "UserWarning",
    "warnings.warn",
    "Prompt:",
    "Generation:",
    "Peak memory",
    "==========",
    "<|channel>",
    "<channel|>",
)


def ask(prompt, audio=None, image=None, max_tokens=450):
    cmd = [
        str(VENV_PY),
        "-m",
        "mlx_vlm.generate",
        "--model",
        MODEL,
        "--max-tokens",
        str(max_tokens),
        "--temperature",
        "0",
        "--thinking-mode",
        "disabled",
        "--prompt",
        prompt,
    ]
    if audio:
        cmd += ["--audio", str(audio)]
    if image:
        cmd += ["--image", str(image)]
    env = {**os.environ, "HF_HUB_OFFLINE": "1"}
    res = subprocess.run(
        cmd, capture_output=True, text=True, env=env, timeout=900, check=False
    )
    lines = [ln for ln in res.stdout.splitlines() if ln.strip()]
    return "\n".join(ln for ln in lines if not any(n in ln for n in NOISE)).strip()


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
        check=False,
    ).stdout
    return float(out.strip() or 0)


def words(text):
    """Lowercase words with contractions spelled out on both sides, so "can't" and "cannot" match."""
    text = text.lower().replace("’", "'")
    for short, full in CONTRACTIONS:
        text = text.replace(short, full)
    return re.findall(r"[a-z0-9]+", text)


CONTRACTIONS = [
    ("can't", "cannot"),
    ("won't", "will not"),
    ("n't", " not"),
    ("it's", "it is"),
    ("let's", "let us"),
    ("'m", " am"),
    ("'re", " are"),
    ("'ve", " have"),
    ("'ll", " will"),
    ("'d", " would"),
    ("'s", ""),
]


def whisper(wav, lang):
    """Whisper's own transcript of the same clip, the second opinion: it is the better transcriber."""
    model = REPO / "state" / "whisper-models" / "ggml-small.bin"
    out = subprocess.run(
        ["whisper-cli", "-ng", "-m", str(model), "-f", str(wav), "-l", lang, "-nt"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return " ".join(out.split())


def missed(want, got):
    """Positions in `want` that the transcript `got` does not carry, in order."""
    sm = difflib.SequenceMatcher(a=want, b=got, autojunk=False)
    gone = set()
    for tag, i1, i2, _, _ in sm.get_opcodes():
        if tag in ("delete", "replace"):
            gone.update(range(i1, i2))
    return gone, sm.ratio()


def phrases(want, positions):
    out, run = [], []
    for i in sorted(positions):
        if run and i != run[-1] + 1:
            out.append(" ".join(want[j] for j in run))
            run = []
        run.append(i)
    if run:
        out.append(" ".join(want[j] for j in run))
    return out


def listen(video, work, script_text, lang="en"):
    length = duration(video)
    heard, whispered, parts = [], [], []
    n = 0
    start = 0.0
    while start < length - 0.5:
        wav = work / f"part{n}.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                str(start),
                "-t",
                str(CHUNK),
                "-i",
                str(video),
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(wav),
            ],
            check=True,
        )
        text = ask(
            "Transcribe exactly what is spoken in this audio clip, word for word. "
            "Write only the spoken words, nothing else.",
            audio=wav,
            max_tokens=300,
        )
        problems = ask(
            "Listen for technical problems only: clicks or pops, a word cut off, the voice "
            "quieter than the music, distortion or robotic glitches. For each, say roughly how "
            "many seconds in. If there are none, answer exactly NONE.",
            audio=wav,
            max_tokens=200,
        )
        second = whisper(wav, lang)
        heard.append(text)
        whispered.append(second)
        parts.append(
            {
                "from": start,
                "gemma": text,
                "whisper": second,
                "gemma_problems": problems,
            }
        )
        start += CHUNK - 1.0  # a second of overlap so a word on the cut is heard whole
        n += 1
    want = words(script_text)
    gone_g, cover_g = missed(want, words(" ".join(heard)))
    gone_w, cover_w = missed(want, words(" ".join(whispered)))
    # A word both listeners miss is a real lead. One that only Gemma misses is usually Gemma
    # (it shortens words and skips short ones), so it is reported but not counted.
    return {
        "coverage_gemma": round(cover_g, 3),
        "coverage_whisper": round(cover_w, 3),
        "missed_by_both": phrases(want, gone_g & gone_w),
        "missed_by_gemma_only": phrases(want, gone_g - gone_w),
        "missed_by_whisper_only": phrases(want, gone_w - gone_g),
        "parts": parts,
    }


def look(video, work, shots):
    from PIL import Image  # pyright: ignore[reportMissingImports]

    length = duration(video)
    times = [length * (i + 0.5) / shots for i in range(shots)]
    frames = []
    for i, t in enumerate(times):
        f = work / f"frame{i}.png"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{t:.2f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                str(f),
            ],
            check=True,
        )
        frames.append((t, f))
    out = []
    for g in range(0, len(frames), 4):
        group = frames[g : g + 4]
        ims = [Image.open(f).convert("RGB") for _, f in group]
        w, h = ims[0].size
        sheet = Image.new("RGB", (w * 2, h * 2), "black")
        for k, im in enumerate(ims):
            sheet.paste(im, ((k % 2) * w, (k // 2) * h))
        sheet.thumbnail((1400, 1400))
        path = work / f"sheet{g // 4}.png"
        sheet.save(path)
        text = ask(
            "These are four frames from a vertical video, left to right then top to bottom. "
            "For each frame list problems only: text cut off or overlapping other text, "
            "unreadable captions, distorted or extra hands, fingers, faces or limbs, garbled "
            "letters inside the artwork, objects that look wrong. Be specific and short. If a "
            "frame is clean write NONE for it.",
            image=path,
            max_tokens=400,
        )
        out.append(
            {
                "times": [round(t, 1) for t, _ in group],
                "sheet": str(path),
                "notes": text,
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("video")
    ap.add_argument("--script", required=True, help="text file with the spoken lines")
    ap.add_argument("--out", help="folder for the working files and report.md")
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument(
        "--lang", default="en", help="language Whisper listens in (en, tr, de)"
    )
    a = ap.parse_args()
    if Path(sys.prefix).resolve() != (REPO / "state" / "llm-venv").resolve():
        if not VENV_PY.exists():
            print(json.dumps({"ok": False, "error": "state/llm-venv is missing"}))
            sys.exit(1)
        os.execv(VENV_PY, [str(VENV_PY), *sys.argv])
    video = Path(a.video)
    work = Path(a.out) if a.out else REPO / "state" / "tmp" / f"gemma-{video.stem}"
    work.mkdir(parents=True, exist_ok=True)
    report = {
        "ok": True,
        "video": str(video),
        "speech": listen(video, work, Path(a.script).read_text(), a.lang),
        "pictures": look(video, work, a.frames),
    }
    (work / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
