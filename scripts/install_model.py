#!/usr/bin/env python3
"""Download a model from Hugging Face. Run it yourself, nothing here is wired into a chat.

    python3 scripts/install_model.py <owner/name>                       show what it would fetch, ask, fetch
    python3 scripts/install_model.py <owner/name> --yes                  skip the question
    python3 scripts/install_model.py <owner/name> --include "*.safetensors" "*.json"
    python3 scripts/install_model.py <owner/name> --revision <branch|tag|sha>
    python3 scripts/install_model.py <owner/name> --local-dir state/models/<name>
    python3 scripts/install_model.py <owner/name> --as burak           also make it usable as
                                                  `imggen.py generate --model burak`
    python3 scripts/install_model.py --seed-existing                     record what imggen.py already uses (once)
    python3 scripts/install_model.py --list                              what this script has installed

Before it downloads anything it prints the repo's licence tag, whether it is gated, the file count and
total size, and whether the weights are in a safe format. It then checks free disk space, and asks.
It refuses a repo whose weights are only pickle files (.bin, .pt, .pth, .pkl, .ckpt): loading a pickle
runs code from the file, and a model repo is whoever uploaded it. Pass --allow-pickle to override, once
you have read the repo.

Weights go to the normal Hugging Face cache (~/.cache/huggingface) unless --local-dir is given, which
must be under state/models/. The Hugging Face token comes from state/hf-token (or HF_TOKEN) and is only
ever sent to huggingface.co by the library. It is never printed. Each install is appended to
state/models.json (gitignored) with the repo, revision, size and date. The file is append-only: a record
is never rewritten or removed by this script and a name given with --as can never be reused. With --as NAME the settings for
scripts/imggen.py (the mflux command, the base architecture, steps, quantize, and for a LoRA its file and
scale) go in the same record, and imggen.py finds the model there by that name. Whether the repo is a
LoRA, which base it is built on and which file holds the weights are read from the repo's Hub tags and
card data and shown before the download; --base, --lora, --full and --lora-file override what it
reads, and it stops and asks when it cannot tell.

This needs the image environment (state/imggen-venv, see the image-generation skill), which has
huggingface_hub, and re-runs itself inside it.
"""

import argparse
import fnmatch
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VENV_PY = REPO / "state" / "imggen-venv" / "bin" / "python"
TOKEN_FILE = REPO / "state" / "hf-token"
LEDGER = REPO / "state" / "models.json"
MODELS_DIR = REPO / "state" / "models"

REPO_ID = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$")
PICKLE = (".bin", ".pt", ".pth", ".pkl", ".pickle", ".ckpt")
SAFE = (".safetensors", ".gguf", ".onnx")
DISK_MARGIN = 5 * 1024**3  # keep at least this much free after the download


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def reexec_in_venv():
    """Run inside the image venv, which has huggingface_hub, when we are not already in it."""
    if Path(sys.prefix).resolve() == (REPO / "state" / "imggen-venv").resolve():
        return
    if not VENV_PY.exists():
        sys.exit(
            "state/imggen-venv is missing. Create it first:\n"
            "  python3.12 -m venv state/imggen-venv && "
            "state/imggen-venv/bin/pip install mflux"
        )
    os.execv(str(VENV_PY), [str(VENV_PY), *sys.argv])


def token():
    if os.environ.get("HF_TOKEN"):
        return os.environ["HF_TOKEN"].strip()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    return None


def selected(files, include, exclude):
    out = []
    for name, size in files:
        if include and not any(fnmatch.fnmatch(name, p) for p in include):
            continue
        if exclude and any(fnmatch.fnmatch(name, p) for p in exclude):
            continue
        out.append((name, size))
    return out


# Which mflux architecture name a base repo corresponds to, so `--as NAME` can work out `--base` itself.
BASE_NAMES = (
    ("flux.1-krea", "krea-dev"),
    ("flux.1-dev", "dev"),
    ("flux.1-schnell", "schnell"),
)
LORA_FILE_HINTS = ("lora", "adapter")
# Steps and quantisation imggen.py will use for a base architecture unless --steps / --quantize say otherwise.
RUN_DEFAULTS = {"dev": (20, 4), "schnell": (4, 4), "krea-dev": (28, 4)}
BUILTIN_NAMES = ("z", "dev", "schnell")


def alias_problem(name, command):
    """Why `name` cannot be used as an imggen name, or None. Append-only: a taken name is never reused."""
    if not re.match(r"^[a-z0-9_-]{1,40}$", name):
        return "the name must be lowercase letters, digits, - or _ (max 40)."
    if name in BUILTIN_NAMES:
        return f"'{name}' is a built-in imggen name, pick another."
    if not (command.startswith("mflux-generate") and "/" not in command):
        return "--command must be an mflux-generate* program."
    if any(r.get("alias") == name for r in read_ledger()):
        return (
            f"'{name}' is already in state/models.json. The ledger is append-only, so a name "
            "is never reused or replaced: pick another one."
        )
    return None


def imggen_spec(plan, a, path):
    """The settings imggen.py needs to run this model, from what was detected plus the overrides."""
    steps, quant = RUN_DEFAULTS.get(plan["base"], (20, 4))
    spec = {"command": a.command}
    if plan["lora"]:
        weights = Path(path) / plan["lora_file"]
        if not weights.is_file():
            sys.exit(f"{plan['lora_file']} is not in the download, nothing to use.")
        spec |= {
            "model": plan["base"],
            "lora_paths": [str(weights)],
            "lora_scales": [a.lora_scale],
        }
    else:
        spec |= {"model": a.repo, "base_model": plan["base"]}
    spec["steps"] = a.steps or steps
    spec["quantize"] = a.quantize or quant
    return spec


def base_repos(info):
    """Repos this model says it is built on, from its Hub tags and card data."""
    found = []
    for tag in info.tags or []:
        m = re.match(r"^base_model:(?:adapter|finetune|quantized|merge):(.+)$", tag)
        if m:
            found.append(m.group(1))
    card = getattr(info, "card_data", None)
    declared = (card.to_dict().get("base_model") if card else None) or []
    found += [declared] if isinstance(declared, str) else list(declared)
    return list(dict.fromkeys(found))


def detect(info, names):
    """What the Hub metadata says this repo is: a LoRA or a full model, which architecture it is built
    on, and which file holds a LoRA's weights. Anything it cannot tell is None, and the caller asks."""
    tags = info.tags or []
    weights = sorted(n for n in names if n.lower().endswith(".safetensors"))
    hinted = [w for w in weights if any(h in w.lower() for h in LORA_FILE_HINTS)]
    is_lora = (
        "lora" in tags
        or any(t.startswith("base_model:adapter:") for t in tags)
        or bool(hinted)
    )
    base = None
    for repo in base_repos(info):
        for needle, name in BASE_NAMES:
            if needle in repo.lower():
                base = name
                break
        if base:
            break
    lora_file = None
    if is_lora:
        pool = hinted or weights
        lora_file = pool[0] if len(pool) == 1 or hinted else None
    return {
        "lora": is_lora,
        "base": base,
        "base_repo": (base_repos(info) or [None])[0],
        "lora_file": lora_file,
    }


def read_ledger():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else []


def seed_existing():
    """Record the models that were installed before this ledger existed: the ones scripts/imggen.py
    already uses. Append-only and idempotent: a repo that already has a record is left alone, nothing
    is ever rewritten. Reads the Hugging Face cache, so it only records what is really on disk."""
    reexec_in_venv()
    from huggingface_hub import scan_cache_dir  # pyright: ignore[reportMissingImports]

    known = [
        (
            "Tongyi-MAI/Z-Image-Turbo",
            "z",
            {"command": "mflux-generate-z-image-turbo", "quantize": 4, "steps": 8},
            "generate, the default",
        ),
        (
            "black-forest-labs/FLUX.1-dev",
            "dev",
            {"command": "mflux-generate", "model": "dev", "quantize": 4, "steps": 20},
            "generate --model dev",
        ),
        (
            "madroid/flux.1-schnell-mflux-4bit",
            "schnell",
            {
                "command": "mflux-generate",
                "model": "madroid/flux.1-schnell-mflux-4bit",
                "base_model": "schnell",
                "steps": 4,
            },
            "generate --model schnell",
        ),
        ("black-forest-labs/FLUX.1-Kontext-dev", None, None, "edit"),
    ]
    cache = {r.repo_id: r for r in scan_cache_dir().repos if r.repo_type == "model"}
    ledger = read_ledger()
    have = {(r["repo"], r["revision"]) for r in ledger}
    added = 0
    for repo, alias, spec, role in known:
        entry = cache.get(repo)
        if not entry or not entry.revisions:
            print(f"not on disk, skipped: {repo}")
            continue
        rev = max(entry.revisions, key=lambda v: v.last_modified)
        if (repo, rev.commit_hash) in have:
            print(f"already recorded:     {repo}")
            continue
        record = {
            "date": time.strftime("%F %T"),
            "repo": repo,
            "revision": rev.commit_hash,
            "bytes": entry.size_on_disk,
            "path": str(rev.snapshot_path),
            "include": None,
            "exclude": None,
            "role": role,
            "seeded": True,
        }
        if alias:
            record["alias"] = alias
            record["imggen"] = spec
        ledger.append(record)
        added += 1
        print(
            f"recorded:             {repo}"
            + (f"  as '{alias}'" if alias else f"  ({role})")
        )
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(ledger, indent=2))
    print(f"{added} record(s) added.")


def list_installed():
    if not LEDGER.exists():
        print("Nothing installed with this script yet.")
        return
    for row in json.loads(LEDGER.read_text()):
        print(
            f"{row['date']}  {row['repo']}  {row['revision'][:8]}  "
            f"{human(row['bytes'])}  {row['path']}"
        )


def print_imggen_plan(a, plan):
    """The imggen.py settings this repo would get, printed in the preview whether or not --as was given."""
    if not plan["base"]:
        print(
            "imggen     base architecture not found in the repo's metadata "
            f"(base repo: {plan['base_repo'] or 'not stated'}), pass --base to register it"
        )
        return
    steps, quant = RUN_DEFAULTS.get(plan["base"], (20, 4))
    kind = "LoRA" if plan["lora"] else "full model"
    print(f"imggen     {kind}, base architecture '{plan['base']}'", end="")
    print(f" (from {plan['base_repo']})" if plan["base_repo"] else "")
    if plan["lora"]:
        print(f"           weights file {plan['lora_file']}   scale {a.lora_scale}")
    print(
        f"           command {a.command}   steps {a.steps or steps}   quantize {a.quantize or quant}"
    )
    print(
        f"           name '{a.alias}'"
        if a.alias
        else "           name: none yet (--as NAME, or you are asked after the download)"
    )


def main():
    p = argparse.ArgumentParser(
        description="Download a model from Hugging Face.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("repo", nargs="?", help="owner/name of the model repo")
    p.add_argument("--revision", default=None)
    p.add_argument("--include", nargs="+", default=None, help="only these files")
    p.add_argument("--exclude", nargs="+", default=None, help="skip these files")
    p.add_argument("--local-dir", default=None, help="under state/models/")
    p.add_argument("--yes", action="store_true", help="do not ask first")
    p.add_argument("--allow-pickle", action="store_true")
    p.add_argument("--list", action="store_true", help="show what is installed")
    p.add_argument(
        "--seed-existing",
        action="store_true",
        help="record the models imggen.py already uses, once, append-only",
    )
    p.add_argument("--as", dest="alias", help="name to use with imggen.py --model")
    p.add_argument("--base", help="architecture it is built on (schnell, dev, ...)")
    p.add_argument(
        "--lora", action="store_true", help="force: the repo is a LoRA for --base"
    )
    p.add_argument(
        "--full", action="store_true", help="force: a full model, not a LoRA"
    )
    p.add_argument(
        "--lora-file", help="the LoRA weights file in the repo, if there are several"
    )
    p.add_argument("--command", default="mflux-generate", help="mflux generate command")
    p.add_argument("--steps", type=int)
    p.add_argument("--quantize", type=int, choices=[3, 4, 5, 6, 8])
    p.add_argument("--lora-scale", type=float, default=1.0)
    a = p.parse_args()

    if a.list:
        list_installed()
        return
    if a.seed_existing:
        seed_existing()
        return
    if not a.repo:
        p.error("give a repo as owner/name, or --list")
    if not REPO_ID.match(a.repo):
        sys.exit(f"'{a.repo}' is not a repo id like owner/name.")

    if a.alias:
        problem = alias_problem(a.alias, a.command)
        if problem:
            sys.exit(f"--as: {problem}")

    reexec_in_venv()
    # Imported here, after the re-exec, because it only exists in the venv.
    from huggingface_hub import HfApi, snapshot_download  # pyright: ignore[reportMissingImports]

    local_dir = None
    if a.local_dir:
        local_dir = Path(a.local_dir).resolve()
        if MODELS_DIR.resolve() not in (local_dir, *local_dir.parents):
            sys.exit("--local-dir must be under state/models/.")

    tok = token()
    api = HfApi(token=tok)
    try:
        info = api.model_info(a.repo, revision=a.revision, files_metadata=True)
    except Exception as err:  # noqa: BLE001 - the message is the whole point
        sys.exit(f"Could not read {a.repo}: {err}")

    files = [(s.rfilename, s.size or 0) for s in (info.siblings or [])]
    # What the repo is, worked out before anything is downloaded and always shown, whether or not a name
    # was given, so a plain install tells you what imggen.py would do with it.
    found = detect(info, [n for n, _ in files])
    plan = {
        "lora": a.lora or (found["lora"] and not a.full),
        "base": a.base or found["base"],
        "lora_file": a.lora_file or found["lora_file"],
        "base_repo": found["base_repo"],
    }
    if a.alias:
        if not plan["base"]:
            sys.exit(
                "Could not tell which architecture this is built on from the repo's metadata "
                f"(base repo: {found['base_repo'] or 'not stated'}). Pass --base (dev, schnell, ...)."
            )
        if plan["lora"] and not plan["lora_file"]:
            sys.exit(
                "This is a LoRA but the weights file is not obvious. Pass --lora-file NAME."
            )
    if plan["lora"] and plan["lora_file"] and not a.include:
        # A LoRA is one weights file. Nothing else in the repo is needed to use it.
        a.include = [plan["lora_file"], "*.json", "*.md", "*.txt"]
    chosen = selected(files, a.include, a.exclude)
    if not chosen:
        sys.exit("No files match --include and --exclude.")
    total = sum(size for _, size in chosen)
    names = [n for n, _ in chosen]
    pickles = [n for n in names if n.lower().endswith(PICKLE)]
    safe = [n for n in names if n.lower().endswith(SAFE)]
    license_tag = next(
        (t.split(":", 1)[1] for t in (info.tags or []) if t.startswith("license:")),
        "none",
    )

    print(f"repo       {a.repo}")
    print(f"revision   {info.sha}")
    print(f"licence    {license_tag}")
    print(
        f"gated      {info.gated or 'no'}    private  {'yes' if info.private else 'no'}"
    )
    print(f"files      {len(chosen)} of {len(files)}   size  {human(total)}")
    print(f"formats    safe {len(safe)}   pickle {len(pickles)}")
    print_imggen_plan(a, plan)
    big = sorted(chosen, key=lambda f: -f[1])[:5]
    for name, size in big:
        print(f"           {human(size):>10}  {name}")

    if pickles and not safe and not a.allow_pickle:
        sys.exit(
            "\nRefusing: the weights are only pickle files, which can run code when loaded.\n"
            "Read the repo, and pass --allow-pickle if you trust it."
        )
    if pickles and not a.allow_pickle:
        print(
            "\nNote: pickle files are also in this selection. Add "
            "--include/--exclude to skip them, e.g.\n"
            '  --exclude "*.bin" "*.pt" "*.pth" "*.pkl" "*.ckpt"'
        )

    target = local_dir or Path.home() / ".cache" / "huggingface"
    target.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(target).free
    print(
        f"disk free  {human(free)}   after download about {human(max(0, free - total))}"
    )
    if free - total < DISK_MARGIN:
        sys.exit(f"\nRefusing: that would leave less than {human(DISK_MARGIN)} free.")

    if not a.yes:
        if not sys.stdin.isatty():
            sys.exit("\nNot a terminal, pass --yes to download without asking.")
        if input("\nDownload? [y/N] ").strip().lower() not in ("y", "yes"):
            sys.exit("Cancelled.")

    started = time.time()
    path = snapshot_download(
        repo_id=a.repo,
        revision=info.sha,
        allow_patterns=a.include,
        ignore_patterns=a.exclude,
        local_dir=str(local_dir) if local_dir else None,
        token=tok,
    )
    seconds = round(time.time() - started)

    # No --as: when someone is at the terminal, ask for a name now, the weights are already on disk.
    if not a.alias and plan["base"] and sys.stdin.isatty() and not a.yes:
        while True:
            answer = input(
                "\nName to use with imggen.py --model (Enter to skip): "
            ).strip()
            if not answer:
                break
            problem = alias_problem(answer, a.command)
            if problem:
                print(problem)
                continue
            a.alias = answer
            break

    record = {
        "date": time.strftime("%F %T"),
        "repo": a.repo,
        "revision": info.sha,
        "bytes": total,
        "path": path,
        "include": a.include,
        "exclude": a.exclude,
    }
    if a.alias:
        record["alias"] = a.alias
        record["imggen"] = imggen_spec(plan, a, path)
    ledger = read_ledger()
    ledger.append(record)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(ledger, indent=2))
    print(f"\nDone in {seconds}s: {path}")
    if a.alias:
        print(
            f"Use it: python3 scripts/imggen.py generate --model {a.alias} --prompt ... --out ..."
        )
    elif plan["base"]:
        print(
            f"Not registered for imggen. To register it: python3 scripts/install_model.py {a.repo} --as NAME"
        )


if __name__ == "__main__":
    main()
