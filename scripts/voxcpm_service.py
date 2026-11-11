#!/usr/bin/env python3
"""Resident VoxCPM2 voice-clone service, run by launchd (scripts/install-voxcpm.sh).

Same shape as scripts/xtts_service.py: the model is loaded once and kept in memory, the daemon
(src/voxcpm-client.mjs) sends one JSON request per line over a unix socket and gets one JSON line back,
and the socket is bound only after the model has loaded, so "the socket is there" means "ready". If
this service is down the daemon falls back to the XTTS service, so a voice note never fails because of
it.

It only clones. VoxCPM2 has no stock speakers, so a request without a reference is refused and the
daemon uses XTTS for those. It has no speed control either, so the daemon sends it only speed 1.0.

Safety, because this process writes files and can imitate a voice (same rules as the XTTS service):
  * the socket is mode 0600 inside state/ (0700), and every request must carry the daemon token;
  * output is only written under the system temp directory, as a .wav;
  * a voice-cloning reference is only read from state/voices/, never from an arbitrary path.
"""

import hmac
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "state")
SOCK = os.environ.get("WA_VOXCPM_SOCK", os.path.join(STATE, "voxcpm.sock"))
TOKEN_PATH = os.environ.get("WA_DAEMON_TOKEN", os.path.join(STATE, "daemon.token"))
VOICES_DIR = os.path.realpath(
    os.environ.get("WA_VOICES_DIR", os.path.join(STATE, "voices"))
)
TMP_ROOT = os.path.realpath(tempfile.gettempdir())
MODEL = os.environ.get("WA_VOXCPM_MODEL", "mlx-community/VoxCPM2-8bit")
MAX_TEXT = 800
# The daemon's joinSegments and silence padding assume 24 kHz, the XTTS rate.
OUT_RATE = 24000


def log(message):
    sys.stderr.write(f"voxcpm service: {message}\n")
    sys.stderr.flush()


def inside(path, root):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def main():
    # Installed in state/tts-mlx-venv, which is where this runs, not where the type checker looks.
    import numpy as np  # pyright: ignore[reportMissingImports]
    from mlx_audio.audio_io import write as audio_write  # pyright: ignore[reportMissingImports]
    from mlx_audio.tts.utils import load  # pyright: ignore[reportMissingImports]

    token = open(TOKEN_PATH).read().strip()
    if len(token) < 32:
        log("daemon token missing or too short, refusing to start")
        sys.exit(1)

    # MLX keeps its streams per thread: a model loaded on one thread fails on any other with "There is
    # no Stream(cpu, 1) in current thread". The connection handlers each run on their own thread, so
    # every call that touches the model goes through one worker thread that loaded it and owns it. It
    # also means one render at a time, which is what the GPU wants anyway.
    jobs = queue.Queue()
    loaded = threading.Event()
    boot = {}

    def worker():
        try:
            started = time.time()
            model = load(MODEL)
            boot["model"] = model
            log(f"model loaded in {time.time() - started:.0f}s")
        except Exception as err:
            boot["error"] = err
            return
        finally:
            loaded.set()
        while True:
            text, ref, kwargs, box, done = jobs.get()
            try:
                parts, rate = [], None
                for chunk in model.generate(text=text, ref_audio=ref, **kwargs):
                    parts.append(np.array(chunk.audio).astype(np.float32).reshape(-1))
                    rate = getattr(chunk, "sample_rate", None) or getattr(
                        model, "sample_rate", 48000
                    )
                box["parts"], box["rate"] = parts, rate
            except (
                Exception
            ) as err:  # reported to the requester, the worker keeps going
                box["error"] = err
            finally:
                done.set()

    threading.Thread(target=worker, daemon=True).start()
    loaded.wait()
    if "error" in boot:
        log(f"model failed to load: {boot['error']}")
        sys.exit(1)

    def handle(request):
        if not hmac.compare_digest(str(request.get("token", "")), token):
            return {"ok": False, "error": "bad token"}
        if request.get("op") == "ping":
            return {"ok": True, "model": MODEL}
        text = str(request.get("text", "")).strip()
        if not text or len(text) > MAX_TEXT:
            return {"ok": False, "error": "bad text"}
        out = str(request.get("out", ""))
        if not out.endswith(".wav") or not inside(
            os.path.dirname(out) or ".", TMP_ROOT
        ):
            return {
                "ok": False,
                "error": "output must be a .wav under the temp directory",
            }
        ref = request.get("ref")
        if not ref:
            return {
                "ok": False,
                "error": "this service only clones, a reference is required",
            }
        if not inside(ref, VOICES_DIR) or not os.path.isfile(ref):
            return {"ok": False, "error": "reference must be a file under state/voices"}
        # A delivery style ("excited, speaking fast") is read by the model from a description in
        # parentheses in front of the text, so brackets and line breaks are not allowed in it.
        style = " ".join(
            str(request.get("style") or "").replace("(", " ").replace(")", " ").split()
        )[:200]
        kwargs = {"instruct": style} if style else {}
        began = time.time()
        box, done = {}, threading.Event()
        jobs.put((text, ref, kwargs, box, done))
        done.wait()
        if "error" in box:
            raise box["error"]
        parts, rate = box["parts"], box["rate"]
        if not parts:
            return {"ok": False, "error": "the model returned no audio"}
        raw = out + ".native.wav"
        try:
            audio_write(raw, np.concatenate(parts), rate)
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    raw,
                    "-ar",
                    str(OUT_RATE),
                    "-ac",
                    "1",
                    out,
                ],
                check=True,
            )
        finally:
            if os.path.exists(raw):
                os.unlink(raw)
        seconds = round(time.time() - began, 2)
        # One line per render, so "did this note use VoxCPM2" has an answer in the log.
        log(
            f"rendered {len(text)} chars in {seconds}s, ref {os.path.basename(ref)}, "
            f"style {'yes' if style else 'no'}"
        )
        return {"ok": True, "seconds": seconds}

    def serve(conn):
        with conn:
            data = b""
            while not data.endswith(b"\n") and len(data) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                data += chunk
            request = {}
            try:
                request = json.loads(data.decode("utf-8"))
                reply = handle(request)
            except Exception as err:  # a bad request must not take the service down
                reply = {"ok": False, "error": f"{type(err).__name__}: {err}"}
            try:
                conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
            except OSError:
                # The daemon gave up (timed out) and used another engine: nobody will collect this file.
                out = str(request.get("out", "")) if isinstance(request, dict) else ""
                if (
                    reply.get("ok")
                    and out.endswith(".wav")
                    and inside(os.path.dirname(out) or ".", TMP_ROOT)
                ):
                    try:
                        os.unlink(out)
                    except OSError:
                        pass

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
