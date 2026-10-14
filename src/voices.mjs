import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { VOICES_DIR } from "./config.mjs";

// Cloned voices: a reference clip of a real person, kept in state/voices/ (gitignored), plus the
// short list of chats it may be used in, in state/voices/voices.json:
//
//   { "alice": { "ref": "alice.wav", "allowed_jids": ["31600000000@s.whatsapp.net"] } }
//
// A synthetic voice note carries no text marker, so one in a real person's voice that reached the
// wrong chat could pass as them. That is why the chat list is part of the voice, enforced here at
// the send, not left to whoever asks: a name that is unknown, a chat that is not listed (any group,
// any other DM), or a file that is not inside the voices directory is a refusal. There is no
// fallback to another voice, because a note that was meant to be that person and is not is worse
// than no note.
export function resolveClone(name, to) {
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) return { error: `"${name}" is not a valid voice name` };
  const index = join(VOICES_DIR, "voices.json");
  let voices;
  try {
    voices = JSON.parse(readFileSync(index, "utf8"));
  } catch {
    return { error: "no cloned voices are configured" };
  }
  const voice = voices[name];
  if (!voice) return { error: `no cloned voice named "${name}"` };
  // "*" means any chat. It is opt-in per voice, written into voices.json by Burak's say-so, and it
  // still goes through guardSend, so the chat must be on the main allowlist. Cloned notes carry no
  // spoken disclosure (owner decision, 2026-10-15), so the chat list and the consent note are the
  // only controls on where a voice is used.
  const anyChat = Array.isArray(voice.allowed_jids) && voice.allowed_jids.includes("*");
  if (!Array.isArray(voice.allowed_jids) || (!anyChat && !voice.allowed_jids.includes(to))) {
    return { error: `the "${name}" voice is not allowed in ${to}` };
  }
  const ref = join(VOICES_DIR, String(voice.ref));
  if (!existsSync(ref)) return { error: `the reference clip for "${name}" is missing` };
  const real = realpathSync(ref);
  const root = realpathSync(VOICES_DIR);
  if (!real.startsWith(root + sep)) return { error: "the reference clip is outside the voices directory" };
  return { ref: real };
}

// The clone that is this chat's default voice, if any: what Claude's own voice notes in that chat
// are rendered in without anyone asking. A voice is only ever the default somewhere it is also
// allowed (resolveClone checks that), so listing a chat in "default_jids" alone grants nothing.
// Returns { name, ref } or null.
export function defaultCloneFor(to) {
  let voices;
  try {
    voices = JSON.parse(readFileSync(join(VOICES_DIR, "voices.json"), "utf8"));
  } catch {
    return null;
  }
  for (const [name, voice] of Object.entries(voices)) {
    if (!Array.isArray(voice.default_jids) || !voice.default_jids.includes(to)) continue;
    const resolved = resolveClone(name, to);
    if (resolved.ref) return { name, ref: resolved.ref };
  }
  return null;
}
