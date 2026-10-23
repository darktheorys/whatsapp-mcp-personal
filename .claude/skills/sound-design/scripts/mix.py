#!/usr/bin/env python3
"""Mixes a soundtrack from a timeline: a music bed under everything, voice lines and effects placed
at given seconds, each brought to a target loudness, the bed ducked while someone speaks, and the
whole thing normalised for a phone speaker.

    mix.py TIMELINE.json OUT.wav

TIMELINE.json (every number is optional except `at`; paths are local files):
    {
      "length": 24,                                   # seconds; default: last event end + 1.5 s
      "bed":   {"file": "bed.wav", "lufs": -28, "fade_in": 0.6, "fade_out": 1.5},
      "voice": [{"file": "line1.wav", "at": 2.0}],    # each line brought to -21 LUFS
      "fx":    [{"file": "tada.wav", "at": 9.4, "gain_db": 0}],   # each effect peaks at -6 dBFS
      "duck_db": 4,                                   # bed reduction while a voice line plays
      "master_lufs": -16                              # final loudness, true peak -1.5 dBFS
    }

The defaults come from measuring narrated joke videos (see SKILL.md): bed about 6-7 dB under the
voice, voice near -21 LUFS, the finished track around -16 LUFS for a phone. Prints one JSON line.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

VOICE_LUFS = -21.0
BED_LUFS = -28.0
FX_PEAK_DB = -6.0


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def duration(path):
    out = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ]
    ).stdout
    return float(out.strip() or 0)


def lufs(path):
    """Integrated loudness, or None when the clip is shorter than the 400 ms gating window."""
    err = run(
        ["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"]
    ).stderr
    found = re.findall(r"I:\s*(-?[\d.]+) LUFS", err)
    value = float(found[-1]) if found else None
    return None if value is None or value < -69 else value


def peak_db(path):
    err = run(
        ["ffmpeg", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"]
    ).stderr
    found = re.findall(r"max_volume: (-?[\d.]+) dB", err)
    return float(found[-1]) if found else 0.0


def gain_for(path, target_lufs=None, target_peak=None):
    if target_lufs is not None:
        measured = lufs(path)
        if measured is not None:
            return target_lufs - measured
    return (target_peak if target_peak is not None else FX_PEAK_DB) - peak_db(path)


def main():
    spec_path, out = Path(sys.argv[1]), Path(sys.argv[2])
    spec = json.loads(spec_path.read_text())
    voice, fx, bed = spec.get("voice", []), spec.get("fx", []), spec.get("bed")
    events = [(e["at"] + duration(e["file"])) for e in voice + fx]
    length = float(spec.get("length") or (max(events, default=0) + 1.5))

    inputs, chains, labels = [], [], {"voice": [], "fx": []}
    count = 0  # ffmpeg input index, not the length of the argument list
    for kind, items in (("voice", voice), ("fx", fx)):
        for e in items:
            i = count
            count += 1
            inputs += ["-i", e["file"]]
            g = gain_for(e["file"], VOICE_LUFS if kind == "voice" else None) + e.get(
                "gain_db", 0
            )
            ms = int(e["at"] * 1000)
            chains.append(
                f"[{i}:a]aresample=44100,aformat=channel_layouts=mono,volume={g:.2f}dB,adelay={ms}|{ms}[{kind}{i}]"
            )
            labels[kind].append(f"[{kind}{i}]")

    def bus(name, parts):
        if not parts:
            chains.append(f"anullsrc=r=44100:cl=mono,atrim=0:{length:.2f}[{name}]")
        elif len(parts) == 1:
            chains.append(f"{parts[0]}apad,atrim=0:{length:.2f}[{name}]")
        else:
            chains.append(
                f"{''.join(parts)}amix=inputs={len(parts)}:normalize=0,apad,atrim=0:{length:.2f}[{name}]"
            )

    bus("vbus", labels["voice"])
    bus("fxbus", labels["fx"])

    mix_inputs = ["[vmain]", "[fxbus]"]
    if bed:
        i = count
        count += 1
        inputs += ["-stream_loop", "-1", "-i", bed["file"]]
        g = gain_for(bed["file"], bed.get("lufs", BED_LUFS))
        fi, fo = bed.get("fade_in", 0.6), bed.get("fade_out", 1.5)
        chains.append(
            f"[{i}:a]aresample=44100,aformat=channel_layouts=mono,atrim=0:{length:.2f},volume={g:.2f}dB,"
            f"afade=t=in:d={fi},afade=t=out:st={max(0, length - fo):.2f}:d={fo}[bedraw]"
        )
        duck = spec.get("duck_db", 4)
        if voice and duck:
            # The voice bus drives a compressor on the bed: the bed dips while someone speaks and comes
            # back in the pauses, which is what keeps a narrated joke clear over its music.
            chains.append("[vbus]asplit=2[vmain][vkey]")
            ratio = 1 + duck / 2
            chains.append(
                f"[bedraw][vkey]sidechaincompress=threshold=0.03:ratio={ratio:.1f}:attack=20:release=350[bed]"
            )
        else:
            chains.append("[vbus]anull[vmain]")
            chains.append("[bedraw]anull[bed]")
        mix_inputs.append("[bed]")
    else:
        chains.append("[vbus]anull[vmain]")

    master = spec.get("master_lufs", -16)
    chains.append(
        f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:normalize=0,"
        f"loudnorm=I={master}:TP=-1.5:LRA=11,aresample=44100[out]"
    )
    res = run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            *inputs,
            "-filter_complex",
            ";".join(chains),
            "-map",
            "[out]",
            "-t",
            f"{length:.2f}",
            "-c:a",
            "pcm_s16le",
            str(out),
        ]
    )
    if res.returncode:
        print(json.dumps({"ok": False, "error": res.stderr.strip()[-400:]}))
        sys.exit(1)
    print(
        json.dumps(
            {
                "ok": True,
                "out": str(out),
                "seconds": round(length, 2),
                "lufs": lufs(out),
            }
        )
    )


if __name__ == "__main__":
    main()
