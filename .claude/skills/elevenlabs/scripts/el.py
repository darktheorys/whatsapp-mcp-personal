#!/usr/bin/env python3
"""ElevenLabs from the shell, over plain HTTPS (no SDK, nothing to install).

    el.py check                                   key works, plan and characters left
    el.py voices [--search TEXT]                  voice ids and names
    el.py tts   OUT.mp3 --voice ID --text "..."   [--model eleven_v3] [--lang en] [--stability 0.5]
    el.py sts   IN.wav OUT.mp3 --voice ID         voice changer, keeps timing and delivery
    el.py isolate IN OUT.mp3                      voice isolator (speech only, no music or room)
    el.py sfx   OUT.mp3 --text "..." [--seconds 4]
    el.py stt   IN [--lang tr]                    Scribe transcript with word times (JSON)

The key lives in state/elevanlabs_key (owner's spelling), never on a command line and never printed.
Everything here sends audio or text to an external service: only content the owner asked for.
"""

import argparse
import json
import mimetypes
import os
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
KEY_FILE = REPO / "state" / "elevanlabs_key"
API = "https://api.elevenlabs.io"


def key():
    k = os.environ.get("ELEVENLABS_API_KEY") or (
        KEY_FILE.read_text().strip() if KEY_FILE.exists() else ""
    )
    if "=" in k:  # tolerate a KEY=value line
        k = k.split("=", 1)[1].strip().strip("\"'")
    if not k:
        sys.exit(json.dumps({"ok": False, "error": "no key in state/elevanlabs_key"}))
    return k


def call(method, path, body=None, headers=None, query=None):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("xi-api-key", key())
    for h, v in (headers or {}).items():
        req.add_header(h, v)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read(), r.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        sys.exit(json.dumps({"ok": False, "status": e.code, "error": detail}))


def multipart(fields, files):
    """files: {name: Path}. Returns (body, content_type)."""
    boundary = uuid.uuid4().hex
    out = []
    for name, value in fields.items():
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, path in files.items():
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{path.name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
        )
        out.append(path.read_bytes() + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def save(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(data)
    print(json.dumps({"ok": True, "path": str(path), "bytes": len(data)}))


def main():
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    v = sub.add_parser("voices")
    v.add_argument("--search", default="")
    t = sub.add_parser("tts")
    t.add_argument("out")
    t.add_argument("--voice", required=True)
    t.add_argument("--text", required=True)
    t.add_argument("--model", default="eleven_v3")
    t.add_argument("--lang")
    t.add_argument("--stability", type=float)
    s = sub.add_parser("sts")
    s.add_argument("input")
    s.add_argument("out")
    s.add_argument("--voice", required=True)
    s.add_argument("--model", default="eleven_multilingual_sts_v2")
    s.add_argument("--denoise", action="store_true")
    i = sub.add_parser("isolate")
    i.add_argument("input")
    i.add_argument("out")
    f = sub.add_parser("sfx")
    f.add_argument("out")
    f.add_argument("--text", required=True)
    f.add_argument("--seconds", type=float)
    r = sub.add_parser("stt")
    r.add_argument("input")
    r.add_argument("--lang")
    a = ap.parse_args()

    if a.cmd == "check":
        body, _ = call("GET", "/v1/user/subscription")
        d = json.loads(body)
        keep = ("tier", "character_count", "character_limit", "status")
        print(json.dumps({"ok": True, **{k: d.get(k) for k in keep}}))
    elif a.cmd == "voices":
        body, _ = call("GET", "/v1/voices")
        rows = [
            {
                "id": x["voice_id"],
                "name": x["name"],
                "labels": x.get("labels", {}),
            }
            for x in json.loads(body)["voices"]
            if a.search.lower() in x["name"].lower()
        ]
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    elif a.cmd == "tts":
        payload = {"text": a.text, "model_id": a.model}
        if a.lang:
            payload["language_code"] = a.lang
        if a.stability is not None:
            payload["voice_settings"] = {"stability": a.stability}
        data, _ = call(
            "POST",
            f"/v1/text-to-speech/{a.voice}",
            json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
            {"output_format": "mp3_44100_128"},
        )
        save(a.out, data)
    elif a.cmd == "sts":
        fields = {"model_id": a.model}
        if a.denoise:
            fields["remove_background_noise"] = "true"
        body, ctype = multipart(fields, {"audio": Path(a.input)})
        data, _ = call(
            "POST",
            f"/v1/speech-to-speech/{a.voice}",
            body,
            {"Content-Type": ctype},
            {"output_format": "mp3_44100_128"},
        )
        save(a.out, data)
    elif a.cmd == "isolate":
        body, ctype = multipart({}, {"audio": Path(a.input)})
        data, _ = call("POST", "/v1/audio-isolation", body, {"Content-Type": ctype})
        save(a.out, data)
    elif a.cmd == "sfx":
        payload = {"text": a.text}
        if a.seconds:
            payload["duration_seconds"] = a.seconds
        data, _ = call(
            "POST",
            "/v1/sound-generation",
            json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
            {"output_format": "mp3_44100_128"},
        )
        save(a.out, data)
    elif a.cmd == "stt":
        fields = {"model_id": "scribe_v2", "timestamps_granularity": "word"}
        if a.lang:
            fields["language_code"] = a.lang
        body, ctype = multipart(fields, {"file": Path(a.input)})
        data, _ = call("POST", "/v1/speech-to-text", body, {"Content-Type": ctype})
        print(data.decode("utf-8", "replace"))


if __name__ == "__main__":
    main()
