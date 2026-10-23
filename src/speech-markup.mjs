// Delivery markup for voice notes. Piper (now the fallback behind XTTS) has no SSML and no emotion
// control: punctuation and a fixed gap after each sentence are all the prosody it offers. A joke
// lives in its timing, so this adds the two things that can be done without a new model, and does
// them outside the model: silence of a chosen length, and a slower or faster span.
//
//   [pause]  [pause 800]      silence, default 500 ms, clamped to 3 s
//   [slow]...[/slow]          the span at 1.35x the length, for a drawn-out punchline
//   [fast]...[/fast]          the span at 0.8x the length, for a rushed aside
//   ... or …                  an automatic 450 ms beat
//   [voice NAME]...[/voice]   the span in another voice: a cloned voice by name, or say:NAME for a
//                             macOS `say` voice. Several voices in one note, for a dialogue
//
// A voice span is resolved by the caller (server.mjs), which checks each clone against the chat it
// is sent to exactly as a whole-note clone is checked. Unclosed spans run to the end of the note.
//
// Only voice notes read this. In a text message the brackets would be sent literally, so a message
// that may go out as text should not carry them.

const MAX_PAUSE_MS = 3000;
const DEFAULT_PAUSE_MS = 500;
const ELLIPSIS_PAUSE_MS = 450;
const MAX_SEGMENTS = 40;
const SCALES = { slow: 1.35, fast: 0.8 };

// A clone name is what voices.mjs accepts. A `say` voice name may carry spaces and brackets
// ("Cem (Enhanced)"), so it gets its own, wider set.
const VOICE_NAME = String.raw`[a-z0-9_-]{1,40}|say:[A-Za-z][A-Za-z0-9 ()._-]{0,40}`;
const TOKEN = new RegExp(
  String.raw`\[pause(?:\s+(\d{2,4}))?\]|\[(slow|fast)\]|\[\/(slow|fast)\]|\[voice\s+(${VOICE_NAME})\]|\[\/voice\]`,
  "gi",
);

// -> [{ type: "speech", text, scale, voice } | { type: "pause", ms }], adjacent pauses merged, never
// empty of speech unless the input was. `voice` is null outside a [voice] span, otherwise the name
// as written ("gollum" or "say:Yelda").
export function parseSpeechMarkup(input) {
  return parseAll(input).slice(0, MAX_SEGMENTS);
}

// How many segments the text really has. Past MAX_SEGMENTS parseSpeechMarkup drops the rest, which
// is fine for a stray run of beats but would cut the end off a dialogue, so callers refuse instead.
export function speechSegmentCount(input) {
  return parseAll(input).length;
}
export { MAX_SEGMENTS };

function parseAll(input) {
  const text = String(input ?? "").replace(/…|\.{3,}/g, ` [pause ${ELLIPSIS_PAUSE_MS}] `);
  const parts = [];
  let scale = 1;
  let voice = null;
  let last = 0;
  const speech = (chunk) => {
    const trimmed = chunk.replace(/\s+/g, " ").trim();
    // A chunk with no letter or digit in it (the "." left behind by "[/slow].") gives Piper nothing to
    // say and it fails outright with "# channels not specified", so it is dropped here.
    if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) parts.push({ type: "speech", text: trimmed, scale, voice });
  };
  for (const match of text.matchAll(TOKEN)) {
    speech(text.slice(last, match.index));
    last = match.index + match[0].length;
    const token = match[0].toLowerCase();
    if (token.startsWith("[pause")) {
      const ms = Math.min(MAX_PAUSE_MS, Number(match[1] ?? DEFAULT_PAUSE_MS));
      parts.push({ type: "pause", ms });
    } else if (match[2]) {
      scale = SCALES[match[2].toLowerCase()];
    } else if (match[4]) {
      // A clone name is lowercased like voices.json keys, a macOS voice keeps its case ("Yelda").
      voice = /^say:/i.test(match[4]) ? `say:${match[4].slice(4)}` : match[4].toLowerCase();
    } else if (token === "[/voice]") {
      voice = null;
    } else {
      scale = 1;
    }
  }
  speech(text.slice(last));

  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (part.type === "pause" && prev?.type === "pause") prev.ms = Math.min(MAX_PAUSE_MS, prev.ms + part.ms);
    else merged.push({ ...part });
  }
  // A pause with nothing to separate it from is silence at the very start or end of the note.
  while (merged[0]?.type === "pause") merged.shift();
  while (merged[merged.length - 1]?.type === "pause") merged.pop();
  return merged;
}

// Plain spoken text with the markup removed, for engines that cannot use it and for anywhere the
// brackets must not show.
export function stripSpeechMarkup(input) {
  return parseSpeechMarkup(input)
    .filter((p) => p.type === "speech")
    .map((p) => p.text)
    .join(" ");
}

// macOS `say` has its own embedded commands instead of SSML: [[slnc N]] is N ms of silence. Speed
// spans are dropped, `say` would need a rate command per span and the fallback voice is not worth it.
export function toSayText(input) {
  return parseSpeechMarkup(input)
    .map((p) => (p.type === "pause" ? `[[slnc ${p.ms}]]` : p.text))
    .join(" ");
}
