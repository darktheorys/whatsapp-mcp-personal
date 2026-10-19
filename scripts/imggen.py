#!/usr/bin/env python3
"""Local image generation and photo editing for chat requests (Apple Silicon, mflux).

    python3 scripts/imggen.py generate --prompt "a red fez on a desk" --out <scratchpad>/outbox/fez.png
    python3 scripts/imggen.py edit --image <photo> --prompt "make the fez blue" --out <scratchpad>/outbox/fez2.png

generate  Qwen-Image 2.1 by default, 4-bit, 30 steps, 768px. --model picks another: z, dev, schnell,
          or a name from state/imggen-models.json (--list-models).
edit      FLUX.1 Kontext dev, 4-bit, 20 steps. About 11 minutes, 13.8 GB peak. Colour and style changes work
          well, adding new objects is unreliable.

--negative TEXT is passed through to every model. Only models that use classifier-free guidance act on it, the
guidance-distilled ones (Z-Image-Turbo, FLUX.1 dev and schnell, Kontext) accept it and ignore it.

There is no resident service. Each call loads the model (15 to 20 seconds), renders, and exits, so nothing
holds memory between requests. A lock file serialises calls: two image models do not fit next to the voice
service on 32 GB, so a second request waits for the first. The result is written to state/outbox/ or a
session scratchpad's outbox/ folder, the folders the send tools accept. --any-out allows any other
path, for runs from the terminal.

The Hugging Face token is read from state/hf-token and passed to the child process through its environment
only. It is never printed or logged. Output goes to state/imggen.log (gitignored), progress bars off.
Nothing is downloaded unless --online is passed, so picking a model that is not on disk fails at once instead
of starting a 30 GB fetch.
Prints one JSON line: {"ok": true, "out": ..., "seconds": ...} or {"ok": false, "error": ...}.
"""

import argparse
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[1]
BIN = REPO / "state" / "imggen-venv" / "bin"
TOKEN_FILE = REPO / "state" / "hf-token"
LOCK_FILE = REPO / "state" / "imggen.lock"
LOG_FILE = REPO / "state" / "imggen.log"
TMP_ROOT = Path(f"/private/tmp/claude-{os.getuid()}")
OUTBOX = REPO / "state" / "outbox"
MODELS_FILE = REPO / "state" / "imggen-models.json"
LEDGER_FILE = REPO / "state" / "models.json"
DEFAULT_MODEL = "qwen"

# Models `generate` can use, by name (--model NAME). More can be added without touching this file: put
# them in state/imggen-models.json (gitignored, hand-edited), or install them with
# `install_model.py --as NAME ...`, which records the settings in state/models.json. A personal model
# that must not be in a public repo belongs in one of those two files:
#
#   { "burak": { "command": "mflux-generate", "model": "owner/name", "base_model": "dev",
#                "quantize": 4, "steps": 20, "lora_paths": ["state/models/burak.safetensors"],
#                "lora_scales": [1.0] } }
#
# An entry names an mflux generate command and the options for it, nothing else: the command must be an
# mflux-generate* program in the image venv, and only the keys below are accepted, so the file cannot be
# used to run something else. `model` is a Hugging Face repo or a local folder, `base_model` says which
# architecture a third-party model is built on (schnell, dev, ...), see install_model.py for fetching one.
BUILTIN_MODELS = {
    "qwen": {
        "command": "mflux-generate-qwen-2.1",
        "model": "mlx-community/Qwen-Image-2.1-mflux-q4",
        "steps": 30,
    },
    "z": {"command": "mflux-generate-z-image-turbo", "quantize": 4, "steps": 8},
    "dev": {"command": "mflux-generate", "model": "dev", "quantize": 4, "steps": 20},
    "schnell": {
        "command": "mflux-generate",
        "model": "madroid/flux.1-schnell-mflux-4bit",
        "base_model": "schnell",
        "steps": 4,
    },
}
MODEL_KEYS = {
    "command": str,
    "model": str,
    "base_model": str,
    "steps": int,
    "quantize": int,
    "guidance": (int, float),
    "lora_paths": list,
    "lora_scales": list,
}
MODEL_NAME = re.compile(r"^[a-z0-9_-]{1,40}$")


def validate_spec(name, spec, source):
    """Fail unless `spec` is a plain mflux-generate command with only the accepted settings."""
    if not MODEL_NAME.match(name):
        fail(f"{source}: model name '{name}' must be lowercase letters, digits, - or _")
    if not isinstance(spec, dict):
        fail(f"{source}: model '{name}' must be an object")
    for key, value in spec.items():
        if key not in MODEL_KEYS or isinstance(value, bool):
            fail(f"{source}: model '{name}': '{key}' is not an accepted setting")
        if not isinstance(value, MODEL_KEYS[key]):
            fail(f"{source}: model '{name}': '{key}' has the wrong type")
    command = spec.get("command", "")
    if not command.startswith("mflux-generate") or "/" in command:
        fail(f"{source}: model '{name}': command must be an mflux-generate* program")
    if not (BIN / command).exists():
        fail(f"{source}: model '{name}': {command} is not in the image venv")
    if spec.get("quantize") not in (None, 3, 4, 5, 6, 8):
        fail(f"{source}: model '{name}': quantize must be 3, 4, 5, 6 or 8")
    loras = spec.get("lora_paths", [])
    if len(loras) != len(spec.get("lora_scales", loras)):
        fail(
            f"{source}: model '{name}': lora_paths and lora_scales need the same length"
        )


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as err:
        fail(f"{path.name} is not valid JSON: {err}")


def load_models():
    """Built-in names, then state/imggen-models.json, then the installs recorded in state/models.json
    that were given a name with `install_model.py --as NAME`. Built-ins cannot be replaced."""
    models = dict(BUILTIN_MODELS)
    extra = {}
    if MODELS_FILE.exists():
        extra = read_json(MODELS_FILE)
        if not isinstance(extra, dict):
            fail("state/imggen-models.json must be an object of name -> settings")
        for name, spec in extra.items():
            validate_spec(name, spec, "state/imggen-models.json")
    if LEDGER_FILE.exists():
        ledger = read_json(LEDGER_FILE)
        for row in ledger if isinstance(ledger, list) else []:
            name, spec = row.get("alias"), row.get("imggen")
            if not name or spec is None:
                continue
            validate_spec(name, spec, "state/models.json")
            extra.setdefault(
                name, spec
            )  # the hand-written file wins over an install record
    for name, spec in extra.items():
        if name in BUILTIN_MODELS:
            # state/models.json also records the built-in models themselves, with the same settings.
            # Anything that says different is refused: a built-in name is never redefined.
            if spec != BUILTIN_MODELS[name]:
                fail(f"'{name}' is a built-in name and cannot be redefined")
            continue
        models[name] = spec
    return models


def generate_command(spec, a, out):
    cmd = [str(BIN / spec["command"])]
    if spec.get("model"):
        cmd += ["--model", spec["model"]]
    if spec.get("base_model"):
        cmd += ["--base-model", spec["base_model"]]
    if spec.get("quantize"):
        cmd += ["-q", str(spec["quantize"])]
    if spec.get("lora_paths"):
        cmd += ["--lora-paths", *map(str, spec["lora_paths"])]
        if spec.get("lora_scales"):
            cmd += ["--lora-scales", *map(str, spec["lora_scales"])]
    if spec.get("guidance") is not None:
        cmd += ["--guidance", str(spec["guidance"])]
    if a.negative:
        cmd += ["--negative-prompt", a.negative]
    if a.steps_dir:
        cmd += ["--stepwise-image-output-dir", a.steps_dir]
    return cmd + [
        "--prompt",
        a.prompt,
        "--steps",
        str(a.steps or spec.get("steps", 20)),
        "--seed",
        str(a.seed),
        "--width",
        str(a.width or 768),
        "--height",
        str(a.height or 768),
        "--output",
        str(out),
    ]


def fail(message, code=1) -> NoReturn:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def last_error():
    """The last Python error line from this run's log, so a failed render says why (for example a LoRA
    whose weight names mflux does not recognise) instead of only pointing at the log."""
    try:
        tail = LOG_FILE.read_bytes()[-6000:].decode("utf-8", "ignore")
    except OSError:
        return ""
    lines = [ln.strip() for ln in tail.splitlines() if re.search(r"\w+Error: ", ln)]
    return f": {lines[-1][:300]}" if lines else ""


def in_send_source(parent):
    """True for state/outbox/ and a session scratchpad's outbox/, the folders a send tool accepts."""
    if parent == OUTBOX.resolve():
        return True
    try:
        rel = parent.relative_to(TMP_ROOT.resolve())
    except ValueError:
        return False
    parts = rel.parts
    return "scratchpad" in parts and parts[parts.index("scratchpad") + 1 :] == (
        "outbox",
    )


def check_out(path, any_out=False):
    """The output goes to a send source (state/outbox/ or a scratchpad outbox/), so a picture can only be
    sent to a chat from where the send tools look. --any-out lifts this for the owner's own terminal
    runs, which may write anywhere."""
    out = Path(path)
    if out.suffix.lower() != ".png":
        fail("--out must end in .png")
    parent = out.parent.resolve()
    if not any_out and not in_send_source(parent):
        fail(
            "--out must be in state/outbox/ or a scratchpad outbox/ folder "
            "(pass --any-out to write elsewhere from the terminal)"
        )
    return parent / out.name


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("mode", choices=["generate", "edit"], nargs="?")
    p.add_argument("--prompt")
    p.add_argument("--out")
    p.add_argument("--image", help="source photo for edit")
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="generate only: a model name, qwen (default), z, dev, schnell, or one from "
        "state/imggen-models.json. See --list-models.",
    )
    p.add_argument("--list-models", action="store_true", help="print the model names")
    p.add_argument(
        "--width", type=int, help="default 768 for generate, the source size for edit"
    )
    p.add_argument(
        "--height", type=int, help="default 768 for generate, the source size for edit"
    )
    p.add_argument("--steps", type=int)
    p.add_argument(
        "--steps-dir",
        help="save the image after every step here (mflux --stepwise-image-output-dir), "
        "so a running render can be looked at before it finishes",
    )
    p.add_argument(
        "--negative",
        help="negative prompt, passed to mflux as --negative-prompt. Only models that use "
        "classifier-free guidance act on it; the guidance-distilled ones (Z-Image-Turbo, "
        "FLUX.1 dev and schnell, Kontext) accept it and ignore it.",
    )
    p.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    p.add_argument(
        "--online", action="store_true", help="allow downloading a missing model"
    )
    p.add_argument(
        "--any-out",
        action="store_true",
        help="allow --out outside state/outbox/ and a scratchpad outbox/ (terminal use)",
    )
    p.add_argument(
        "--wait",
        type=int,
        default=1800,
        help="seconds to wait for another render to finish",
    )
    a = p.parse_args()

    models = load_models()
    if a.list_models:
        for name, spec in models.items():
            where = spec.get("model", spec["command"])
            print(f"{name:12} {where}  steps {spec.get('steps', 20)}")
        return
    if not (a.mode and a.prompt and a.out):
        p.error("mode, --prompt and --out are required (or --list-models)")
    if a.mode == "generate" and a.model not in models:
        fail(f"unknown model '{a.model}'. Known: {', '.join(sorted(models))}")
    if a.mode == "edit" and a.model != DEFAULT_MODEL:
        fail("edit always uses Kontext, --model applies to generate only")

    out = check_out(a.out, a.any_out)
    if not (BIN / "mflux-generate").exists():
        fail(
            "the image venv is missing (state/imggen-venv), see the image-generation skill"
        )
    if not TOKEN_FILE.exists():
        fail("state/hf-token is missing")
    if a.mode == "edit":
        if not a.image or not Path(a.image).is_file():
            fail("edit needs --image pointing at an existing file")

    if a.mode == "generate":
        cmd = generate_command(models[a.model], a, out)
    else:
        cmd = [
            str(BIN / "mflux-generate-kontext"),
            "-q",
            "4",
            "--image-path",
            a.image,
            "--prompt",
            a.prompt,
            "--steps",
            str(a.steps or 20),
            "--seed",
            str(a.seed),
            "--output",
            str(out),
        ]
        if a.width:
            cmd += ["--width", str(a.width)]
        if a.height:
            cmd += ["--height", str(a.height)]
        if a.negative:
            cmd += ["--negative-prompt", a.negative]

    env = dict(os.environ)
    env["HF_TOKEN"] = TOKEN_FILE.read_text().strip()
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    if not a.online:
        env["HF_HUB_OFFLINE"] = "1"

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_FILE, "w")
    deadline = time.time() + a.wait
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                fail("another image render is still running", code=3)
            time.sleep(5)

    start = time.time()
    with open(LOG_FILE, "ab") as log:
        log.write(f"\n== {time.strftime('%F %T')} {a.mode} seed={a.seed}\n".encode())
        proc = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)

        def stop(signum, frame):
            """A SIGTERM (the server's /generate cancel) must stop the mflux child too, or it would
            keep the GPU busy as an orphan after this script is gone."""
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
            out.unlink(missing_ok=True)
            sys.exit(143)

        signal.signal(signal.SIGTERM, stop)
        returncode = proc.wait()
    seconds = round(time.time() - start)
    if returncode != 0 or not out.exists():
        fail(
            f"the render failed (exit {returncode}){last_error()}, see state/imggen.log"
        )
    print(json.dumps({"ok": True, "out": str(out), "seconds": seconds}))


if __name__ == "__main__":
    main()
