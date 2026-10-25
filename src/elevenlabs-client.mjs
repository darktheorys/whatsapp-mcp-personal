import { readFileSync, writeFileSync } from "node:fs";
import { ELEVENLABS_KEY_PATH, ELEVENLABS_MODEL, ELEVENLABS_VOICE } from "./config.mjs";

// The first-choice voice for an ordinary voice note. Text goes to the vendor over HTTPS, so this only
// ever sees what already passed guardSend's allowlist and secret scan. Anything that goes wrong
// (no key, quota used up, rate limit, network) throws, and synthWav then falls back to the local XTTS
// service, then Piper, then macOS `say`, so a voice note is never lost to it.

export const ELEVENLABS_SAMPLE_RATE = 24000; // pcm_24000 is allowed on every plan, 44.1 kHz is not
const API = "https://api.elevenlabs.io";
const BLOCK_MS = 30 * 60_000; // after a quota or key refusal, stop asking for half an hour

let blockedUntil = 0;
let blockedWhy = "";

export function elevenLabsKey() {
  try {
    const raw = readFileSync(ELEVENLABS_KEY_PATH, "utf8").trim();
    // Tolerate a `NAME=value` line.
    return raw.includes("=")
      ? raw
          .slice(raw.indexOf("=") + 1)
          .trim()
          .replace(/^["']|["']$/g, "")
      : raw;
  } catch {
    return "";
  }
}

// Cheap check before a note is split into sentences: is there a key, and are we not in a back-off?
export function elevenLabsAvailable(now = Date.now()) {
  return elevenLabsKey() !== "" && now >= blockedUntil;
}

export function elevenLabsBlockedReason() {
  return blockedWhy;
}

export function resetElevenLabsForTest() {
  blockedUntil = 0;
  blockedWhy = "";
}

// 16-bit mono PCM to a wav file.
export function pcmToWav(pcm, sampleRate, outWav) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(outWav, Buffer.concat([header, pcm]));
}

// Renders `text` to a 24 kHz wav at `outWav`. `speed` is the same multiplier the other engines take,
// clamped to what the API accepts (0.7 to 1.2).
export async function elevenLabsRender({ text, lang, speed = 1, outWav, voiceId = ELEVENLABS_VOICE, fetchFn = fetch }) {
  if (!elevenLabsAvailable()) {
    throw new Error(blockedWhy ? `elevenlabs backed off (${blockedWhy})` : "elevenlabs has no key");
  }
  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) },
  };
  if (lang) body.language_code = lang;
  let res;
  try {
    res = await fetchFn(`${API}/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
      method: "POST",
      headers: { "xi-api-key": elevenLabsKey(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000 + 100 * text.length),
    });
  } catch (err) {
    throw new Error(`elevenlabs unreachable: ${err.message ?? err}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    // 401 (bad key or `quota_exceeded`), 402 and 403 (plan), 429 (rate limit or concurrency): back off.
    if ([401, 402, 403, 429].includes(res.status)) {
      blockedUntil = Date.now() + BLOCK_MS;
      blockedWhy = `${res.status}`;
    }
    throw new Error(`elevenlabs refused (${res.status}): ${detail}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length < 2000) throw new Error("elevenlabs returned almost no audio");
  pcmToWav(pcm, ELEVENLABS_SAMPLE_RATE, outWav);
}
