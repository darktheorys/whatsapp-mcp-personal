#!/usr/bin/env python3
"""Resident XTTS-v2 text-to-speech service, run by launchd (scripts/install-xtts.sh).

The model takes about 80 seconds to load, so it is loaded once here and kept in memory instead of
being paid on every voice note. The WhatsApp daemon (src/xtts-client.mjs) sends one JSON request per
line over a unix socket and gets one JSON line back. If this service is down or still loading, the
socket does not exist yet and the daemon falls back to Piper, so a voice note never fails because
of it.

The socket is bound only after the model has loaded, so "the socket is there" means "ready".

Safety, because this process writes files and can imitate a voice:
  * the socket is mode 0600 inside state/ (0700), and every request must carry the daemon token;
  * output is only written under the system temp directory, as a .wav;
  * a voice-cloning reference is only read from state/voices/, never from an arbitrary path.
"""

import hmac
import json
import os
import socket
import sys
import tempfile
import threading
import time

# Accepts Coqui's non-commercial model license for this personal, non-commercial use.
os.environ.setdefault("COQUI_TOS_AGREED", "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "state")
SOCK = os.environ.get("WA_XTTS_SOCK", os.path.join(STATE, "xtts.sock"))
TOKEN_PATH = os.environ.get("WA_DAEMON_TOKEN", os.path.join(STATE, "daemon.token"))
VOICES_DIR = os.path.realpath(
    os.environ.get("WA_VOICES_DIR", os.path.join(STATE, "voices"))
)
TMP_ROOT = os.path.realpath(tempfile.gettempdir())
MAX_TEXT = 2000
LANGS = {"tr", "en"}


def log(message):
    sys.stderr.write(f"xtts service: {message}\n")
    sys.stderr.flush()


def inside(path, root):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def main():
    # Installed in state/xtts-venv, which is where this runs, not where the type checker looks.
    import torch  # pyright: ignore[reportMissingImports]
    from TTS.api import TTS  # pyright: ignore[reportMissingImports]

    token = open(TOKEN_PATH).read().strip()
    if len(token) < 32:
        log("daemon token missing or too short, refusing to start")
        sys.exit(1)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    started = time.time()
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    log(f"model loaded on {device} in {time.time() - started:.0f}s")
    speakers = set(tts.synthesizer.tts_model.speaker_manager.name_to_id.keys())

    # Only one render at a time: the GPU is the shared resource and two at once would just fight.
    gpu = threading.Lock()

    def handle(request):
        if not hmac.compare_digest(str(request.get("token", "")), token):
            return {"ok": False, "error": "bad token"}
        if request.get("op") == "ping":
            return {"ok": True, "device": device}
        text = str(request.get("text", "")).strip()
        lang = request.get("lang", "tr")
        if not text or len(text) > MAX_TEXT or lang not in LANGS:
            return {"ok": False, "error": "bad text or language"}
        out = str(request.get("out", ""))
        if not out.endswith(".wav") or not inside(
            os.path.dirname(out) or ".", TMP_ROOT
        ):
            return {
                "ok": False,
                "error": "output must be a .wav under the temp directory",
            }
        speed = min(2.0, max(0.5, float(request.get("speed", 1.0))))
        kwargs = {"text": text, "language": lang, "file_path": out, "speed": speed}
        ref = request.get("ref")
        if ref:
            if not inside(ref, VOICES_DIR) or not os.path.isfile(ref):
                return {
                    "ok": False,
                    "error": "reference must be a file under state/voices",
                }
            kwargs["speaker_wav"] = ref
        else:
            speaker = request.get("speaker", "Damien Black")
            if speaker not in speakers:
                return {"ok": False, "error": "unknown speaker"}
            kwargs["speaker"] = speaker
        began = time.time()
        with gpu:
            tts.tts_to_file(**kwargs)
        return {"ok": True, "seconds": round(time.time() - began, 2)}

    def serve(conn):
        with conn:
            data = b""
            while not data.endswith(b"\n") and len(data) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                data += chunk
            try:
                reply = handle(json.loads(data.decode("utf-8")))
            except Exception as err:  # a bad request must not take the service down
                reply = {"ok": False, "error": f"{type(err).__name__}: {err}"}
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))

    if os.path.exists(SOCK):
        probe = socket.socket(socket.AF_UNIX)
        try:
            probe.connect(SOCK)
            log("another service is already listening, exiting")
            sys.exit(1)
        except OSError:
            os.unlink(SOCK)  # stale file from a service that was killed hard
        finally:
            probe.close()

    server = socket.socket(socket.AF_UNIX)
    server.bind(SOCK)
    os.chmod(SOCK, 0o600)
    server.listen(8)
    log(f"ready on {SOCK}")
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
