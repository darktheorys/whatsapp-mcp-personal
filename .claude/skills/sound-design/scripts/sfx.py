#!/usr/bin/env python3
"""Synthesises a small sound kit and a cheesy General-MIDI-style music bed, so a video or voice note
can be scored without downloading anyone's audio. Everything is generated from scratch with numpy,
so the result is ours to send anywhere.

    sfx.py kit OUT_DIR                       # whoosh, ding, pop, boing, typewriter, drumroll, tada,
                                             # applause, sad-trombone, scratch, rimshot (44.1 kHz wav)
    sfx.py bed OUT.wav --seconds 24 [--bpm 112] [--key 0] [--mood happy|sad|tense]

Prints one JSON line with what it wrote.
"""

import argparse
import json
import os
import sys
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VENV_PY = REPO / "state" / "imggen-venv" / "bin" / "python"

try:
    import numpy as np  # pyright: ignore[reportMissingImports]
except ImportError:
    # numpy lives in the image venv. Re-run this file with that interpreter.
    if VENV_PY.exists() and Path(sys.executable).resolve() != VENV_PY.resolve():
        os.execv(VENV_PY, [str(VENV_PY), *sys.argv])
    print(json.dumps({"ok": False, "error": "numpy is missing (state/imggen-venv)"}))
    sys.exit(1)

SR = 44100
rng = np.random.default_rng(7)


def t(sec):
    return np.arange(int(SR * sec)) / SR


def env(n, attack=0.005, release=0.1):
    """Attack-decay envelope over n samples, exponential tail."""
    a = max(1, int(SR * attack))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    tail = np.arange(n - a) / SR
    e[a:] = np.exp(-tail / max(release, 1e-3))
    # Always end at zero: a note cut off mid-wave is a click, which shows as a full-height line on a
    # spectrogram and as a tick to the ear.
    f = min(n, int(SR * 0.004))
    e[n - f :] *= np.linspace(1, 0, f)
    return e


def norm(x, peak=0.9):
    m = np.max(np.abs(x)) or 1.0
    return x / m * peak


def lowpass(x, cutoff):
    # One-pole low-pass, enough to soften noise.
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def save(path, x):
    x = np.clip(x, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def tone(freq, sec, kind="sine", vib=0.0):
    tt = t(sec)
    f = freq * (1 + vib * np.sin(2 * np.pi * 5.5 * tt))
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "square":
        return np.sign(np.sin(ph)) * 0.6
    if kind == "saw":
        return 2 * ((ph / (2 * np.pi)) % 1) - 1
    if kind == "brass":  # saw softened, the cheap "ta-da" horn
        return lowpass(2 * ((ph / (2 * np.pi)) % 1) - 1, 2200)
    return np.sin(ph)


# ---- the kit ---------------------------------------------------------------------------------


def whoosh():
    n = int(SR * 0.7)
    noise = rng.standard_normal(n)
    sweep = np.linspace(400, 6000, n) ** 1.0
    out = np.zeros(n)
    acc = 0.0
    for i in range(n):  # moving one-pole filter: a rising whoosh
        a = np.exp(-2 * np.pi * sweep[i] / SR)
        acc = (1 - a) * noise[i] + a * acc
        out[i] = acc
    shape = np.sin(np.linspace(0, np.pi, n)) ** 2
    return norm(out * shape, 0.7)


def ding():
    tt = t(1.6)
    x = sum(
        a * np.sin(2 * np.pi * f * tt)
        for f, a in ((1320, 1), (2640, 0.35), (3960, 0.15), (1980, 0.2))
    )
    return norm(x * env(len(tt), 0.002, 0.45), 0.8)


def pop():
    tt = t(0.12)
    f = np.linspace(900, 250, len(tt))
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(tt), 0.001, 0.03), 0.8)


def boing():
    tt = t(0.7)
    f = 180 + 120 * np.exp(-tt * 6) * np.sin(2 * np.pi * 9 * tt) + 80 * np.exp(-tt * 3)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return norm(x * env(len(tt), 0.003, 0.35), 0.8)


def typewriter(clicks=10, gap=0.11):
    out = np.zeros(int(SR * (clicks * gap + 0.4)))
    for k in range(clicks):
        start = int(SR * (k * gap + rng.uniform(-0.015, 0.015)))
        n = int(SR * 0.03)
        burst = rng.standard_normal(n) * env(n, 0.0005, 0.006)
        out[start : start + n] += burst * rng.uniform(0.6, 1.0)
    bell = ding()[: int(SR * 0.6)] * 0.5  # the carriage-return bell
    out[-len(bell) :] += bell
    return norm(out, 0.8)


def drumroll(sec=2.2):
    n = int(SR * sec)
    out = np.zeros(n + SR // 2)
    hits = np.arange(0, sec, 1 / 22)
    for k, h in enumerate(hits):
        m = int(SR * 0.05)
        s = int(SR * h)
        crescendo = 0.35 + 0.65 * (k / len(hits))
        out[s : s + m] += (
            lowpass(rng.standard_normal(m), 3500) * env(m, 0.001, 0.02) * crescendo
        )
    # The closing cymbal crash.
    m = int(SR * 0.5)
    crash = lowpass(rng.standard_normal(m), 9000) * env(m, 0.001, 0.18)
    out[n : n + m] += crash * 1.2
    return norm(out, 0.85)


def tada():
    parts = []
    for f, sec in ((523.25, 0.16), (783.99, 0.9)):
        chord = sum(tone(f * r, sec, "brass", 0.006) for r in (1, 1.26, 1.5))
        parts.append(chord * env(int(SR * sec), 0.01, sec * 0.8))
    return norm(np.concatenate(parts), 0.85)


def applause(sec=2.8):
    n = int(SR * sec)
    out = np.zeros(n)
    for _ in range(int(sec * 140)):  # many short claps at random
        s = rng.integers(0, n - 2000)
        m = int(SR * 0.012)
        out[s : s + m] += (
            lowpass(rng.standard_normal(m), 4000)
            * env(m, 0.0005, 0.004)
            * rng.uniform(0.3, 1)
        )
    shape = np.minimum(1, np.linspace(0, 6, n)) * np.minimum(1, np.linspace(4, 0, n))
    return norm(out * shape, 0.75)


def sad_trombone():
    notes = ((293.66, 0.45), (277.18, 0.45), (261.63, 0.45), (246.94, 1.4))
    parts = []
    for i, (f, sec) in enumerate(notes):
        x = tone(f, sec, "brass", 0.02 if i == 3 else 0.004)
        if i == 3:  # the long wobbling "waaah"
            x *= 1 + 0.35 * np.sin(2 * np.pi * 6 * t(sec))
        parts.append(x * env(int(SR * sec), 0.03, sec * 0.9))
    return norm(np.concatenate(parts), 0.8)


def scratch():
    tt = t(0.45)
    f = 900 * np.exp(-tt * 5) + 120
    x = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.4 + lowpass(
        rng.standard_normal(len(tt)), 2500
    )
    return norm(x * env(len(tt), 0.002, 0.15), 0.75)


def rimshot():  # ba-dum-tss
    out = np.zeros(int(SR * 1.1))
    for at, f in ((0.0, 180), (0.16, 140)):
        n = int(SR * 0.12)
        s = int(SR * at)
        out[s : s + n] += np.sin(2 * np.pi * f * t(0.12)) * env(n, 0.001, 0.05)
    n = int(SR * 0.7)
    s = int(SR * 0.34)
    out[s : s + n] += lowpass(rng.standard_normal(n), 10000) * env(n, 0.001, 0.2) * 0.6
    return norm(out, 0.85)


KIT = {
    "whoosh": whoosh,
    "ding": ding,
    "pop": pop,
    "boing": boing,
    "typewriter": typewriter,
    "drumroll": drumroll,
    "tada": tada,
    "applause": applause,
    "sad-trombone": sad_trombone,
    "scratch": scratch,
    "rimshot": rimshot,
}

# ---- the music bed ---------------------------------------------------------------------------

MOODS = {
    # Chord roots in semitones from the key, and which scale degrees the arpeggio walks.
    "happy": ([0, 7, 9, 5], (0, 4, 7, 12)),  # I V vi IV, the cheesy pop progression
    "sad": ([9, 5, 0, 7], (0, 3, 7, 12)),  # vi IV I V, minor-flavoured
    "tense": ([0, 1, 0, 6], (0, 3, 6, 9)),  # chromatic, for "PEKİ NE DEMİŞ?"
}


def bed(seconds, bpm=112, key=0, mood="happy"):
    roots, arp = MOODS[mood]
    beat = 60 / bpm
    bar = 4 * beat
    total = int(SR * seconds)
    bars = int(np.ceil(seconds / bar))
    out = np.zeros(
        int(SR * bars * bar) + SR
    )  # whole bars, trimmed to length at the end
    base = 261.63 * 2 ** (key / 12)
    minor = mood != "happy"
    for b in range(bars):
        root = base * 2 ** (roots[b % len(roots)] / 12)
        start = int(SR * b * bar)
        # Bass on beats one and three, an octave down: a round tone with two soft harmonics. A square
        # wave here buzzed all the way up the spectrum, nothing like the smooth beds in the references.
        for k in (0, 2):
            n = int(SR * beat * 0.9)
            s = start + int(SR * k * beat)
            tb = t(beat * 0.9)
            f0 = root / 2
            body = (
                np.sin(2 * np.pi * f0 * tb)
                + 0.3 * np.sin(4 * np.pi * f0 * tb)
                + 0.12 * np.sin(6 * np.pi * f0 * tb)
            )
            out[s : s + n] += body * env(n, 0.008, 0.3) * 0.32
        # Arpeggio: eighth notes, a plucked sine with a little harmonic, the "General MIDI" piano.
        for k in range(8):
            semis = arp[k % len(arp)] + (3 if minor and arp[k % len(arp)] == 4 else 0)
            f = root * 2 ** (semis / 12) * 2
            n = int(SR * beat / 2)
            s = start + int(SR * k * beat / 2)
            note = np.sin(2 * np.pi * f * t(beat / 2)) + 0.3 * np.sin(
                4 * np.pi * f * t(beat / 2)
            )
            out[s : s + n] += note * env(n, 0.002, 0.12) * 0.22
        # Hi-hat ticks on the off-beats.
        for k in range(4):
            n = int(SR * 0.03)
            s = start + int(SR * (k + 0.5) * beat)
            out[s : s + n] += rng.standard_normal(n) * env(n, 0.0005, 0.008) * 0.05
    out = out[:total]
    fade = int(SR * 0.6)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return norm(out, 0.7)


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("kit")
    k.add_argument("out_dir")
    b = sub.add_parser("bed")
    b.add_argument("out")
    b.add_argument("--seconds", type=float, required=True)
    b.add_argument("--bpm", type=int, default=112)
    b.add_argument("--key", type=int, default=0, help="semitones above C")
    b.add_argument("--mood", choices=sorted(MOODS), default="happy")
    a = p.parse_args()
    if a.cmd == "kit":
        out = Path(a.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for name, make in KIT.items():
            save(out / f"{name}.wav", make())
        print(json.dumps({"ok": True, "dir": str(out), "sounds": sorted(KIT)}))
    else:
        if not 1 <= a.seconds <= 600:
            p.error("--seconds must be 1 to 600")
        save(a.out, bed(a.seconds, a.bpm, a.key, a.mood))
        print(json.dumps({"ok": True, "out": a.out, "seconds": a.seconds}))


if __name__ == "__main__":
    main()
