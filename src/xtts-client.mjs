import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { DAEMON_TOKEN_PATH, XTTS_SOCK_PATH } from "./config.mjs";

// The daemon's side of the XTTS service (scripts/xtts_service.py). One JSON line out, one back.
// It rejects rather than waits when the service is not up: the socket only exists once the model
// has loaded, so a missing socket is the normal "still warming up or switched off" answer and the
// caller falls back to Piper.

// Generous for the long tail, tight enough that a hung service cannot stall a chat. XTTS runs at
// roughly real time, and speech is about 15 characters a second.
export const xttsTimeoutMs = (text) => 15_000 + 200 * text.length;

export function xttsRequest(request, { timeoutMs = 30_000, sock = XTTS_SOCK_PATH } = {}) {
  return new Promise((resolve, reject) => {
    let token;
    try {
      token = readFileSync(DAEMON_TOKEN_PATH, "utf8").trim();
    } catch (err) {
      reject(new Error(`daemon token unreadable: ${err.code ?? err}`));
      return;
    }
    const conn = createConnection(sock);
    let answered = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`xtts timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const done = (fn, value) => {
      clearTimeout(timer);
      conn.destroy();
      fn(value);
    };
    conn.once("error", (err) => done(reject, err));
    conn.once("connect", () => conn.write(JSON.stringify({ ...request, token }) + "\n"));
    conn.on("data", (chunk) => {
      answered += chunk.toString("utf8");
      if (!answered.includes("\n")) return;
      try {
        const reply = JSON.parse(answered.slice(0, answered.indexOf("\n")));
        if (reply.ok) done(resolve, reply);
        else done(reject, new Error(`xtts refused: ${reply.error}`));
      } catch (err) {
        done(reject, err);
      }
    });
    conn.once("close", () => done(reject, new Error("xtts closed without answering")));
  });
}

// Renders `text` to a 24 kHz wav at `outWav`.
export function xttsRender({ text, lang, speaker, ref, speed, outWav }) {
  return xttsRequest({ text, lang, speaker, ref, speed, out: outWav }, { timeoutMs: xttsTimeoutMs(text) });
}

export const XTTS_SAMPLE_RATE = 24000;
