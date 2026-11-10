import { VOXCPM_SOCK_PATH } from "./config.mjs";
import { xttsRequest } from "./xtts-client.mjs";

// The daemon's side of the VoxCPM2 service (scripts/voxcpm_service.py). The wire format is the XTTS
// one (one JSON line out, one back, the daemon token on every request), so this reuses that client
// with the other socket. It rejects at once when the socket is missing, which is the caller's cue to
// use XTTS.

// VoxCPM2 runs at 1.6 to 3 times real time on this machine (measured), speech is about 15 characters
// a second, so 200 ms a character is the worst case, plus a margin for a cold first render.
export const voxcpmTimeoutMs = (text) => 20_000 + 250 * text.length;

// Only a clone at normal speed: the service has no stock speakers and no speed control.
export const voxcpmCanRender = ({ ref, speed }) => Boolean(ref) && Math.abs((speed ?? 1) - 1) < 0.01;

// A delivery style ("excited, speaking fast", "sad, low and quiet") goes in front of the text in
// parentheses, which is how the model reads it, so the parentheses and line breaks are taken out.
// English works best (owner tested it, 2026-11-10). Empty after cleaning means no style.
export function cleanStyle(style) {
  const cleaned = String(style ?? "")
    .replace(/[()[\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || undefined;
}

// Renders `text` in the voice of `ref` to a 24 kHz wav at `outWav`.
export function voxcpmRender({ text, ref, style, outWav }, { sock = VOXCPM_SOCK_PATH } = {}) {
  return xttsRequest({ text, ref, style: cleanStyle(style), out: outWav }, { timeoutMs: voxcpmTimeoutMs(text), sock });
}
