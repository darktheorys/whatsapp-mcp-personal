#!/usr/bin/env python3
"""The before-sending check for a narrated video or soundtrack, as one report: loudness, true peak,
silences, a timestamped transcript, how well each scripted line is actually heard, a spectrogram and
a contact sheet of frames.

    check_av.py MEDIA [--script lines.txt] [--out DIR]

`lines.txt` holds one spoken line per line of text; each gets a score for how much of it appears in
the transcript, in order (1 is all of it). Prints one JSON line and writes spectrum.png and
contact-sheet.jpg into DIR (default state/tmp/check-<name>/), so both can be looked at.
"""

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[4]
MODELS = REPO / "state" / "whisper-models"
WATCH = REPO / ".claude" / "skills" / "yt-dlp" / "scripts" / "watch_video.py"


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def key(word):
    w = unicodedata.normalize("NFD", word.lower()).replace("ı", "i")
    return re.sub(r"[^\w]", "", "".join(c for c in w if not unicodedata.combining(c)))


# Numbers are dropped on both sides: a script spells them ("iki bin yirmi iki") and whisper writes
# digits ("2022"), which is the same thing said, not a missing line.
NUMBER_WORD = re.compile(
    r"^(sifir|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz|yuzde|bin|milyon|milyar)"
)


def numberish(k):
    return bool(re.search(r"\d", k)) or bool(NUMBER_WORD.match(k))


def coverage(line, heard):
    """Share of the line's words found in the transcript in order (longest common subsequence)."""
    heard = [k for k in heard if not numberish(k)]
    want = [k for k in map(key, line.split()) if k and not numberish(k)]
    if not want:
        return 1.0
    best = 0
    # Search windows of the transcript around the line's length, so one line is not matched against
    # words from the whole video.
    n = len(want)
    for start in range(0, max(1, len(heard) - n // 2)):
        window = heard[start : start + n + 6]
        row = [0] * (len(window) + 1)
        for w in want:
            prev = 0
            for j in range(1, len(window) + 1):
                keep = row[j]
                row[j] = prev + 1 if w == window[j - 1] else max(row[j], row[j - 1])
                prev = keep
        best = max(best, row[-1])
        if best == n:
            break
    return round(best / n, 2)


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("media")
    p.add_argument("--script")
    p.add_argument("--out")
    a = p.parse_args()
    media = Path(a.media)
    out = Path(a.out) if a.out else REPO / "state" / "tmp" / f"check-{media.stem}"
    out.mkdir(parents=True, exist_ok=True)
    wav = out / "audio16k.wav"
    run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(media),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(wav),
        ]
    )

    eb = run(
        [
            "ffmpeg",
            "-nostats",
            "-i",
            str(media),
            "-af",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ]
    ).stderr
    last = lambda pat: (re.findall(pat, eb) or [None])[-1]  # noqa: E731
    report: dict[str, Any] = {
        "lufs": float(last(r"I:\s*(-?[\d.]+) LUFS") or 0),
        "true_peak_db": float(last(r"Peak:\s*(-?[\d.]+) dBFS") or 0),
        "loudness_range_lu": float(last(r"LRA:\s*([\d.]+) LU") or 0),
    }
    sd = run(
        [
            "ffmpeg",
            "-i",
            str(wav),
            "-af",
            "silencedetect=n=-45dB:d=0.4",
            "-f",
            "null",
            "-",
        ]
    ).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sd)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sd)]
    report["silences"] = [[round(s, 1), round(e, 1)] for s, e in zip(starts, ends)]

    model = next(
        (
            MODELS / m
            for m in ("ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin")
            if (MODELS / m).exists()
        ),
        None,
    )
    transcript = []
    if model:
        tr = run(["whisper-cli", "-m", str(model), "-f", str(wav), "-l", "auto"]).stdout
        transcript = [
            ln.strip() for ln in tr.splitlines() if ln.strip().startswith("[")
        ]
    report["transcript"] = transcript
    heard = [
        k for ln in transcript for k in map(key, ln.split("]", 1)[-1].split()) if k
    ]
    if a.script:
        lines = [
            ln.strip() for ln in Path(a.script).read_text().splitlines() if ln.strip()
        ]
        report["lines"] = [
            {"line": ln[:60], "heard": coverage(ln, heard)} for ln in lines
        ]
        report["worst_line"] = min((x["heard"] for x in report["lines"]), default=1.0)

    run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            "-lavfi",
            "showspectrumpic=s=1400x500:legend=1:scale=log",
            str(out / "spectrum.png"),
        ]
    )
    report["spectrum"] = str(out / "spectrum.png")
    if media.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"):
        w = run(
            [
                sys.executable,
                str(WATCH),
                str(media),
                "--fps",
                "0.5",
                "--out-dir",
                str(out / "frames"),
            ]
        )
        try:
            report["contact_sheet"] = json.loads(w.stdout)["contact_sheet"]
        except (ValueError, KeyError):
            report["contact_sheet"] = None

    problems = []
    if not -18 <= report["lufs"] <= -14:
        problems.append(f"loudness {report['lufs']} LUFS, aim for about -16")
    if report["true_peak_db"] > -1:
        problems.append(f"true peak {report['true_peak_db']} dB, keep it under -1")
    if report["silences"]:
        problems.append(f"{len(report['silences'])} silences of 0.4 s or more")
    if a.script and report["worst_line"] < 0.8:
        problems.append(
            "a scripted line is hard to hear in the transcript, listen-check it"
        )
    report["problems"] = problems
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
