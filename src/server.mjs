import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { downloadMediaMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { z } from "zod";

import {
  MEDIA_DIR,
  MEMES_DIR,
  STATE_DIR,
  allowedJid,
  hasImageDisabled,
  hasVoiceDisabled,
  isMentionOnly,
  isVoiceOnly,
  loadConfig,
  ownerName,
  setImageEnabled,
  setMentionOnly,
  S2T_MODELS,
  s2tTier,
  setS2tTier,
  setSpeakingRate,
  setVoiceEnabled,
  setVoiceOnly,
  speakingRate,
} from "./config.mjs";
import {
  appendMessage,
  messageCount,
  readRecent,
  readNewMessages,
  updatePollState,
  archiveOldMessages,
  logInbox,
  updateContact,
  readContacts,
  searchMessages,
  findMessage,
} from "./store.mjs";
import { connectionState, getSocket, logger, startWhatsApp } from "./whatsapp.mjs";

const execFileAsync = promisify(execFile);

// Media worth keeping a copy of. Video and voice notes are deliberately absent: they fall
// through to null below and are dropped whole, same as every non-text message used to be.
const MEDIA_KINDS = {
  imageMessage: "image",
  documentMessage: "document",
  stickerMessage: "sticker",
  audioMessage: "voice",
};
// Resolved per call, not once at load: "/s2t-tier mid" has to take effect on the next voice note,
// not on the next server restart.
//
// Falls back to whatever model is actually on disk when the configured tier's file is missing.
// The /s2t-tier command refuses to select a tier that hasn't been downloaded, but editing
// config.json by hand goes around that — and the failure mode without this is bad: whisper-cli
// errors on the missing path, every voice note logs as "[voice]", and the only sign is a line in
// baileys.log. Degrading to a worse transcript beats degrading to no transcript.
function whisperModel() {
  const dir = join(STATE_DIR, "whisper-models");
  const wanted = join(dir, S2T_MODELS[s2tTier()]);
  if (existsSync(wanted)) return wanted;
  const fallback = Object.values(S2T_MODELS)
    .map((f) => join(dir, f))
    .find((p) => existsSync(p));
  logger.warn(
    { wanted, fallback },
    fallback
      ? "configured s2t tier's model is missing — falling back to the one on disk (bash scripts/setup-voice.sh <tier> to fix)"
      : "no whisper model on disk at all — voice notes will not be transcribed",
  );
  return fallback ?? wanted;
}
const PIPER_BIN = join(STATE_DIR, "piper-venv", "bin", "piper");
const PIPER_MODEL = join(STATE_DIR, "piper-models", "tr_TR-dfki-medium.onnx");

const DEFAULT_SAY_WPM = 175; // macOS `say`'s own default rate, used as the 1.0x baseline
const SENTENCE_SILENCE = "0.35"; // seconds of gap after each sentence (Piper default 0.2 runs sentences together)

// The allowlist gates who a file can be sent *to*, but not what can be sent, so on its own an
// outbound-file tool will read any path on disk. Anyone in an allowlisted group can put text in
// front of the model, which makes "send ~/.ssh/id_ed25519" a plausible instruction with a
// passing recipient check. Confining the source to directories that only ever hold material
// already destined for these chats closes that without needing the model to exercise judgement.
// `state/media/` is deliberately NOT here. It holds what other people sent *in* — every image,
// document and voice note downloaded from every allowlisted chat. Allowing it as a source makes
// "forward that photo" a one-tool operation across chat boundaries, which is the same leak
// wa_recent already refuses to enable by making a chat name mandatory. Outbound files come from
// material staged for sending (state/memes) or produced during this run (the session scratchpad),
// never from the inbound pile.
//
// Not bare `tmpdir()`: on macOS that is the per-user temp directory every application on the
// machine shares — browser downloads, other tools' scratch files — which is far wider than
// "produced during this run", while *excluding* the one directory Claude Code actually writes to.
// `/private/tmp/claude-<uid>` is that directory (see .claude/deny-outside-repo.sh).
const SENDABLE_DIRS = [MEMES_DIR, `/private/tmp/claude-${process.getuid()}`];

// Resolves symlinks first: a link inside a sendable dir pointing at ~/.ssh would otherwise pass a
// plain string-prefix test.
// Returns { real } when the path is sendable, or { error } describing why not. A missing file and
// a forbidden one are reported differently: conflating them made "no such file" read as a security
// refusal, which sends you looking for a permissions bug that isn't there.
export function resolveSendable(path) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return { error: `${path} does not exist` };
  }
  const ok = SENDABLE_DIRS.some((dir) => {
    // A sendable directory that doesn't exist yet must not throw: state/memes is gitignored, so on
    // a fresh clone this threw ENOENT and every send — including one with a perfectly valid path in
    // another sendable dir — died looking like a bug rather than a refusal.
    let root;
    try {
      root = realpathSync(dir);
    } catch {
      return false;
    }
    return real === root || real.startsWith(root + sep);
  });
  if (!ok) {
    return {
      error: `${path} is outside the sendable directories (state/memes, the session scratchpad) — state/media holds what other chats sent you and is never a send source`,
    };
  }
  return { real };
}

// A text message ends in "(_Claude_)". A voice note has nowhere to put that — WhatsApp voice
// notes carry no caption — so without a marker a synthesised message is indistinguishable from
// one the owner recorded, in chats where people have already tried impersonation for fun.
// A short tone rather than a spoken word: it reaches whoever is actually listening, and it does
// not interrupt the message on every send the way "... Claude." would.
const TONE_HZ = 880;
const TONE_SECONDS = 0.15;

// Writes `text` to `outWav`. Piper (no `voice`) is the default engine; naming a macOS `say` voice
// falls back to it for other languages/genders, since only one Piper voice is installed. `rate` is
// a speed multiplier (1.0 normal, >1 faster, <1 slower), applied as Piper's inverse length-scale
// or `say`'s -r words-per-minute.
function synthWav(text, voice, rate, outWav) {
  if (!voice) {
    // ponytail: punctuation + sentence gaps are the only prosody Piper has (no SSML, no emotion
    // embedding in a single-speaker VITS). Tune SENTENCE_SILENCE by ear; real expressiveness
    // needs a different model, not another flag here.
    execFileSync(
      PIPER_BIN,
      [
        "--model",
        PIPER_MODEL,
        "--length-scale",
        String(1 / rate),
        "--sentence-silence",
        SENTENCE_SILENCE,
        "--output_file",
        outWav,
      ],
      {
        input: text,
      },
    );
    return;
  }
  const aiff = `${outWav}.aiff`;
  execFileSync("say", ["-v", voice, "-r", String(Math.round(DEFAULT_SAY_WPM * rate)), "-o", aiff, text]);
  execFileSync("afconvert", [aiff, outWav, "-d", "LEI16", "-f", "WAVE"]);
  rmSync(aiff, { force: true });
}

// Appends the marker tone to any audio file and encodes the result for WhatsApp. Every outbound
// voice note goes through here — synthesised or pre-made — so none can leave unmarked by a call
// site forgetting to add it. Both inputs are normalised to one format first: the concat filter
// requires a matching sample rate and channel layout, and TTS output and an arbitrary file on
// disk generally do not share either.
function withMarkerTone(audioPath) {
  const dir = mkdtempSync(join(tmpdir(), "wa-tone-"));
  try {
    const m4a = join(dir, "out.m4a");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        audioPath,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${TONE_HZ}:duration=${TONE_SECONDS}`,
        "-filter_complex",
        "[0:a]aformat=sample_rates=48000:channel_layouts=mono[a0];" +
          "[1:a]aformat=sample_rates=48000:channel_layouts=mono[a1];" +
          "[a0][a1]concat=n=2:v=0:a=1",
        "-c:a",
        "aac",
        m4a,
      ],
      { stdio: "ignore" },
    );
    return readFileSync(m4a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Shared by wa_send_voice and wa_send's voice-only auto-route, so both go through one TTS path.
// `rate` omitted falls back to the persisted default (see speakingRate()/"/speaking-speed"),
// not to each engine's own stock pace.
function speakToBuffer(text, voice, rate = speakingRate()) {
  const dir = mkdtempSync(join(tmpdir(), "wa-tts-"));
  try {
    const wav = join(dir, "out.wav");
    synthWav(text, voice, rate, wav);
    return withMarkerTone(wav);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ponytail: 25 MB ceiling, and no `reuploadRequest` context passed to the download. Media is
// fetched on arrival while it is still fresh on WhatsApp's CDN, so the re-upload path would
// almost never fire. Raise the cap or pass the context if a group starts trading big files.
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const ATTRIBUTION = "\n\n(_Claude_)";

// Everything below is a send-side backstop. The allowlist decides *who* can be written to and
// says nothing about *what*, and a message assembled from something the model was talked into
// reading would pass every check upstream of here. These run at the socket instead, so they hold
// whether or not the reasoning that produced the text was sound.

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{30,}\b/, "an API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "a JWT"],
];

// The linked-device keys are the one secret guaranteed to be sitting in this repo, so they get
// an exact-match check rather than a shape-match one. Cached: creds only change on re-pair, and
// this runs on every send.
let authSecrets = null;
function linkedDeviceSecrets() {
  // `authSecrets?.length`, not `authSecrets`: an empty array is truthy, so caching one meant a
  // single early or failed read (creds not written yet, a transient parse error) permanently
  // disabled the exact-match half of scanOutbound for the life of the process — silently, because
  // the catch below swallows the reason. Retrying while empty costs one file read per send.
  if (authSecrets?.length) return authSecrets;
  authSecrets = [];
  try {
    const creds = JSON.parse(readFileSync(join(STATE_DIR, "auth", "creds.json"), "utf8"));
    const walk = (v) => {
      if (typeof v === "string" && v.length >= 24) authSecrets.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(creds);
  } catch (err) {
    // No creds yet (unpaired), or unreadable: the pattern checks above still apply. Logged rather
    // than swallowed outright — if this keeps failing after pairing, the exact-match check is not
    // running and nothing else would say so.
    logger.warn({ err: String(err?.message ?? err) }, "could not read linked-device secrets for the outbound scan");
  }
  return authSecrets;
}

// Returns a refusal reason, or null when the text is safe to send.
export function scanOutbound(text) {
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text)) return `it looks like it contains ${what}`;
  }
  for (const secret of linkedDeviceSecrets()) {
    if (text.includes(secret)) return "it contains WhatsApp linked-device key material";
  }
  return null;
}

// A loop, or a message that talks the model into flooding a chat, should cost a handful of
// messages rather than an account. WhatsApp bans numbers for exactly this pattern, and this is
// an unofficial client, so the cap is deliberately far below anything a human would hit.
const SEND_LIMIT_PER_MIN = 20;
const recentSends = [];
export function overSendLimit() {
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > 60_000) recentSends.shift();
  if (recentSends.length >= SEND_LIMIT_PER_MIN) return true;
  recentSends.push(now);
  return false;
}

// Shared preamble for every outbound tool: allowlist, the secret scan, connection, then the rate
// limit. Returns an MCP error result, or null to proceed.
//
// Order matters and is deliberate. The two content judgements — is this recipient allowed, does
// this text carry a secret — come first, because they are true regardless of whether a socket
// happens to be up, and answering "not connected" to a message that should never be sent at all
// is a worse answer. The rate limit goes last because it *consumes* budget: a send refused for any
// earlier reason must not spend a slot that a legitimate send then gets denied for.
export function guardSend(to, text) {
  if (!allowedJid(to)) {
    return {
      isError: true,
      content: [{ type: "text", text: `Refused: ${to} is not on the allowlist (state/config.json).` }],
    };
  }
  if (text) {
    const reason = scanOutbound(text);
    if (reason) {
      logger.warn({ to }, "outbound message refused by secret scan");
      return { isError: true, content: [{ type: "text", text: `Refused to send: ${reason}.` }] };
    }
  }
  // Reads the connection's actual state, not just whether a socket object is installed — a
  // logged-out socket kept passing this check and every send then failed with "Connection Closed".
  const { live, lastError } = connectionState();
  if (!live) {
    return {
      isError: true,
      content: [
        { type: "text", text: `Not connected to WhatsApp: ${lastError ?? "still connecting — try again shortly"}.` },
      ],
    };
  }
  if (overSendLimit()) {
    return {
      isError: true,
      content: [{ type: "text", text: `Refused: send rate limit (${SEND_LIMIT_PER_MIN}/min) reached.` }],
    };
  }
  return null;
}

// Revising or revoking a message is limited to ones this server sent itself. `fromMe` is not
// enough: Burak's own messages, typed on his phone, are equally fromMe, and rewriting or deleting
// those would let anyone who can talk the model into it edit his side of a conversation. The
// `by: "claude"` tag is written at send time by the wa_send* tools and by nothing else, so it is
// the only claim of authorship here that isn't inferred after the fact.
// ponytail: messages sent before this tag existed have no `by` field and are therefore not
// editable — correct default, since there is no way to tell them apart retroactively.
export function guardOwnMessage(jid, messageId) {
  const target = findMessage(jid, messageId);
  if (!target) {
    return {
      error: { isError: true, content: [{ type: "text", text: `Message ${messageId} not found in ${jid}'s log.` }] },
    };
  }
  // findMessage now reports whether a later row deleted this one. Without this, wa_edit on an
  // already-deleted message sends WhatsApp an edit for something that no longer exists and reports
  // success — the tool would look like it worked and change nothing.
  if (target.deleted) {
    return {
      error: { isError: true, content: [{ type: "text", text: `Refused: ${messageId} was already deleted.` }] },
    };
  }
  if (target.by !== "claude") {
    logger.warn({ jid, messageId }, "refused to edit/delete a message this server did not send");
    return {
      error: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Refused: ${messageId} was not sent by Claude. Only messages this server sent can be edited or deleted.`,
          },
        ],
      },
    };
  }
  return { target };
}

export function extractContent(m) {
  if (!m) return null;
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  for (const [field, kind] of Object.entries(MEDIA_KINDS)) {
    // A caption is the whole point of keeping these: it survives even when the download fails.
    if (m[field]) return { text: m[field].caption ?? "", kind, node: m[field] };
  }
  return null;
}

// contextInfo (and with it, the quoted message) can live on any message-type node, not just
// extendedTextMessage — a reply to an image is itself an imageMessage with its own contextInfo.
// Baileys emits the raw payload, so a message can arrive nested inside a wrapper that
// `extractContent` knows nothing about — and an unrecognised wrapper is dropped whole: no row, no
// inbox line, no wake, no error. Turning on disappearing messages in a chat made that entire chat
// silently invisible.
//
// View-once is unwrapped and stored like anything else, by explicit decision — but it is *marked*,
// because it is the one message kind where keeping a copy goes against what the sender asked for.
// `viewOnce: true` lands on the row and in the `view_once` column, so these are findable later
// (to review them, to delete them, to keep them out of anything shared) rather than being
// indistinguishable from ordinary media once downloaded.
//
// Worth knowing: downloading does not notify the sender, and WhatsApp shows them nothing. The
// marker is for you, not for them.
const VIEW_ONCE_KEYS = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
export function isViewOnce(m) {
  return Boolean(m && VIEW_ONCE_KEYS.some((k) => m[k]));
}

export function unwrapped(m) {
  return m ? normalizeMessageContent(m) : m;
}

export function extractQuoted(m) {
  if (!m) return null;
  for (const node of Object.values(m)) {
    // Normalised for the same reason as the message itself: a reply to a disappearing or
    // view-once message carries the quote inside a wrapper too.
    const quoted = node?.contextInfo?.quotedMessage && normalizeMessageContent(node.contextInfo.quotedMessage);
    // `stanzaId` is the quoted message's own id, which is what makes a reply an actual link back
    // to a stored row rather than just a copy of its text. Logging only the text (as this did
    // originally) means a reply chain can be read but never followed.
    // Spreading null is legal and yields {}, so a quote of a kind extractContent doesn't handle
    // (video) still returns a usable object — it just has no text or kind, which the caller has to
    // render as something other than "[undefined]".
    if (quoted) return { ...extractContent(quoted), id: node.contextInfo.stanzaId ?? null };
  }
  return null;
}

const safeName = (s) => s.replace(/[^a-zA-Z0-9._-]/g, "_");

export function mediaName(node, id) {
  if (node.fileName) return `${safeName(id)}-${safeName(node.fileName)}`;
  const ext = node.mimetype?.split("/")[1]?.split(";")[0] ?? "bin";
  return `${safeName(id)}.${safeName(ext)}`;
}

// Never throws: a message whose media could not be saved is still worth logging, so failures
// come back as a field on the record rather than as an exception.
async function saveMedia(waMessage, { kind, node }, id) {
  const bytes = Number(node.fileLength ?? 0);
  if (bytes > MAX_MEDIA_BYTES) return { kind, skipped: `${Math.round(bytes / 1e6)} MB exceeds cap` };
  try {
    const path = join(MEDIA_DIR, mediaName(node, id));
    writeFileSync(path, await downloadMediaMessage(waMessage, "buffer", {}), { mode: 0o600 });
    return { kind, path };
  } catch (err) {
    return { kind, error: String(err?.message ?? err) };
  }
}

// Transcribes a downloaded voice note with whisper.cpp (offline, no API key). Returns null on any
// failure — a voice note that can't be transcribed still gets logged as "[voice]", same as before
// this existed, rather than breaking the whole message.
//
// Async and time-limited on purpose: this runs on the inbound-message path, and whisper on a long
// recording takes tens of seconds. Doing that synchronously stalls the Baileys keepalives along
// with everything else in the process, long enough for WhatsApp to drop the socket. The timeouts
// cover the other half — a malformed file can hang ffmpeg indefinitely, which would otherwise
// wedge message handling permanently with no way back short of a restart.
async function transcribeVoice(path) {
  const dir = mkdtempSync(join(tmpdir(), "wa-stt-"));
  try {
    const wav = join(dir, "in.wav");
    const limit = { timeout: 120_000, killSignal: "SIGKILL" };
    await execFileAsync("ffmpeg", ["-y", "-i", path, "-ar", "16000", "-ac", "1", wav], limit);
    const { stdout } = await execFileAsync("whisper-cli", ["-m", whisperModel(), "-f", wav, "-nt", "-l", "auto"], {
      ...limit,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch (err) {
    // Silence here would make a missing whisper-cli or model file look exactly like an
    // unintelligible recording — every voice note would quietly log as "[voice]" forever.
    logger.warn({ err: String(err?.message ?? err) }, "voice transcription failed");
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Group senders usually arrive as an opaque LID (`22553074606205@lid`), which tells a reader
// nothing. Baileys already keeps the LID/phone table this needs, and caches it, so trade the
// lookup for a `from` that is actually identifiable.
async function resolveSender(jid) {
  if (!jid?.endsWith("@lid")) return jid;
  try {
    return (await getSocket()?.signalRepository?.lidMapping?.getPNForLID(jid)) ?? jid;
  } catch {
    return jid; // an unresolvable sender is worth far less than a dropped message
  }
}

// The in-chat commands, gated on key.fromMe below: a loose anchor here would let any group member
// reconfigure the bot for everyone, so these are a trust boundary. Exported because the test used
// to assert against its own copies of these literals — twelve assertions that would all still pass
// if the real regexes were loosened.
//
// Every one is anchored `^...$`. That is what makes them immune to the attribution suffix: a
// message this server sent ends in "\n\n(_Claude_)", so it can never match its own command form
// even if WhatsApp started echoing our sends back as `notify`.
export const COMMANDS = {
  wakelevel: /^\/wakelevel\s+(mention-only|verbose)\s*$/i,
  speaking: /^\/speaking\s+(voice-only|text-only)\s*$/i,
  speakingSpeed: /^\/speaking-speed\s+([0-9.]+)\s*$/,
  s2tTier: /^\/s2t-tier\s+(low|mid|high)\s*$/i,
  readMedia: /^\/read-(image|audio)\s+(yes|no)\s*$/i,
};

async function handleIncoming(waMessage) {
  const { key } = waMessage;
  const jid = allowedJid(key.remoteJid, key.remoteJidAlt);
  if (!jid) return;
  const viewOnce = isViewOnce(waMessage.message);
  const content = extractContent(unwrapped(waMessage.message));
  if (!content) return;
  // Only Burak's own device can flip wake level for a chat — a group member typing this shouldn't
  // be able to silence or unsilence the bot for everyone else.
  if (key.fromMe) {
    const trimmed = content.text?.trim() ?? "";
    const wakeLevel = COMMANDS.wakelevel.exec(trimmed);
    if (wakeLevel) {
      setMentionOnly(jid, wakeLevel[1].toLowerCase() === "mention-only");
      return;
    }
    const speaking = COMMANDS.speaking.exec(trimmed);
    if (speaking) {
      setVoiceOnly(jid, speaking[1].toLowerCase() === "voice-only");
      return;
    }
    // Global, not per-chat — see speakingRate()'s comment in config.mjs.
    const speed = COMMANDS.speakingSpeed.exec(trimmed);
    if (speed) {
      setSpeakingRate(Number(speed[1]));
      return;
    }
    // Global too: transcription quality doesn't vary by who is speaking. Missing model files are
    // reported into the chat rather than silently accepted — otherwise the tier would appear to
    // change and every voice note afterwards would just fail to transcribe.
    const s2t = COMMANDS.s2tTier.exec(trimmed);
    if (s2t) {
      const tier = s2t[1].toLowerCase();
      const model = join(STATE_DIR, "whisper-models", S2T_MODELS[tier]);
      if (!existsSync(model)) {
        await getSocket()?.sendMessage(jid, {
          text: `Model for "${tier}" not downloaded yet (${S2T_MODELS[tier]}). Run: bash scripts/setup-voice.sh ${tier}${ATTRIBUTION}`,
        });
        return;
      }
      setS2tTier(tier);
      return;
    }
    const media = COMMANDS.readMedia.exec(trimmed);
    if (media) {
      const on = media[2].toLowerCase() === "yes";
      if (media[1].toLowerCase() === "image") setImageEnabled(jid, on);
      else setVoiceEnabled(jid, on);
      return;
    }
  }
  const quoted = extractQuoted(waMessage.message);
  // In a group `remoteJid` is the room, so the sender is only knowable from `participant`.
  // Omitted entirely for DMs, where `direction` already says who spoke.
  const from = key.participant ? await resolveSender(key.participantAlt ?? key.participant) : null;
  // Images disabled per-chat: still log text/caption, skip download.
  // `no_image_jids` means images, not all media: a voice note's audio is the only copy of its
  // words, so gating it there would silently leave those chats with unsearchable empty messages
  // rather than transcripts. Pictures are the thing worth not keeping; speech is the thing worth
  // reading. `no_voice_jids` is the separate opt-out for chats where that isn't wanted either.
  const wantsMedia = content.kind === "voice" ? !hasVoiceDisabled(jid) : !hasImageDisabled(jid);
  const media = content.kind && wantsMedia ? await saveMedia(waMessage, content, key.id) : null;
  // A caption already covers text for other media kinds; a voice note has none, so the
  // transcript IS its text — without this it would log as the unreadable "[voice]" placeholder.
  const transcript = content.kind === "voice" && media?.path ? await transcribeVoice(media.path) : null;
  const text = transcript ?? content.text;
  appendMessage(jid, {
    direction: key.fromMe ? "out" : "in",
    text,
    // `|| Date.now()` for the same reason handleReaction has it: a missing messageTimestamp makes
    // this NaN, and NaN violates the `ts INTEGER NOT NULL` column — which throws inside
    // appendMessage, gets swallowed by safely(), and drops the entire message rather than just
    // its timestamp.
    ts: Number(waMessage.messageTimestamp) * 1000 || Date.now(),
    id: key.id,
    // Only set when true, so the flag reads as an exception rather than appearing on all 949
    // ordinary rows. Surfaces as the `view_once` column for querying.
    ...(viewOnce ? { viewOnce: true } : {}),
    ...(media ? { media } : {}),
    ...(from ? { from, name: waMessage.pushName } : {}),
    // Both: the text so a reader sees what was replied to without a second lookup, and the id so
    // the reply is a followable link. Older rows have only the text — the id was never captured.
    ...(quoted ? { replyTo: quoted.text || `[${quoted.kind}]`, replyToId: quoted.id ?? null } : {}),
  });
  // mention-only chats stay fully logged above for wa_recent/wa_search — only the wake is gated.
  // `text` already prefers a voice transcript, so saying "claude" in a voice note counts too.
  if (!isMentionOnly(jid) || /@claude/i.test(text ?? "")) {
    // `pushName` is free text the sender picks, so an inbound one may well claim to be the owner.
    // Only `key.fromMe` actually proves authorship, so it — not the name — decides the prefix, and
    // an inbound name is never rendered through ownerName(). Anything reading this feed must treat
    // "(them)" as untrusted content and only "(self)" as the owner speaking.
    const label = key.fromMe ? `(self) ${ownerName()}` : `(them) ${waMessage.pushName || jid.split("@")[0]}`;
    const logText = text || `[${content.kind}]`;
    // `?? "media"`: a reply to a video (or any kind extractContent doesn't handle) has neither text
    // nor kind, and rendered "[undefined]" in the wake feed — which reads like a bug in the quote
    // rather than "they replied to something I don't store".
    const quotedLabel = quoted?.text || `[${quoted?.kind ?? "media"}]`;
    logInbox(jid, label, quoted ? `(replying to "${quotedLabel}") ${logText}` : logText);
  }
  if (!key.fromMe) {
    // `from` is the resolved group participant when set, so a name is credited to the person
    // who sent it, not the group jid; for DMs `from` is null and it's credited to the chat itself.
    updateContact(from ?? jid, waMessage.pushName);
  }
}

// A reaction sent by wa_react is logged there immediately, and then WhatsApp echoes it back to us
// as an ordinary reaction event — which logged it a second time. Keeping the write in wa_react (it
// is guaranteed, the echo is not) and dropping the echo here is the way round that never loses a
// reaction; at worst a duplicate slips through if the echo is slower than the window.
// ponytail: in-memory set, so a restart between send and echo re-admits one duplicate. Fine.
const ownReactions = new Map();
const OWN_REACTION_TTL_MS = 30_000;

export function noteOwnReaction(jid, messageId, emoji) {
  ownReactions.set(`${jid}|${messageId}|${emoji}`, Date.now());
}

export { isEchoOfOwnReaction as isEchoOfOwnReactionForTest };

function isEchoOfOwnReaction(jid, messageId, emoji) {
  const now = Date.now();
  for (const [k, at] of ownReactions) if (now - at > OWN_REACTION_TTL_MS) ownReactions.delete(k);
  const key = `${jid}|${messageId}|${emoji}`;
  if (!ownReactions.has(key)) return false;
  ownReactions.delete(key);
  return true;
}

// Reactions arrive on their own event rather than as messages, and carry two keys: the outer one
// identifies the message being reacted to, `reaction.key` identifies who did the reacting.
async function handleReaction({ key, reaction }) {
  const jid = allowedJid(key.remoteJid, key.remoteJidAlt);
  if (!jid) return;
  if (reaction.key?.fromMe && isEchoOfOwnReaction(jid, key.id, reaction.text ?? "")) return;
  const reactor = reaction.key?.participant ?? key.participant;
  appendMessage(jid, {
    direction: reaction.key?.fromMe ? "out" : "in",
    kind: "reaction",
    // An empty emoji is how WhatsApp signals a reaction being taken back, not a blank reaction.
    text: reaction.text ?? "",
    removed: !reaction.text,
    to: key.id, // the message this is attached to
    ts: Number(reaction.senderTimestampMs) || Date.now(),
    ...(reactor ? { from: await resolveSender(reactor) } : {}),
  });
}

const server = new McpServer({ name: "whatsapp-mcp-personal", version: "0.1.0" });

server.registerTool(
  "wa_status",
  {
    title: "WhatsApp connection status",
    description: "Connection state, linked own number, and the configured allowlist.",
    inputSchema: {},
  },
  async () => {
    const sock = getSocket();
    const { allowlist } = loadConfig();
    const { live, lastError } = connectionState();
    const status = {
      connected: live,
      // Present only when something is wrong, so a healthy status stays uncluttered and a broken
      // one can never be mistaken for healthy.
      ...(lastError ? { problem: lastError } : {}),
      // The tier that is configured and the model actually in use — they differ when the
      // configured tier's file was never downloaded, which is otherwise invisible until you
      // notice transcripts have quietly stopped.
      s2t: { tier: s2tTier(), model: basename(whisperModel()) },
      ownJid: sock?.user?.id ?? null,
      allowlist,
      loggedMessages: Object.fromEntries(allowlist.map((jid) => [jid, messageCount(jid)])),
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  },
);

server.registerTool(
  "wa_groups",
  {
    title: "List WhatsApp groups",
    description:
      "List groups this number belongs to, with their JIDs. WhatsApp never shows a group JID in the app, so this is the only way to learn one for the allowlist.",
    inputSchema: {},
  },
  async () => {
    const sock = getSocket();
    if (!sock?.user) {
      return { isError: true, content: [{ type: "text", text: "Not connected to WhatsApp yet — try again shortly." }] };
    }
    const { allowlist } = loadConfig();
    const groups = Object.values(await sock.groupFetchAllParticipating()).map((g) => ({
      jid: g.id,
      subject: g.subject ?? "",
      participants: g.participants?.length ?? 0,
      allowed: allowlist.includes(g.id),
    }));
    groups.sort((a, b) => a.subject.localeCompare(b.subject));
    return { content: [{ type: "text", text: JSON.stringify(groups, null, 2) }] };
  },
);

server.registerTool(
  "wa_send",
  {
    title: "Send a WhatsApp message",
    description:
      "Send a text message to an allowlisted WhatsApp JID. Refuses anything not in state/config.json's allowlist.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      text: z.string().min(1),
    },
  },
  async ({ to, text }) => {
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    // "/speaking voice-only" for this chat: speak the text instead of sending it as-is, so callers
    // of wa_send don't need to know or care which mode a given chat is in.
    if (isVoiceOnly(to)) {
      let buffer;
      try {
        buffer = speakToBuffer(text);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TTS failed: ${err}` }] };
      }
      const sent = await sock.sendMessage(to, { audio: buffer, mimetype: "audio/mp4", ptt: true });
      appendMessage(to, {
        direction: "out",
        by: "claude",
        text: `[voice] ${text}`,
        ts: Date.now(),
        id: sent?.key?.id ?? null,
      });
      return { content: [{ type: "text", text: `Sent voice message to ${to} (chat is voice-only).` }] };
    }
    const fullText = text.endsWith(ATTRIBUTION) ? text : text + ATTRIBUTION;
    const sent = await sock.sendMessage(to, { text: fullText });
    appendMessage(to, { direction: "out", by: "claude", text: fullText, ts: Date.now(), id: sent?.key?.id ?? null });
    return { content: [{ type: "text", text: `Sent to ${to}.` }] };
  },
);

server.registerTool(
  "wa_send_audio",
  {
    title: "Send an existing WhatsApp voice note",
    description:
      "Send an already-made audio file (e.g. from a TTS engine other than macOS `say`) as a WhatsApp " +
      "voice note. For speaking text directly, use wa_send_voice instead — this is for a file that " +
      "already exists on disk.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      path: z.string().describe("Absolute local path to the audio file (m4a/ogg/mp3 etc.)"),
    },
  },
  async ({ to, path }) => {
    const refusal = guardSend(to);
    if (refusal) return refusal;
    const sock = getSocket();
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${pathError}.` }] };
    }
    let buffer;
    try {
      if (statSync(real).size > 15 * 1024 * 1024) {
        return { isError: true, content: [{ type: "text", text: "Refused: file exceeds 15 MB." }] };
      }
      buffer = withMarkerTone(real);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Could not read ${path}: ${err}` }] };
    }
    const sent = await sock.sendMessage(to, { audio: buffer, mimetype: "audio/mp4", ptt: true });
    appendMessage(to, { direction: "out", by: "claude", text: "[voice]", ts: Date.now(), id: sent?.key?.id ?? null });
    return { content: [{ type: "text", text: `Sent voice message to ${to}.` }] };
  },
);

server.registerTool(
  "wa_send_image",
  {
    title: "Send a WhatsApp image",
    description:
      "Send an image (from a local file path) to an allowlisted WhatsApp JID, with an optional caption. " +
      "Refuses anything not in state/config.json's allowlist.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      path: z.string().describe("Absolute local path to the image file"),
      caption: z.string().optional(),
    },
  },
  async ({ to, path, caption }) => {
    const refusal = guardSend(to, caption);
    if (refusal) return refusal;
    const sock = getSocket();
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${pathError}.` }] };
    }
    let buffer;
    try {
      // ponytail: 15 MB ceiling, matching WhatsApp's own image upload limit.
      if (statSync(real).size > 15 * 1024 * 1024) {
        return { isError: true, content: [{ type: "text", text: "Refused: file exceeds 15 MB." }] };
      }
      buffer = readFileSync(real);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Could not read ${path}: ${err}` }] };
    }
    const fullCaption = (caption ?? "") + ATTRIBUTION;
    const sent = await sock.sendMessage(to, { image: buffer, caption: fullCaption });
    appendMessage(to, { direction: "out", by: "claude", text: fullCaption, ts: Date.now(), id: sent?.key?.id ?? null });
    return { content: [{ type: "text", text: `Sent image to ${to}.` }] };
  },
);

server.registerTool(
  "wa_send_voice",
  {
    title: "Send a WhatsApp voice message",
    description:
      "Speak text (free, offline, no API key) and send it as a WhatsApp voice note. Use for a change " +
      "of pace instead of always texting. Defaults to Piper's Turkish neural voice; pass a macOS " +
      "`say` voice name (see `say -v '?'`) to use that instead, for other languages/genders.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      text: z.string().min(1),
      voice: z
        .string()
        .optional()
        .describe("A macOS `say` voice name, e.g. Cem or Daniel — omit for the default Piper Turkish voice"),
      rate: z
        .number()
        .positive()
        .optional()
        .describe(
          "Speed multiplier: 1.0 is each engine's own native pace, >1 faster, <1 slower — omit for the default of 1.15 (a bit faster than native)",
        ),
    },
  },
  async ({ to, text, voice, rate }) => {
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    let buffer;
    try {
      buffer = speakToBuffer(text, voice, rate);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `TTS failed: ${err}` }] };
    }
    const sent = await sock.sendMessage(to, { audio: buffer, mimetype: "audio/mp4", ptt: true });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: `[voice] ${text}`,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent voice message to ${to}.` }] };
  },
);

server.registerTool(
  "wa_react",
  {
    title: "React to a WhatsApp message",
    description:
      "Send an emoji reaction to a specific logged message instead of a text reply. Pass an empty string to remove a reaction.",
    inputSchema: {
      jid: z.string().describe("Allowlisted chat JID the message belongs to"),
      messageId: z.string().describe("The message id to react to (id field from wa_recent/wa_search)"),
      emoji: z.string().describe("Emoji to react with, e.g. 👍. Empty string removes an existing reaction."),
    },
  },
  async ({ jid, messageId, emoji }) => {
    // An emoji carries nothing worth scanning, but reactions still count against the rate limit:
    // a loop reacting to everything in a group is the same account risk as one sending text.
    const refusal = guardSend(jid);
    if (refusal) return refusal;
    const sock = getSocket();
    const target = findMessage(jid, messageId);
    if (!target) {
      return { isError: true, content: [{ type: "text", text: `Message ${messageId} not found in ${jid}'s log.` }] };
    }
    const key = {
      remoteJid: jid,
      id: messageId,
      fromMe: target.direction === "out",
      ...(jid.endsWith("@g.us") && target.from ? { participant: target.from } : {}),
    };
    await sock.sendMessage(jid, { react: { text: emoji, key } });
    noteOwnReaction(jid, messageId, emoji);
    appendMessage(jid, {
      direction: "out",
      by: "claude",
      kind: "reaction",
      text: emoji,
      removed: !emoji,
      to: messageId,
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: `Reacted ${emoji || "(removed)"} to ${messageId} in ${jid}.` }] };
  },
);

server.registerTool(
  "wa_edit",
  {
    title: "Edit a WhatsApp message Claude sent",
    description:
      "Replace the text of a message this server sent earlier. Only works on Claude's own messages — " +
      "never Burak's, never anyone else's. WhatsApp allows editing for roughly 15 minutes after " +
      "sending and marks the result as edited; both are its rules, not this server's.",
    inputSchema: {
      jid: z.string().describe("Allowlisted chat JID the message belongs to"),
      messageId: z.string().describe("The message id to edit (id field from wa_recent/wa_search)"),
      text: z.string().min(1).describe("The replacement text"),
    },
  },
  async ({ jid, messageId, text }) => {
    // Ownership first: guardSend's rate limit consumes a slot, and a retry loop against a message
    // it will never be allowed to touch used to burn the whole 20/min budget (the log shows two
    // ids with exactly 20 attempts each), so the next legitimate send was refused for a reason
    // that had nothing to do with it.
    const { error } = guardOwnMessage(jid, messageId);
    if (error) return error;
    const refusal = guardSend(jid, text);
    if (refusal) return refusal;
    const sock = getSocket();
    const fullText = text.endsWith(ATTRIBUTION) ? text : text + ATTRIBUTION;
    await sock.sendMessage(jid, { text: fullText, edit: { remoteJid: jid, id: messageId, fromMe: true } });
    appendMessage(jid, { direction: "out", by: "claude", kind: "edit", text: fullText, to: messageId, ts: Date.now() });
    return { content: [{ type: "text", text: `Edited ${messageId} in ${jid}.` }] };
  },
);

server.registerTool(
  "wa_delete",
  {
    title: "Delete a WhatsApp message Claude sent",
    description:
      "Delete-for-everyone a message this server sent earlier. Only works on Claude's own messages — " +
      "never Burak's, never anyone else's. WhatsApp leaves a 'This message was deleted' placeholder " +
      "in the chat; the content goes, the fact of it does not.",
    inputSchema: {
      jid: z.string().describe("Allowlisted chat JID the message belongs to"),
      messageId: z.string().describe("The message id to delete (id field from wa_recent/wa_search)"),
    },
  },
  async ({ jid, messageId }) => {
    // Ownership before the rate limit, same reason as wa_edit.
    const { error } = guardOwnMessage(jid, messageId);
    if (error) return error;
    const refusal = guardSend(jid);
    if (refusal) return refusal;
    const sock = getSocket();
    await sock.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: true } });
    appendMessage(jid, { direction: "out", by: "claude", kind: "delete", to: messageId, ts: Date.now() });
    return {
      content: [
        {
          type: "text",
          text: `Deleted ${messageId} in ${jid}. A "message was deleted" placeholder stays in the chat.`,
        },
      ],
    };
  },
);

server.registerTool(
  "wa_recent",
  {
    title: "Recent WhatsApp messages",
    description:
      "Read recently logged messages (both directions) for ONE allowlisted chat. By default returns " +
      "only new messages since last poll. Omitting `jid` returns per-chat unread counts only, not " +
      "message text — read a chat by naming it, so one chat's content is never pulled into context " +
      "as a side effect of checking another.",
    inputSchema: {
      jid: z.string().optional().describe("The allowlisted JID to read; omit for a counts-only digest across chats"),
      limit: z.number().int().positive().max(200).optional(),
      all: z
        .boolean()
        .optional()
        .describe("If true, fetch all recent messages; if false (default), fetch only new since last poll"),
    },
  },
  async ({ jid, limit, all = false }) => {
    const { allowlist } = loadConfig();
    const n = limit ?? 20;

    if (jid) {
      if (!allowedJid(jid)) {
        return { isError: true, content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }] };
      }
      archiveOldMessages(jid);
      const messages = all ? readRecent(jid, n) : readNewMessages(jid, n);
      // Walk back to the newest entry that actually has an id: reactions are stored without one,
      // so checking only the last element meant a reaction landing on the newest message left the
      // cursor unmoved — and every later poll re-reported that reaction as new, forever, with an
      // unread count that could never be cleared.
      const marker = [...messages].reverse().find((m) => m.id);
      if (marker) updatePollState(jid, marker.id);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }

    // Counts, never text. `wa_search` already requires a single jid for the same reason: chats are
    // separate contexts, and merging them here would leak one chat into a question about another.
    // Poll state is deliberately left untouched — nothing was actually read.
    const digest = allowlist.map((j) => ({ jid: j, new: readNewMessages(j, 200).length }));
    return { content: [{ type: "text", text: JSON.stringify(digest, null, 2) }] };
  },
);

server.registerTool(
  "wa_contacts",
  {
    title: "Known contact names",
    description:
      "Display names seen for allowlisted chats, derived only from messages already logged. Never reads WhatsApp's full contact book.",
    inputSchema: {},
  },
  async () => {
    const { allowlist } = loadConfig();
    return { content: [{ type: "text", text: JSON.stringify(readContacts(allowlist), null, 2) }] };
  },
);

server.registerTool(
  "wa_search",
  {
    title: "Search WhatsApp messages",
    description:
      "Case-insensitive substring search over logged messages (active and archived) for one allowlisted chat. No whole-allowlist search — results never mix chats.",
    inputSchema: {
      jid: z.string().describe("The single allowlisted JID to search"),
      query: z.string().min(1),
      limit: z.number().int().positive().max(200).optional(),
    },
  },
  async ({ jid, query, limit }) => {
    if (!allowedJid(jid)) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }] };
    }
    const n = limit ?? 20;
    return { content: [{ type: "text", text: JSON.stringify(searchMessages([jid], query, n), null, 2) }] };
  },
);

server.registerTool(
  "wa_connect",
  {
    title: "(Re)connect to WhatsApp",
    description:
      "Opens a fresh WhatsApp socket in this process. Use after a wa_send/wa_react call fails with " +
      "'Connection Closed' — another session's process took over the one allowed WhatsApp connection, " +
      "and this reclaims it without restarting the whole MCP server via /mcp.",
    inputSchema: {},
  },
  async () => {
    try {
      await startWhatsApp({ onMessage: handleIncoming, onReaction: handleReaction });
      // startWhatsApp returns as soon as the socket object exists, which is well before WhatsApp
      // has accepted (or rejected) it. Reporting success there is how "Connected." came back for
      // an account that had been logged out. Wait for the connection to actually resolve.
      // ponytail: poll rather than wire up an event listener — this runs once per tool call.
      for (let i = 0; i < 40 && !connectionState().live && !connectionState().lastError; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const { live, lastError } = connectionState();
      if (!live) {
        return {
          isError: true,
          content: [{ type: "text", text: `Not connected: ${lastError ?? "timed out waiting for WhatsApp"}` }],
        };
      }
      return { content: [{ type: "text", text: "Connected." }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Connect failed: ${err}` }] };
    }
  },
);

// Importing this file otherwise connects to WhatsApp as a side effect, which would evict the
// running server. The guard is what lets the test import the parsers above without doing that.
if (!process.env.WA_NO_CONNECT) {
  // Fire-and-forget: a slow or unreachable WhatsApp handshake must never block MCP tool availability.
  void startWhatsApp({ onMessage: handleIncoming, onReaction: handleReaction }).catch((err) => {
    process.stderr.write(`whatsapp-mcp-personal: startup failed: ${err}\n`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
