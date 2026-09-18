import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  jidNormalizedUser,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { z } from "zod";

import {
  allowedJid,
  hasImageDisabled,
  hasLinkPreviewDisabled,
  hasVoiceDisabled,
  isEnglish,
  isIncognito,
  isMentionOnly,
  isVoiceOnly,
  loadConfig,
  loanwordRespellings,
  MEDIA_DIR,
  MEMES_DIR,
  STICKERS_DIR,
  ownerName,
  PIPER_VOICES,
  removeFromAllowlist,
  S2T_MODELS,
  s2tTier,
  setEnglish,
  setImageEnabled,
  setIncognito,
  setMentionOnly,
  setS2tTier,
  setSpeakingRate,
  setT2sTier,
  setVerbosity,
  setVoiceEnabled,
  setVoiceOnly,
  speakingRate,
  STATE_DIR,
  t2sTier,
  verbosity,
} from "./config.mjs";
import {
  appendMessage,
  archiveOldMessages,
  chatStats,
  findMessage,
  logCommand,
  logInbox,
  messageCount,
  participantStats,
  readCommandLog,
  readContacts,
  readNewMessages,
  readRecent,
  searchMessages,
  threadOf,
  unansweredChats,
  updateContact,
  updatePollState,
} from "./store.mjs";
import { buildUrlInfo, enrichLinks } from "./linkinfo.mjs";
import { getPoll, pollCreationMessageFor, renderTally, savePoll, saveTally } from "./polls.mjs";
import { loadSchedule, removeTask, startScheduler, upsertTask } from "./schedule.mjs";
import { connectionState, getSocket, logger, setDropNotifier, startWhatsApp } from "./whatsapp.mjs";

const execFileAsync = promisify(execFile);

// Media worth keeping a copy of.
//
// Video is here so its speech can be transcribed like a voice note's — before that it fell through
// to null and the whole message was dropped, text, caption and all. It sits under the *image*
// privacy gate rather than the voice one (see wantsMedia below): transcribing a video means
// downloading the pictures too, so a chat that opted out of images has opted out of this as well.
// The 25 MB cap in saveMedia means most long videos are skipped and never transcribed, which is the
// intended trade — the cap is about not hoarding, not about transcript coverage.
const MEDIA_KINDS = {
  imageMessage: "image",
  documentMessage: "document",
  stickerMessage: "sticker",
  audioMessage: "voice",
  videoMessage: "video",
  // The round "video note". It carries the same body as a videoMessage (the proto reuses
  // IVideoMessage for it), so it downloads and transcribes through exactly the same path — and
  // before it was listed here it matched nothing and the whole message was dropped.
  ptvMessage: "video",
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
  const message = fallback
    ? "configured s2t tier's model is missing — falling back to the one on disk (bash scripts/setup-voice.sh <tier> to fix)"
    : "no whisper model on disk at all — voice notes will not be transcribed";
  logger.warn({ wanted, fallback }, message);
  // Also to the client: silently transcribing at a worse tier than configured is exactly the kind
  // of degradation that otherwise gets noticed weeks later, as "the transcripts got bad".
  notify(fallback ? "warning" : "error", message, { wanted, fallback: fallback ?? null });
  return fallback ?? wanted;
}
const PIPER_BIN = join(STATE_DIR, "piper-venv", "bin", "piper");

// Resolved per call, not once at load: "/language en" or "/t2s-tier high" has to take effect on
// the next voice note, not on the next server restart. `lang` is "tr" or "en", resolved by the
// caller from the chat's default (isEnglish(jid)) or a per-call override — this function itself
// has no notion of "current" language, since that varies per chat/message, not globally. Same
// fallback shape as whisperModel(): a missing file degrades to whatever Piper voice is actually
// on disk rather than crashing every send, since a hand-edited config or a not-yet-downloaded
// tier shouldn't take TTS down entirely.
function piperModel(lang) {
  const dir = join(STATE_DIR, "piper-models");
  const wanted = join(dir, PIPER_VOICES[lang][t2sTier()]);
  if (existsSync(wanted)) return wanted;
  const fallback = Object.values(PIPER_VOICES)
    .flatMap((tiers) => Object.values(tiers))
    .map((f) => join(dir, f))
    .find((p) => existsSync(p));
  const message = fallback
    ? "configured language/t2s tier's Piper voice is missing — falling back to the one on disk (bash scripts/setup-voice.sh <tier> to fix)"
    : "no Piper voice on disk at all — voice notes will not synthesise";
  logger.warn({ wanted, fallback }, message);
  notify(fallback ? "warning" : "error", message, { wanted, fallback: fallback ?? null });
  return fallback ?? wanted;
}

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
const SENDABLE_DIRS = [MEMES_DIR, STICKERS_DIR, `/private/tmp/claude-${process.getuid()}`];

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

// Writes `text` to `outWav`. Piper (no `voice`) is the default engine, using PIPER_VOICES[lang];
// naming a macOS `say` voice falls back to it for other languages/genders instead (`lang` is
// unused on that path — the voice name already picks the language). `rate` is a speed multiplier
// (1.0 normal, >1 faster, <1 slower), applied as Piper's inverse length-scale or `say`'s -r
// words-per-minute.
function synthWav(text, voice, rate, lang, outWav) {
  if (!voice) {
    // ponytail: punctuation + sentence gaps are the only prosody Piper has (no SSML, no emotion
    // embedding in a single-speaker VITS). Tune SENTENCE_SILENCE by ear; real expressiveness
    // needs a different model, not another flag here.
    execFileSync(
      PIPER_BIN,
      [
        "--model",
        piperModel(lang),
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

// Encodes any audio file to the m4a WhatsApp voice notes need. Every outbound voice note goes
// through here — synthesised or pre-made — so the format conversion can't be forgotten at a call
// site. (This used to also append an audible marker tone distinguishing a synthesised message
// from one the owner recorded, since a voice note has nowhere to put the "(_Claude_)" text
// marker; removed at Burak's request as not worth it.)
function encodeVoiceNote(audioPath) {
  const dir = mkdtempSync(join(tmpdir(), "wa-encode-"));
  try {
    const m4a = join(dir, "out.m4a");
    execFileSync("ffmpeg", ["-y", "-i", audioPath, "-c:a", "aac", m4a], {
      stdio: "ignore",
    });
    return readFileSync(m4a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Neither Piper nor macOS `say` reads emoji sensibly — Piper silently drops them (harmless) but
// `say` on some voices spells out the Unicode name ("grinning face"), so strip them before either
// engine sees the text rather than depend on that being true for every voice going forward.
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// \u{FE0F} (VARIATION SELECTOR-16) rides along on emoji like 🍽️ but is a lone combining mark, not
// part of the main emoji ranges -- a standalone pattern rather than folded into the character
// class above, since a combining mark inside a `[...]` class is a lint error (it can never combine
// with anything there; a class matches individual code points, not grapheme clusters).
const VARIATION_SELECTOR_PATTERN = /\u{FE0F}/gu;

function stripEmoji(text) {
  return text
    .replace(EMOJI_PATTERN, "")
    .replace(VARIATION_SELECTOR_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// The actual word -> respelling dictionary lives in config (state/config.json's
// loanword_respellings, seeded by defaultLoanwordRespellings() in config.mjs) so it can grow from
// conversation without a code change/deploy. See the comment on defaultLoanwordRespellings for why
// this exists at all. Rebuilt fresh per call (not cached) so a hand-edit to config.json takes
// effect on the next voice note without a server restart -- these are short strings, not a hot path.
//
// A trailing \b would miss Turkish suffixes agglutinated straight onto the loanword with no
// apostrophe ("loopun", "contextte" -- both common in casual typing) since there's no word-char
// boundary between "loop" and "un". Instead capture the loanword plus whatever letters follow,
// respell only the head, and re-attach the suffix untouched -- "loopun" -> "lupun".
const ESCAPE_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s) {
  return s.replace(ESCAPE_REGEX_CHARS, "\\$&");
}

// Word-shaped keys ("loop", "config") use \b + a suffix capture so Turkish agglutination
// ("loopun") still respells. Symbol keys ("$", "€") aren't word characters, so \b can never
// match on either side of them -- matched as plain (escaped) literals instead, no suffix logic.
function respellLoanwords(text) {
  const dict = loanwordRespellings();
  const keys = Object.keys(dict);
  if (keys.length === 0) return text;
  const wordKeys = keys.filter((k) => /^[a-zçğıöşü]+$/iu.test(k));
  const symbolKeys = keys.filter((k) => !wordKeys.includes(k));

  let result = text;
  if (wordKeys.length > 0) {
    const pattern = new RegExp(`\\b(${wordKeys.map(escapeRegex).join("|")})([a-zçğıöşü]*)`, "giu");
    result = result.replace(pattern, (_match, base, suffix) => {
      const respelling = dict[base.toLowerCase()];
      const cased = base[0] === base[0].toUpperCase() ? respelling[0].toUpperCase() + respelling.slice(1) : respelling;
      return cased + suffix;
    });
  }
  if (symbolKeys.length > 0) {
    const symbolPattern = new RegExp(`(${symbolKeys.map(escapeRegex).join("|")})`, "g");
    result = result.replace(symbolPattern, (match) => dict[match]);
  }
  return result;
}

// Shared by wa_send_voice and wa_send's voice-only auto-route, so both go through one TTS path.
// `rate` omitted falls back to the persisted default (see speakingRate()/"/speaking-speed"),
// not to each engine's own stock pace. `lang` ("tr"/"en") picks the Piper voice on the default
// (no `voice`) path — callers resolve it from the chat's default (isEnglish) unless overridden.
// Loanword respelling only applies for `lang === "tr"` -- an English word read by the English
// voice doesn't need Turkish-orthography help.
function speakToBuffer(text, voice, rate = speakingRate(), lang = "tr") {
  const dir = mkdtempSync(join(tmpdir(), "wa-tts-"));
  try {
    const wav = join(dir, "out.wav");
    const clean = stripEmoji(text);
    synthWav(lang === "tr" ? respellLoanwords(clean) : clean, voice, rate, lang, wav);
    return encodeVoiceNote(wav);
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

// For a send whose outbound content isn't one string — a poll's question plus its options, all
// individually sent to WhatsApp and stored the same as any other outbound text. guardSend only
// ever scans the one string it is given; a tool with more than one outbound field must call this
// for the rest itself; scanning only the first is the same gap as not scanning at all for whatever
// wasn't checked. Returns `{ text, reason }` for the first offending string, or null when all are
// safe — the caller decides how to phrase the refusal.
export function scanOutboundAll(texts) {
  for (const text of texts) {
    const reason = scanOutbound(text);
    if (reason) return { text, reason };
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
      content: [
        {
          type: "text",
          text: `Refused: ${to} is not on the allowlist (state/config.json).`,
        },
      ],
    };
  }
  if (text) {
    const reason = scanOutbound(text);
    if (reason) {
      logger.warn({ to }, "outbound message refused by secret scan");
      // Surfaced, not just returned to the caller: a refusal here means something assembled text
      // that looked like a credential, which is worth seeing even when the calling tool swallows
      // the error or the send was attempted by an automated path nobody was watching.
      notify("warning", "outbound message refused by secret scan", { to, reason });
      return {
        isError: true,
        content: [{ type: "text", text: `Refused to send: ${reason}.` }],
      };
    }
  }
  // Reads the connection's actual state, not just whether a socket object is installed — a
  // logged-out socket kept passing this check and every send then failed with "Connection Closed".
  const { live, lastError } = connectionState();
  if (!live) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Not connected to WhatsApp: ${lastError ?? "still connecting — try again shortly"}.`,
        },
      ],
    };
  }
  if (overSendLimit()) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Refused: send rate limit (${SEND_LIMIT_PER_MIN}/min) reached.`,
        },
      ],
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
      error: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Message ${messageId} not found in ${jid}'s log.`,
          },
        ],
      },
    };
  }
  // findMessage now reports whether a later row deleted this one. Without this, wa_edit on an
  // already-deleted message sends WhatsApp an edit for something that no longer exists and reports
  // success — the tool would look like it worked and change nothing.
  if (target.deleted) {
    return {
      error: {
        isError: true,
        content: [{ type: "text", text: `Refused: ${messageId} was already deleted.` }],
      },
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

// A shared location has no downloadable body, so it is rendered to text here rather than going
// through MEDIA_KINDS — putting it there would send saveMedia off to download a message that has
// nothing to download, and record the failure as if the media were lost.
//
// Coordinates only, no map URL: this text is stored and can end up quoted back into a chat, and
// building a third-party maps link into every logged location is a decision for whoever reads it,
// not a side effect of logging.
// `isLive` is passed in rather than read off the node: the two proto shapes differ. A pinned
// locationMessage has name/address (and its own isLive flag); a liveLocationMessage has neither —
// it carries a free-text `caption` instead — so reading node.isLive would report every live
// location as a static one.
function locationText(node, isLive) {
  const lat = node.degreesLatitude;
  const lon = node.degreesLongitude;
  const where = [node.name, node.address, node.caption].filter(Boolean).join(", ");
  const coords = Number.isFinite(lat) && Number.isFinite(lon) ? `${lat}, ${lon}` : "coordinates missing";
  const live = isLive || node.isLive ? " (live)" : "";
  return `[location${live}] ${coords}${where ? ` — ${where}` : ""}`;
}

// A shared contact. The display name is the useful part; the phone number is pulled out of the
// vCard because "who sent me that number" is exactly the question this makes searchable. The rest
// of the vCard (addresses, emails, photos) is deliberately left out — it would put a pile of a
// third party's personal data into a searchable text column to no benefit.
function contactText(node) {
  const tel = /TEL[^:\n]*:([+\d\s()-]{5,})/i.exec(node.vcard ?? "")?.[1]?.trim();
  return `[contact] ${node.displayName || "(unnamed)"}${tel ? ` ${tel}` : ""}`;
}

// WhatsApp has shipped five poll versions, all with the same {name, options[]} shape. Rendering
// the question and the options means the poll is readable later even though this server cannot
// decrypt the votes (that needs the messageSecret retained at send time).
function pollText(node) {
  const options = (node.options ?? []).map((o) => o.optionName).filter(Boolean);
  return `[poll] ${node.name || "(no question)"}${options.length ? ` — ${options.join(" / ")}` : ""}`;
}

function eventText(node) {
  const when = node.startTime
    ? new Date(Number(node.startTime) * 1000).toISOString().slice(0, 16).replace("T", " ")
    : null;
  const parts = [node.name || "(unnamed event)", when, node.location?.name, node.description].filter(Boolean);
  return `[event${node.isCanceled ? " cancelled" : ""}] ${parts.join(" — ")}`;
}

// Protocol plumbing rather than something a person sent, so these are legitimately not rows:
// key distribution, receipts, the edit/delete envelope (handled by its own branch in
// handleIncoming), poll votes (unreadable without the poll's retained messageSecret), and the
// context sidecar that rides along with real content. Everything NOT in here that this function
// does not render is reported as unsupported below rather than silently discarded.
const NON_CONTENT_TYPES = new Set([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "fastRatchetKeySenderKeyDistributionMessage",
  "messageContextInfo",
  "reactionMessage",
  "encReactionMessage",
  "pollUpdateMessage",
  "encEventResponseMessage",
  "encCommentMessage",
  "keepInChatMessage",
  "placeholderMessage",
  "botInvokeMessage",
  "botTaskMessage",
]);

export function extractContent(m) {
  if (!m) return null;
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  // Sent from another of the owner's own linked devices. normalizeMessageContent does not unwrap
  // this one, so without the recursion the real message inside it is invisible.
  if (m.deviceSentMessage?.message) return extractContent(unwrapped(m.deviceSentMessage.message));
  // These carry no downloadable body, so they are rendered to text here rather than going through
  // MEDIA_KINDS — putting them there would send saveMedia off to download a message that has
  // nothing to download and record the failure as if media had been lost.
  if (m.locationMessage) return { text: locationText(m.locationMessage, false) };
  if (m.liveLocationMessage) return { text: locationText(m.liveLocationMessage, true) };
  if (m.contactMessage) return { text: contactText(m.contactMessage) };
  if (m.contactsArrayMessage) {
    const list = (m.contactsArrayMessage.contacts ?? []).map((c) => c.displayName).filter(Boolean);
    return { text: `[contacts] ${list.length ? list.join(", ") : m.contactsArrayMessage.displayName || "(empty)"}` };
  }
  const poll =
    m.pollCreationMessage ??
    m.pollCreationMessageV2 ??
    m.pollCreationMessageV3 ??
    m.pollCreationMessageV4 ??
    m.pollCreationMessageV5;
  if (poll) return { text: pollText(poll) };
  if (m.eventMessage) return { text: eventText(m.eventMessage) };
  if (m.groupInviteMessage) {
    const g = m.groupInviteMessage;
    return { text: `[group invite] ${g.groupName || "(unnamed group)"}${g.caption ? ` — ${g.caption}` : ""}` };
  }
  if (m.albumMessage) {
    const a = m.albumMessage;
    return { text: `[album] ${a.expectedImageCount ?? 0} image(s), ${a.expectedVideoCount ?? 0} video(s)` };
  }
  for (const [field, kind] of Object.entries(MEDIA_KINDS)) {
    // A caption is the whole point of keeping these: it survives even when the download fails.
    if (m[field]) return { text: m[field].caption ?? "", kind, node: m[field] };
  }
  // The catch-all, and the reason it exists: WhatsApp's proto defines around sixty message types
  // and this function renders a dozen. For most of this file's life every other one returned null
  // here and the message was dropped whole — no row, no inbox line, no wake, no error — so the
  // only way to find out was someone noticing on their phone that something never arrived. That
  // is silent data loss, and it is worse than an ugly placeholder.
  //
  // Naming the type makes it queryable: searching "[unsupported:" shows which types are actually
  // being received, and that is what should decide whether one is worth rendering properly, rather
  // than guessing from the sixty in the proto.
  const unknown = Object.keys(m).find((k) => m[k] && !NON_CONTENT_TYPES.has(k));
  return unknown ? { text: `[unsupported: ${unknown}]`, unsupported: unknown } : null;
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
    if (quoted)
      return {
        ...extractContent(quoted),
        id: node.contextInfo.stanzaId ?? null,
      };
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
    writeFileSync(path, await downloadMediaMessage(waMessage, "buffer", {}), {
      mode: 0o600,
    });
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

const EYES = "👀";

// Standing instruction from the owner: a message in his own chat, and any message anywhere that
// tags @claude, gets a 👀 as soon as it lands — visible proof it was seen, whether or not a reply
// follows.
//
// Sent from here rather than from the session that the wake eventually reaches, because the wake is
// deliberately debounced: it waits for ten seconds of no typing and can sit for a full five minutes
// behind the ceiling timer. An acknowledgement that arrives five minutes after the message is not
// an acknowledgement. This path runs on arrival, before the message is even queued for a wake.
//
// Never throws: this is a courtesy on the inbound path, and a failed reaction must not take down
// the handling of the message it was reacting to.
async function autoEyes(jid, key, text, replyingToMe = false) {
  const ownJid = jidNormalizedUser(getSocket()?.user?.id);
  const isOwnChat = Boolean(ownJid) && jid === ownJid;
  const taggedIn = /@claude/i.test(text ?? "");
  // A reply to something this server said is addressed to it as plainly as a tag is — people do not
  // @-mention the thing they are visibly replying to.
  if (!isOwnChat && !taggedIn && !replyingToMe) return;
  // Messages this server sent itself come back through the same inbound handler, and reacting to
  // its own attribution line would have it eyes-ing its own output — in the owner's own chat, on
  // every single send. ATTRIBUTION is appended by the wa_send* tools and by nothing else.
  if (typeof text === "string" && text.includes(ATTRIBUTION.trim())) return;
  // Full guard, not just the allowlist: an emoji carries no secret, but a reaction is a send, and
  // it has to respect the connection check and count against the flood limit like any other. The
  // limit is the reason this is checked rather than assumed — a group where something is tagging
  // @claude repeatedly must not be able to spend the whole send budget on reactions.
  if (guardSend(jid)) return;
  try {
    await getSocket().sendMessage(jid, { react: { text: EYES, key } });
    noteOwnReaction(jid, key.id, EYES);
    appendMessage(jid, {
      direction: "out",
      by: "claude",
      kind: "reaction",
      text: EYES,
      to: key.id,
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn({ jid, err: String(err?.message ?? err) }, "auto-eyes reaction failed");
  }
}

const EXTRACT_TEXT_BIN = join(STATE_DIR, "bin", "extract-text");
const OCR_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".webp", ".pdf"]);

// Pulls the words out of an inbound image or PDF so they are searchable, the same bargain voice
// notes already get: a screenshot of a conversation, an error message, a receipt or a scanned form
// is otherwise a row with no text at all, invisible to wa_search and unreadable to anyone reading
// the log later.
//
// Entirely on-device (Vision and PDFKit, via state/bin/extract-text). Nothing about the image
// leaves the machine, which is the only reason this is acceptable to run automatically on
// everything that arrives.
//
// Returns null on every failure, including the binary not being built at all — extraction is a
// bonus on top of the message, never a precondition for logging it.
async function extractText(path) {
  if (!existsSync(EXTRACT_TEXT_BIN)) return null;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!OCR_EXTENSIONS.has(ext)) return null;
  try {
    // Time-limited for the same reason as transcribeVoice: this runs on the inbound path, and a
    // pathological file must not be able to wedge message handling until a restart.
    const { stdout } = await execFileAsync(EXTRACT_TEXT_BIN, [path], {
      timeout: 60_000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch (err) {
    logger.warn({ path, err: String(err?.message ?? err) }, "text extraction failed");
    return null;
  }
}

// Marked rather than merged silently: the caption is what the sender typed, the extracted block is
// what a machine read off the picture. Anything reading this back — a person, or the model quoting
// it into a reply — must be able to tell the difference, and OCR is wrong often enough that
// presenting it as the sender's own words would eventually put words in someone's mouth.
function withExtracted(caption, extracted) {
  if (!extracted) return caption;
  return caption ? `${caption}\n[text in image]\n${extracted}` : `[text in image]\n${extracted}`;
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
  t2sTier: /^\/t2s-tier\s+(low|mid|high)\s*$/i,
  language: /^\/language\s+(tr|en)\s*$/i,
  readMedia: /^\/read-(image|audio)\s+(yes|no)\s*$/i,
  verbosity: /^\/verbosity\s+(low|mid|high)\s*$/i,
  help: /^\/help\s*$/i,
  ai: /^\/ai\s+off\s*$/i,
  incognito: /^\/incognito\s+(on|off)\s*$/i,
};

// "/help" -- the one command that answers into the chat instead of silently flipping a setting.
// Lists every command form plus this chat's current settings and the global ones, so "what's this
// set to right now" never needs `wa_status` or reading state/config.json by hand. Kept as one
// function (not spread across the command handlers above) so the list of commands shown here and
// the list actually recognized by COMMANDS can't drift apart from having two places to update.
function helpText(jid) {
  const commands = [
    '/wakelevel mention-only|verbose — wake only on "@claude" mentions, or every message',
    "/speaking voice-only|text-only — replies to this chat as voice notes, or as text",
    "/speaking-speed N — global TTS speed multiplier (1.0 = native pace)",
    "/s2t-tier low|mid|high — global whisper model tier for incoming voice notes",
    "/t2s-tier low|mid|high — global Piper voice quality tier for outgoing voice notes",
    "/language tr|en — this chat's outgoing voice notes default to Turkish or English",
    "/read-image yes|no — keep (or stop keeping) images/documents/stickers from this chat",
    "/read-audio yes|no — keep and transcribe (or stop) voice notes from this chat",
    "/verbosity low|mid|high — how much detail Claude's replies to this chat carry",
    "/help — this message",
    "/ai off — remove this chat from the allowlist entirely (one-way, no /ai on)",
    "/incognito on|off — while on, no storage/media/wake for this chat at all, overrides wakelevel",
  ];
  const status = [
    `incognito: ${isIncognito(jid) ? "on" : "off"}`,
    `wakelevel: ${isMentionOnly(jid) ? "mention-only" : "verbose"}`,
    `speaking: ${isVoiceOnly(jid) ? "voice-only" : "text-only"}`,
    `language: ${isEnglish(jid) ? "en" : "tr"}`,
    `read-image: ${hasImageDisabled(jid) ? "no" : "yes"}`,
    `read-audio: ${hasVoiceDisabled(jid) ? "no" : "yes"}`,
    `verbosity: ${verbosity(jid)}`,
    `(global) speaking-speed: ${speakingRate()}`,
    `(global) s2t-tier: ${s2tTier()}`,
    `(global) t2s-tier: ${t2sTier()}`,
  ];
  return `Commands:\n${commands.map((c) => `- ${c}`).join("\n")}\n\nCurrent status (this chat unless marked global):\n${status.map((s) => `- ${s}`).join("\n")}`;
}

// Presence-aware wake debounce -------------------------------------------------------------
// logInbox (via state/inbox.log) is what a Monitor tails to wake a session — waking on every
// message mid-burst means reacting to fragment 1 of a thought someone is still typing out.
// Instead, each inbox-log line is queued per jid and only flushed (in order, all of them, none
// dropped) once that jid goes 10 continuous seconds without a "composing"/"recording" presence
// update. This only delays the *wake* signal: appendMessage (the actual message store) already
// ran synchronously before this queue is touched, so wa_recent/wa_search see a message the
// instant it arrives regardless of how long the wake itself is deferred.
//
// Ephemeral by design -- nothing here is persisted. If a durable trail of presence/composing
// events is wanted later (Burak: "in the future i want traceability"), that's a deliberate
// addition on top of this, not implied by it.
const PRESENCE_WAKE_DEBOUNCE_MS = 10_000;
// A "composing" signal that never stops (a scripted client leaving the indicator on, or just an
// unusually long real typing session) would otherwise re-arm the 10s timer forever, deferring the
// wake indefinitely and growing `lines` without bound for the life of the process. This caps the
// total wait from the *first* queued message, independent of how many times composing resets the
// 10s countdown -- flush is guaranteed within 5 minutes of the oldest pending line no matter what.
const PRESENCE_WAKE_MAX_WAIT_MS = 5 * 60_000;
// jid -> { lines: {label, text}[], debounceTimer: NodeJS.Timeout | null, ceilingTimer: NodeJS.Timeout }
// Two independent timers on purpose. `debounceTimer` is the 10s idle countdown -- composing resets
// it, non-composing (re)arms it. `ceilingTimer` is set once, when the jid's queue goes from empty
// to non-empty, and is NEVER reset by composing -- if it were, a presence signal that never stops
// (a scripted client leaving "composing" on, or handlePresenceUpdate's own clearTimeout call below)
// would mean this fires only when something re-arms `debounceTimer`, which composing specifically
// prevents. An independent, un-resettable timer is what actually guarantees the 5-minute ceiling
// regardless of how continuously composing signals arrive.
const pendingWake = new Map();

function flushWake(jid) {
  const entry = pendingWake.get(jid);
  if (!entry) return;
  clearTimeout(entry.debounceTimer);
  clearTimeout(entry.ceilingTimer);
  pendingWake.delete(jid);
  for (const { label, text } of entry.lines) logInbox(jid, label, text);
}

// Arms (or re-arms) the 10s debounce countdown for a jid with a non-empty queue. Called both when
// a new line is queued and when presence goes back to non-composing.
function armDebounce(jid) {
  const entry = pendingWake.get(jid);
  if (!entry || entry.lines.length === 0) return;
  clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => flushWake(jid), PRESENCE_WAKE_DEBOUNCE_MS);
}

function queueWake(jid, label, text) {
  let entry = pendingWake.get(jid);
  if (!entry) {
    entry = {
      lines: [],
      debounceTimer: null,
      ceilingTimer: setTimeout(() => flushWake(jid), PRESENCE_WAKE_MAX_WAIT_MS),
    };
    pendingWake.set(jid, entry);
  }
  entry.lines.push({ label, text });
  armDebounce(jid);
}

// Baileys' presence.update: `id` is the chat jid, `presences` maps participant jid -> state (a
// DM has one entry keyed by the chat's own jid; a group has one per participant). Only
// "composing"/"recording" count as "still typing" -- "paused"/"available"/anything else means
// the 10s countdown should (re)start, since typing has stopped for now.
function handlePresenceUpdate({ id, presences }) {
  const states = Object.values(presences ?? {}).map((p) => p?.lastKnownPresence);
  const stillComposing = states.some((s) => s === "composing" || s === "recording");
  const entry = pendingWake.get(id);
  if (!entry) return; // nothing queued for this jid -- presence here has nothing to debounce yet
  if (stillComposing) {
    clearTimeout(entry.debounceTimer);
  } else {
    armDebounce(id);
  }
}

async function handleIncoming(waMessage) {
  const { key } = waMessage;
  const jid = allowedJid(key.remoteJid, key.remoteJidAlt);
  if (!jid) return;
  const viewOnce = isViewOnce(waMessage.message);
  const content = extractContent(unwrapped(waMessage.message));
  if (!content) return;
  // Reported, not just stored: a placeholder row tells you afterwards that something arrived in a
  // shape this server cannot read, but only a notification tells you while there is still a person
  // around to go and look at the actual message on their phone.
  if (content.unsupported) {
    logger.warn({ jid, type: content.unsupported }, "logged a message type this server cannot render");
    notify("warning", `received an unsupported message type: ${content.unsupported}`, {
      jid,
      type: content.unsupported,
    });
  }
  // Only Burak's own device can flip wake level for a chat — a group member typing this shouldn't
  // be able to silence or unsilence the bot for everyone else.
  if (key.fromMe) {
    const trimmed = content.text?.trim() ?? "";
    const wakeLevel = COMMANDS.wakelevel.exec(trimmed);
    if (wakeLevel) {
      const level = wakeLevel[1].toLowerCase();
      setMentionOnly(jid, level === "mention-only");
      logCommand(jid, "wakelevel", level);
      return;
    }
    const speaking = COMMANDS.speaking.exec(trimmed);
    if (speaking) {
      const mode = speaking[1].toLowerCase();
      setVoiceOnly(jid, mode === "voice-only");
      logCommand(jid, "speaking", mode);
      return;
    }
    // Global, not per-chat — see speakingRate()'s comment in config.mjs.
    const speed = COMMANDS.speakingSpeed.exec(trimmed);
    if (speed) {
      setSpeakingRate(Number(speed[1]));
      logCommand(jid, "speaking-speed", speed[1]);
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
      logCommand(jid, "s2t-tier", tier);
      return;
    }
    // Global too: TTS voice quality, decoupled from s2t_tier — wanting a fast, low-effort
    // transcript and a good-sounding reply are independent preferences. Same missing-file guard
    // as s2t-tier, checked against *this chat's* language, since that's the voice this chat would
    // actually select next.
    const t2s = COMMANDS.t2sTier.exec(trimmed);
    if (t2s) {
      const tier = t2s[1].toLowerCase();
      const voice = PIPER_VOICES[isEnglish(jid) ? "en" : "tr"][tier];
      const model = join(STATE_DIR, "piper-models", voice);
      if (!existsSync(model)) {
        await getSocket()?.sendMessage(jid, {
          text: `Piper voice for "${tier}" not downloaded yet (${voice}). Run: bash scripts/setup-voice.sh ${tier}${ATTRIBUTION}`,
        });
        return;
      }
      setT2sTier(tier);
      logCommand(jid, "t2s-tier", tier);
      return;
    }
    // Per-chat, unlike the others above: which language this chat's outgoing voice notes default
    // to (PIPER_VOICES[lang][t2s_tier]). Incoming voice notes don't use this at all — whisper runs
    // with "-l auto" so STT adapts per clip regardless of who's texting. Refused the same way as
    // s2t-tier/t2s-tier if the resulting Piper voice isn't downloaded, so switching can't silently
    // break TTS for this chat.
    const lang = COMMANDS.language.exec(trimmed);
    if (lang) {
      const newLang = lang[1].toLowerCase();
      const voice = PIPER_VOICES[newLang][t2sTier()];
      const model = join(STATE_DIR, "piper-models", voice);
      if (!existsSync(model)) {
        await getSocket()?.sendMessage(jid, {
          text: `Piper voice for "${newLang}" at the current t2s tier not downloaded yet (${voice}). Run: bash scripts/setup-voice.sh ${t2sTier()}${ATTRIBUTION}`,
        });
        return;
      }
      setEnglish(jid, newLang === "en");
      logCommand(jid, "language", newLang);
      return;
    }
    const media = COMMANDS.readMedia.exec(trimmed);
    if (media) {
      const on = media[2].toLowerCase() === "yes";
      const kind = media[1].toLowerCase();
      if (kind === "image") setImageEnabled(jid, on);
      else setVoiceEnabled(jid, on);
      logCommand(jid, `read-${kind}`, on ? "yes" : "no");
      return;
    }
    // Per-chat, like /language -- how much detail Claude's own replies to *this* chat carry.
    // Unlike s2t-tier/t2s-tier there is no model file to check for existence: this only ever
    // changes what verbosity(jid) reads back at reply time, never a code path that can be "missing."
    const verbosityCmd = COMMANDS.verbosity.exec(trimmed);
    if (verbosityCmd) {
      const level = verbosityCmd[1].toLowerCase();
      setVerbosity(jid, level);
      logCommand(jid, "verbosity", level);
      return;
    }
    // Unlike every command above, this one replies into the chat instead of silently flipping a
    // setting — there's nothing to flip, and a command that changes nothing needs to say
    // something or it looks like it didn't fire.
    if (COMMANDS.help.exec(trimmed)) {
      await getSocket()?.sendMessage(jid, { text: helpText(jid) + ATTRIBUTION });
      logCommand(jid, "help", null);
      return;
    }
    // "/ai off" removes this chat from the allowlist entirely -- a one-way door, deliberately.
    // There's no "/ai on" (see removeFromAllowlist's comment in config.mjs): re-adding means
    // hand-editing state/config.json, same as bringing in a brand new chat. The confirmation
    // reply goes straight through the socket, not guardSend/wa_send -- by the time it'd send,
    // allowedJid(jid) would already return false for this jid, refusing the very message
    // confirming the change. `jid` was already validated at the top of this function while the
    // chat was still allowlisted, so this one send is safe despite bypassing that gate.
    if (COMMANDS.ai.exec(trimmed)) {
      // Logged before removing the jid from the allowlist, not after -- command_log is keyed by
      // jid same as everything else, and there is no reason this one entry needs to be the
      // exception to "log before acting" the others above already follow.
      logCommand(jid, "ai", "off");
      removeFromAllowlist(jid);
      await getSocket()?.sendMessage(jid, {
        text: `AI kapatıldı bu chat için — tekrar açmak için state/config.json'a elle eklemek gerekiyor.${ATTRIBUTION}`,
      });
      return;
    }
    // "/incognito on|off" -- unlike every other per-chat setting, this one is checked below,
    // *outside* this fromMe block, before any storage/logging happens. That's what makes it
    // override mention_only_jids/wakelevel entirely rather than stacking with them: while on,
    // nothing about this chat's traffic reaches state/ at all, so there is nothing for a wake
    // level to gate. The command itself still works while incognito is already on -- toggling it
    // off has to be possible from inside the chat, so this branch runs before the early-return.
    const incognitoCmd = COMMANDS.incognito.exec(trimmed);
    if (incognitoCmd) {
      const mode = incognitoCmd[1].toLowerCase();
      setIncognito(jid, mode === "on");
      // Unconditional, never gated by incognito state -- this is the one thing that must survive
      // regardless of what incognito otherwise suppresses. See logCommand's own comment in
      // store.mjs.
      logCommand(jid, "incognito", mode);
      return;
    }
  }
  // Incognito: no row in state/messages.db, no state/media/ download, no contacts.json update,
  // no state/inbox.log line -- so no wake, regardless of mention_only_jids. This chat's traffic
  // leaves no trace anywhere until "/incognito off". Placed after the command block above so
  // toggling it (from either state) still works; placed before everything else so nothing about
  // an incognito message's content is ever touched beyond this point.
  if (isIncognito(jid)) return;
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
  // Video goes through the same transcriber as a voice note: ffmpeg is already extracting an audio
  // track to 16 kHz mono in there, and it does not care whether the container also holds pictures.
  // What someone says in a video is as much the content of the message as what they say in a voice
  // note, and it used to be dropped entirely.
  const transcript =
    (content.kind === "voice" || content.kind === "video") && media?.path ? await transcribeVoice(media.path) : null;
  // Images and PDFs: the caption stays the message's text and the read-out words are appended.
  const extracted =
    (content.kind === "image" || content.kind === "document") && media?.path ? await extractText(media.path) : null;
  let text = transcript ?? withExtracted(content.text, extracted);
  // Link titles, appended the same way OCR text is. Awaited rather than backgrounded because the
  // row is written just below and an enrichment that lands afterwards would need a second write to
  // a table nothing ever mutates. Bounded at ~6s per link, two links per message.
  //
  // The one thing in this file that reaches outside the machine on an inbound message, hence the
  // per-chat opt-out: fetching a link tells that host the message arrived.
  if (!hasLinkPreviewDisabled(jid)) {
    const links = await enrichLinks(text);
    if (links) text = text ? `${text}\n${links}` : links;
  }
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
    ...(quoted
      ? {
          replyTo: quoted.text || `[${quoted.kind}]`,
          replyToId: quoted.id ?? null,
        }
      : {}),
  });
  // Deliberately not awaited: the reaction is a network round-trip, and the wake queueing below is
  // what gets the message in front of a session. Nothing after this depends on the reaction having
  // landed, and autoEyes swallows its own failures, so there is no rejection to strand.
  // `by: "claude"` is written at send time by the wa_send* tools and by nothing else, so this is the
  // only non-inferred way to know a quoted message was ours. Burak's own phone-typed messages are
  // `direction: "out"` too, and a reply to one of his is not a reply to us.
  const replyingToMe = Boolean(quoted?.id) && findMessage(jid, quoted.id)?.by === "claude";
  void autoEyes(jid, key, text, replyingToMe);
  // mention-only chats stay fully logged above for wa_recent/wa_search — only the wake is gated.
  // `text` already prefers a voice transcript, so saying "claude" in a voice note counts too.
  // `replyingToMe` joins the mention here for the same reason it triggers the reaction: in a
  // mention-only chat, someone replying to this server's own message would otherwise never wake it,
  // and their answer would sit unread in a chat that looks idle.
  if (!isMentionOnly(jid) || /@claude/i.test(text ?? "") || replyingToMe) {
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
    // Queued, not written immediately -- see the presence-aware wake debounce above. The message
    // itself is already durably stored (appendMessage above ran before this point), so nothing
    // here affects wa_recent/wa_search; only when the Monitor-visible wake line appears is delayed.
    queueWake(jid, label, quoted ? `(replying to "${quotedLabel}") ${logText}` : logText);
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

// Passed to Baileys as the socket's `getMessage` option. Baileys calls this by itself, mid-decrypt,
// whenever a vote update arrives and it needs the original poll back to re-derive the encryption
// key — this server never calls it directly. Only ever answers for polls this server itself sent
// (the only ones whose secret was ever saved); returning undefined for anything else is correct,
// not a gap, since a poll we did not create is not one we can decrypt votes for regardless.
async function getStoredPollMessage(key) {
  const entry = getPoll(key.id);
  return entry ? pollCreationMessageFor(entry) : undefined;
}

// One WAMessageUpdate at a time, straight from Baileys' messages.update event. `update.pollUpdates`
// is only present once Baileys has already decrypted whatever votes it could using the poll message
// getStoredPollMessage handed back above — there is nothing left to decrypt here, only to tally and
// persist, since the vote itself is not retained anywhere and this is the only durable record of it.
async function handlePollUpdate({ key, update }) {
  if (!update?.pollUpdates?.length) return;
  const entry = getPoll(key.id);
  if (!entry) return; // a poll from before this feature existed, or one this server did not send
  const ownJid = jidNormalizedUser(getSocket()?.user?.id);
  const tally = getAggregateVotesInPollMessage(
    { message: pollCreationMessageFor(entry), pollUpdates: update.pollUpdates },
    ownJid,
  );
  saveTally(key.id, tally);
}

const server = new McpServer(
  {
    name: "whatsapp-mcp-personal",
    version: "0.1.0",
  },
  // Without this declared, sendLoggingMessage is a silent no-op: the SDK checks
  // `this._capabilities.logging` and returns without sending anything (server/index.js).
  { capabilities: { logging: {} } },
);

// The operational signals that a driving session needs to know about, sent as MCP logging
// notifications. These used to go only to state/baileys.log — which .claude/settings.json denies
// Claude Code from reading — so "falling back to a worse whisper model" or "another process took
// the socket" were invisible to the one reader who could act on them, and surfaced indirectly as a
// puzzling failure much later.
//
// A JSON-RPC notification, not stdout: console.log here would corrupt the protocol stream, which is
// the whole reason this file logs to a file in the first place. This is the sanctioned channel.
//
// Never throws and never awaits: it fires on paths (inbound messages, model fallback) that must not
// fail or stall because a client is slow, disconnected, or not listening for logs at all.
function notify(level, message, data = {}) {
  try {
    void server
      .sendLoggingMessage({ level, logger: "whatsapp-mcp-personal", data: { message, ...data } })
      .catch(() => {});
  } catch {
    // Not connected yet (startup) or the client never negotiated logging. The file log still has it.
  }
}

// Baileys losing an inbound message is the one failure worth interrupting someone for: the message
// is gone, this server cannot ask for it again (Baileys only delivers to a live socket), and the
// only remaining copy is on the owner's phone. So this goes to the wake feed as well as the
// protocol log — a notification nobody is listening for is how the last one went unnoticed for days.
//
// Throttled: a bad batch produces a burst of these, and sixty wake lines about one incident is
// worse than one. First in a window wins, the rest are counted into the next.
const DROP_REPORT_WINDOW_MS = 60_000;
let lastDropReport = 0;
let suppressedDrops = 0;
setDropNotifier((message) => {
  const now = Date.now();
  if (now - lastDropReport < DROP_REPORT_WINDOW_MS) {
    suppressedDrops++;
    return;
  }
  const alsoSuppressed = suppressedDrops;
  lastDropReport = now;
  suppressedDrops = 0;
  const suffix = alsoSuppressed ? ` (+${alsoSuppressed} more in the last minute)` : "";
  notify("error", `WhatsApp dropped an inbound message: ${message}${suffix}`, { reason: message, alsoSuppressed });
  // Deliberately not queueWake: this is not tied to a chat, and it must not wait behind the
  // presence debounce. Straight to the file the Monitor tails.
  logInbox(
    "(server)",
    "⚠️ inbound message lost",
    `${message}${suffix} — only the phone has it now; this server cannot recover it`,
  );
});

server.registerTool(
  "wa_status",
  {
    title: "WhatsApp connection status",
    description: "Connection state, linked own number, and the configured allowlist.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const sock = getSocket();
    const { allowlist, english_jids, verbosity_jids, incognito_jids } = loadConfig();
    const { live, lastError } = connectionState();
    const status = {
      connected: live,
      // Present only when something is wrong, so a healthy status stays uncluttered and a broken
      // one can never be mistaken for healthy.
      ...(lastError ? { problem: lastError } : {}),
      // The tier that is configured and the model actually in use — they differ when the
      // configured tier's file was never downloaded, which is otherwise invisible until you
      // notice transcripts have quietly stopped. Incoming voice notes always use "-l auto",
      // independent of s2t_tier, so there's nothing chat-specific to report for STT language.
      s2t: { tier: s2tTier(), model: basename(whisperModel()) },
      // Language is per-chat (see /language), so status reports which chats default to English
      // rather than a single value — t2s_tier still applies uniformly across chats.
      t2sTier: t2sTier(),
      // Per-chat, like englishJids -- how much detail/length Claude's own replies to each chat
      // carry (see "/verbosity"). Only chats that have set a non-default level appear here; every
      // other allowlisted chat is implicitly "low".
      verbosityJids: verbosity_jids,
      englishJids: english_jids,
      // Chats currently leaving no trace at all (see "/incognito") -- deliberately surfaced here
      // rather than silently invisible, since "why is nothing in wa_recent for this chat" would
      // otherwise look like a bug rather than the intended effect.
      incognitoJids: incognito_jids,
      ownJid: sock?.user?.id ?? null,
      allowlist,
      loggedMessages: Object.fromEntries(allowlist.map((jid) => [jid, messageCount(jid)])),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  },
);

server.registerTool(
  "wa_audit_log",
  {
    title: "In-chat command audit log",
    description:
      "Recent in-chat commands that actually fired (/wakelevel, /verbosity, /incognito, etc.) — the setting and its new value, never message content. " +
      "Reads command_log in state/messages.db, which is otherwise unreadable directly (denied for both the Read tool and, since sandboxing was enabled, " +
      "raw filesystem access from Bash) — this MCP tool runs inside the server process itself, not through that boundary, so it's the intended way to " +
      "check this. Records unconditionally, including while a chat has /incognito on: the toggle event itself is the one thing meant to survive that.",
    inputSchema: {
      jid: z.string().optional().describe("Restrict to one allowlisted JID; omit for every chat's commands"),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, limit }) => {
    if (jid && !allowedJid(jid)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(readCommandLog(jid, limit ?? 50), null, 2) }],
    };
  },
);

server.registerTool(
  "wa_groups",
  {
    title: "List WhatsApp groups",
    description:
      "List groups this number belongs to, with their JIDs. WhatsApp never shows a group JID in the app, so this is the only way to learn one for the allowlist.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const sock = getSocket();
    if (!sock?.user) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not connected to WhatsApp yet — try again shortly.",
          },
        ],
      };
    }
    const { allowlist } = loadConfig();
    const groups = Object.values(await sock.groupFetchAllParticipating()).map((g) => ({
      jid: g.id,
      subject: g.subject ?? "",
      participants: g.participants?.length ?? 0,
      allowed: allowlist.includes(g.id),
    }));
    groups.sort((a, b) => a.subject.localeCompare(b.subject));
    return {
      content: [{ type: "text", text: JSON.stringify(groups, null, 2) }],
    };
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
        buffer = speakToBuffer(text, undefined, undefined, isEnglish(to) ? "en" : "tr");
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `TTS failed: ${err}` }],
        };
      }
      const sent = await sock.sendMessage(to, {
        audio: buffer,
        mimetype: "audio/mp4",
        ptt: true,
      });
      appendMessage(to, {
        direction: "out",
        by: "claude",
        text: `[voice] ${text}`,
        ts: Date.now(),
        id: sent?.key?.id ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: `Sent voice message to ${to} (chat is voice-only).`,
          },
        ],
      };
    }
    const fullText = text.endsWith(ATTRIBUTION) ? text : text + ATTRIBUTION;
    // A preview card built here rather than by Baileys, which would need the optional
    // link-preview-js peer dependency (and cheerio behind it) to do the same job. Best-effort:
    // buildUrlInfo never throws, and a send must not fail because a link was slow or unreachable.
    // Gated on the same per-chat setting as inbound enrichment, so "no link fetching for this chat"
    // means one thing rather than two.
    const linkPreview = hasLinkPreviewDisabled(to) ? null : await buildUrlInfo(fullText);
    const sent = await sock.sendMessage(to, { text: fullText, ...(linkPreview ? { linkPreview } : {}) });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullText,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, path }) => {
    const refusal = guardSend(to);
    if (refusal) return refusal;
    const sock = getSocket();
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${pathError}.` }],
      };
    }
    let buffer;
    try {
      if (statSync(real).size > 15 * 1024 * 1024) {
        return {
          isError: true,
          content: [{ type: "text", text: "Refused: file exceeds 15 MB." }],
        };
      }
      buffer = encodeVoiceNote(real);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Could not read ${path}: ${err}` }],
      };
    }
    const sent = await sock.sendMessage(to, {
      audio: buffer,
      mimetype: "audio/mp4",
      ptt: true,
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: "[voice]",
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return {
      content: [{ type: "text", text: `Sent voice message to ${to}.` }],
    };
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, path, caption }) => {
    const refusal = guardSend(to, caption);
    if (refusal) return refusal;
    const sock = getSocket();
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${pathError}.` }],
      };
    }
    let buffer;
    try {
      // ponytail: 15 MB ceiling, matching WhatsApp's own image upload limit.
      if (statSync(real).size > 15 * 1024 * 1024) {
        return {
          isError: true,
          content: [{ type: "text", text: "Refused: file exceeds 15 MB." }],
        };
      }
      buffer = readFileSync(real);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Could not read ${path}: ${err}` }],
      };
    }
    const fullCaption = (caption ?? "") + ATTRIBUTION;
    const sent = await sock.sendMessage(to, {
      image: buffer,
      caption: fullCaption,
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullCaption,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
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
      "`say` voice name (see `say -v '?'`) to use that instead, for other languages/genders. " +
      "`language` defaults to this chat's usual language (set with /language) but can be overridden " +
      "per call — e.g. to reply in English for one message in an otherwise-Turkish chat.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      text: z.string().min(1),
      voice: z
        .string()
        .optional()
        .describe("A macOS `say` voice name, e.g. Cem or Daniel — omit for the default Piper voice"),
      language: z
        .enum(["tr", "en"])
        .optional()
        .describe("Piper voice language for this one message — omit to use the chat's default (see /language)"),
      rate: z
        .number()
        .positive()
        .optional()
        .describe(
          "Speed multiplier: 1.0 is each engine's own native pace, >1 faster, <1 slower — omit for the default of 1.15 (a bit faster than native)",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, text, voice, language: lang, rate }) => {
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    let buffer;
    try {
      buffer = speakToBuffer(text, voice, rate, lang ?? (isEnglish(to) ? "en" : "tr"));
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `TTS failed: ${err}` }],
      };
    }
    const sent = await sock.sendMessage(to, {
      audio: buffer,
      mimetype: "audio/mp4",
      ptt: true,
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: `[voice] ${text}`,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return {
      content: [{ type: "text", text: `Sent voice message to ${to}.` }],
    };
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ jid, messageId, emoji }) => {
    // An emoji carries nothing worth scanning, but reactions still count against the rate limit:
    // a loop reacting to everything in a group is the same account risk as one sending text.
    const refusal = guardSend(jid);
    if (refusal) return refusal;
    const sock = getSocket();
    const target = findMessage(jid, messageId);
    if (!target) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Message ${messageId} not found in ${jid}'s log.`,
          },
        ],
      };
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
    return {
      content: [
        {
          type: "text",
          text: `Reacted ${emoji || "(removed)"} to ${messageId} in ${jid}.`,
        },
      ],
    };
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
    await sock.sendMessage(jid, {
      text: fullText,
      edit: { remoteJid: jid, id: messageId, fromMe: true },
    });
    appendMessage(jid, {
      direction: "out",
      by: "claude",
      kind: "edit",
      text: fullText,
      to: messageId,
      ts: Date.now(),
    });
    return {
      content: [{ type: "text", text: `Edited ${messageId} in ${jid}.` }],
    };
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ jid, messageId }) => {
    // Ownership before the rate limit, same reason as wa_edit.
    const { error } = guardOwnMessage(jid, messageId);
    if (error) return error;
    const refusal = guardSend(jid);
    if (refusal) return refusal;
    const sock = getSocket();
    await sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: messageId, fromMe: true },
    });
    appendMessage(jid, {
      direction: "out",
      by: "claude",
      kind: "delete",
      to: messageId,
      ts: Date.now(),
    });
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
    // Not readOnlyHint, despite reading nothing but the log: this advances the per-chat poll cursor,
    // so a second call returns a different answer than the first and messages already handed over
    // will not come back as new. Nothing leaves the machine and nothing on WhatsApp changes —
    // hence destructiveHint: false — but calling it is not free of consequence, and a hint that
    // said otherwise would be the one case where these annotations actively misled a caller.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ jid, limit, all = false }) => {
    const { allowlist } = loadConfig();
    const n = limit ?? 20;

    if (jid) {
      if (!allowedJid(jid)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }],
        };
      }
      archiveOldMessages(jid);
      const messages = all ? readRecent(jid, n) : readNewMessages(jid, n);
      // Walk back to the newest entry that actually has an id: reactions are stored without one,
      // so checking only the last element meant a reaction landing on the newest message left the
      // cursor unmoved — and every later poll re-reported that reaction as new, forever, with an
      // unread count that could never be cleared.
      const marker = [...messages].reverse().find((m) => m.id);
      if (marker) updatePollState(jid, marker.id);
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    }

    // Counts, never text. `wa_search` already requires a single jid for the same reason: chats are
    // separate contexts, and merging them here would leak one chat into a question about another.
    // Poll state is deliberately left untouched — nothing was actually read.
    const digest = allowlist.map((j) => ({
      jid: j,
      new: readNewMessages(j, 200).length,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(digest, null, 2) }],
    };
  },
);

server.registerTool(
  "wa_contacts",
  {
    title: "Known contact names",
    description:
      "Display names seen for allowlisted chats, derived only from messages already logged. Never reads WhatsApp's full contact book.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const { allowlist } = loadConfig();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(readContacts(allowlist), null, 2),
        },
      ],
    };
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
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, query, limit }) => {
    if (!allowedJid(jid)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }],
      };
    }
    const n = limit ?? 20;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(searchMessages([jid], query, n), null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "wa_thread",
  {
    title: "Reconstruct a reply thread",
    description:
      "Given one message id, returns the whole reply chain around it in time order: what it was " +
      "replying to, all the way back, plus everything that replied to it and to those. Use when a " +
      "message quotes something and the context matters — wa_recent shows a window of time, this " +
      "shows a conversation. Spans archived messages, so an old thread reconstructs too.",
    inputSchema: {
      jid: z.string().describe("The allowlisted JID the message belongs to"),
      messageId: z.string().describe("Any message id in the thread (id field from wa_recent/wa_search)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, messageId }) => {
    if (!allowedJid(jid)) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }] };
    }
    const thread = threadOf(allowedJid(jid), messageId);
    if (thread.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `Message ${messageId} not found in ${jid}'s log.` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(thread, null, 2) }] };
  },
);

server.registerTool(
  "wa_send_poll",
  {
    title: "Send a WhatsApp poll",
    description:
      "Create a poll in an allowlisted chat. Votes come back encrypted and this server can only " +
      "decrypt them for polls it created itself, so a poll made by anyone else — including one " +
      "made from your own phone — can be read as a message but never as tallied votes. Check " +
      "results later with wa_poll_results, using the message id this returns.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      name: z.string().min(1).describe("The poll question"),
      values: z.array(z.string().min(1)).min(2).max(12).describe("2-12 options"),
      selectableCount: z.number().int().min(1).optional().describe("How many options one voter may pick (default 1)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, name, values, selectableCount }) => {
    const refusal = guardSend(to, name);
    if (refusal) return refusal;
    // guardSend only ever saw `name` — the poll question — but every option in `values` is sent
    // to WhatsApp (and stored) exactly the same as the question is. Without this, a secret placed
    // in an option string instead of the question would sail straight past the scanner: the exact
    // invariant CLAUDE.md documents ("this holds regardless of why the model assembled the text")
    // held for the question and silently didn't for the options sitting right next to it.
    const badOption = scanOutboundAll(values);
    if (badOption) {
      logger.warn({ to }, "outbound poll option refused by secret scan");
      notify("warning", "outbound poll option refused by secret scan", { to, reason: badOption.reason });
      return {
        isError: true,
        content: [{ type: "text", text: `Refused to send: option "${badOption.text}" ${badOption.reason}.` }],
      };
    }
    // WhatsApp's own ceiling on a poll's option count is the same regardless of what a caller
    // asks for, and selectableCount above the number of options offered is simply meaningless.
    if (selectableCount && selectableCount > values.length) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Refused: selectableCount (${selectableCount}) exceeds the number of options (${values.length}).`,
          },
        ],
      };
    }
    const secret = randomBytes(32);
    const sock = getSocket();
    const sent = await sock.sendMessage(to, { poll: { name, values, selectableCount, messageSecret: secret } });
    const messageId = sent?.key?.id ?? null;
    // Saved before anything else touches this poll: if a vote arrives before this line runs,
    // getStoredPollMessage still has the secret to answer with.
    //
    // The send above has already happened by this point, so a failure here is not a refusal —
    // it is a poll that exists on WhatsApp with votes nobody can ever read, and the caller has to
    // be told that plainly rather than shown a generic error that implies nothing went out.
    if (messageId) {
      try {
        savePoll(to, messageId, { name, values, selectableCount, secret });
      } catch (err) {
        logger.error({ to, messageId, err: String(err?.message ?? err) }, "poll secret failed to save");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Sent, but could not save its secret (${err?.message ?? err}) — votes on this poll ` +
                `cannot be read back. state/polls.json may be corrupt and needs a look.`,
            },
          ],
        };
      }
    }
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: `[poll] ${name} — ${values.join(" / ")}`,
      ts: Date.now(),
      id: messageId,
    });
    return {
      content: [
        {
          type: "text",
          text: `Sent poll "${name}" to ${to}. messageId: ${messageId} — use this with wa_poll_results.`,
        },
      ],
    };
  },
);

server.registerTool(
  "wa_poll_results",
  {
    title: "Read a poll's votes",
    description:
      "Current tally for a poll this server sent (see wa_send_poll). Only ever current as of the " +
      "last vote update WhatsApp has delivered — there is no way to ask WhatsApp to resend older " +
      "votes on demand, so a poll checked right after voters answer may lag by a few seconds.",
    inputSchema: {
      jid: z.string().describe("The allowlisted JID the poll was sent to"),
      messageId: z.string().describe("The poll's message id, from wa_send_poll's reply"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, messageId }) => {
    if (!allowedJid(jid)) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }] };
    }
    const entry = getPoll(messageId);
    if (!entry) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No poll with id ${messageId} — either it was not sent by this server, or was sent before wa_send_poll existed.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...entry, secretB64: undefined, rendered: renderTally(entry) }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "wa_stats",
  {
    title: "WhatsApp conversation statistics",
    description:
      "Aggregate statistics over logged messages: volume, reply times, activity by hour and weekday, " +
      "who starts conversations. Name a `jid` for one chat, or omit it for every allowlisted chat at " +
      "once — this returns counts and timings only, never message text, so it is safe across chats in " +
      "a way wa_recent deliberately is not. Set `unanswered` to list chats whose last message was " +
      "theirs and is still sitting there.",
    inputSchema: {
      jid: z.string().optional().describe("One allowlisted JID; omit for all of them"),
      days: z
        .number()
        .int()
        .positive()
        .max(3650)
        .optional()
        .describe("Only count the last N days (default: all history)"),
      unanswered: z
        .boolean()
        .optional()
        .describe("If true, also list chats whose last message was inbound and older than `unansweredHours`"),
      unansweredHours: z.number().positive().max(8760).optional().describe("Threshold for `unanswered` (default 24)"),
      compare: z
        .boolean()
        .optional()
        .describe("With `days`, also measure the equally-long window before it and report the change. For trends."),
      participants: z
        .boolean()
        .optional()
        .describe("For a group `jid`: break the chat down per sender instead of just you-vs-them. Ignored for DMs."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, days, unanswered = false, unansweredHours = 24, compare = false, participants = false }) => {
    const { allowlist } = loadConfig();
    if (jid && !allowedJid(jid)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist.` }],
      };
    }
    // Resolved through allowedJid rather than used raw: a chat can be addressed by either its phone
    // jid or its @lid form, and stats keyed by the un-normalised one would silently come back empty.
    const jids = jid ? [allowedJid(jid)] : allowlist;
    const window = days ? days * 24 * 60 * 60 * 1000 : null;
    const since = window ? Date.now() - window : null;
    const names = readContacts(jids);
    // The comparison window is the equally-long stretch immediately before this one, so "last 7
    // days" is measured against the 7 days before that rather than against all history.
    const comparing = compare && window;
    const stats = jids.map((j) => {
      const current = { name: names[j] ?? null, ...chatStats(j, since) };
      if (!comparing) return current;
      const previous = chatStats(j, since - window, since);
      // Absolute counts, not percentages: a chat going from 2 messages to 4 is not "+100% activity"
      // in any sense worth reporting, and small denominators make percentages actively misleading.
      return {
        ...current,
        previous: { total: previous.total, inbound: previous.inbound ?? 0, outbound: previous.outbound ?? 0 },
        change: {
          total: current.total - previous.total,
          inbound: (current.inbound ?? 0) - (previous.inbound ?? 0),
          outbound: (current.outbound ?? 0) - (previous.outbound ?? 0),
        },
      };
    });
    // Only meaningful for a group, and only when one chat was named: a per-sender breakdown across
    // several chats at once would merge people who are in more than one of them.
    const perSender = participants && jid?.endsWith("@g.us") ? participantStats(allowedJid(jid), since) : null;
    const payload = {
      window: days ? `last ${days} days` : "all history",
      ...(perSender ? { participants: perSender } : {}),
      // Sorted busiest-first: "who do I talk to most" is the question this is usually asked for,
      // and it should not need a second pass over the output to answer.
      chats: stats.sort((a, b) => b.total - a.total),
      ...(unanswered ? { unanswered: unansweredChats(jids, unansweredHours * 60 * 60 * 1000) } : {}),
      hourLegend: "byHour[0..23] and byWeekday[0=Sunday..6] are in this machine's local timezone",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.registerTool(
  "wa_schedule",
  {
    title: "Scheduled recurring work",
    description:
      "List, add, update or remove recurring tasks that the SERVER fires, not the session — they " +
      "survive restarts, /mcp reconnects and having no session at all. A due task writes a line " +
      "into state/inbox.log, which wakes whichever session is tailing it; the server cannot do the " +
      "work itself, it only guarantees the reminder arrives. Use for a daily digest or a weekly " +
      "report, and prefer it over CronCreate, which is session-scoped, expires after 7 days, and " +
      "only fires while the session happens to be idle.",
    inputSchema: {
      action: z.enum(["list", "set", "remove"]).describe("What to do; 'list' takes no other arguments"),
      id: z
        .string()
        .optional()
        .describe("Task id, e.g. 'daily-digest'. Required for set/remove; set overwrites by id."),
      at: z.string().optional().describe('Local 24-hour time, "HH:MM", e.g. "10:03". Required for set.'),
      days: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe("Weekdays to run on, 0=Sunday..6=Saturday. Omit for every day."),
      prompt: z.string().optional().describe("What the woken session should do. Required for set."),
      enabled: z.boolean().optional().describe("Set false to pause without deleting"),
      catchUpMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe("Still fire this long after the scheduled time if the server was down (default 120)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ action, id, at, days, prompt, enabled, catchUpMinutes }) => {
    if (action === "list") {
      return { content: [{ type: "text", text: JSON.stringify(loadSchedule(), null, 2) }] };
    }
    if (!id) {
      return { isError: true, content: [{ type: "text", text: "Refused: id is required for set/remove." }] };
    }
    if (action === "remove") {
      return {
        content: [{ type: "text", text: removeTask(id) ? `Removed scheduled task ${id}.` : `No task with id ${id}.` }],
      };
    }
    const { task, error } = upsertTask({
      id,
      at,
      prompt,
      ...(days ? { days } : {}),
      ...(enabled === undefined ? {} : { enabled }),
      ...(catchUpMinutes === undefined ? {} : { catchUpMinutes }),
    });
    if (error) return { isError: true, content: [{ type: "text", text: `Refused: ${error}.` }] };
    return { content: [{ type: "text", text: `Scheduled ${id}:\n${JSON.stringify(task, null, 2)}` }] };
  },
);

server.registerTool(
  "wa_send_text_only",
  {
    title: "Send a WhatsApp text message (bypassing voice-only mode)",
    description:
      "Send plain text to a voice-only chat without converting it to a voice note. Useful for sharing " +
      "structured information (URLs, metadata, transcripts) where text is clearer than spoken audio.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      text: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, text }) => {
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    const fullText = text.endsWith(ATTRIBUTION) ? text : text + ATTRIBUTION;
    // A preview card built here rather than by Baileys, which would need the optional
    // link-preview-js peer dependency (and cheerio behind it) to do the same job. Best-effort:
    // buildUrlInfo never throws, and a send must not fail because a link was slow or unreachable.
    // Gated on the same per-chat setting as inbound enrichment, so "no link fetching for this chat"
    // means one thing rather than two.
    const linkPreview = hasLinkPreviewDisabled(to) ? null : await buildUrlInfo(fullText);
    const sent = await sock.sendMessage(to, { text: fullText, ...(linkPreview ? { linkPreview } : {}) });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullText,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return {
      content: [{ type: "text", text: `Sent text to ${to} (bypassed voice-only).` }],
    };
  },
);

server.registerTool(
  "wa_send_sticker",
  {
    title: "Send a WhatsApp sticker",
    description:
      "Send a sticker from the library in state/stickers/. Stickers must be 512x512 WebP — build " +
      "one from any image or clip with the meme-tools make_sticker.py script, which handles the " +
      "format and WhatsApp's size limits. A sticker carries no caption by design; send text " +
      "separately if something needs saying. Prefer a sticker over a meme video when the joke is " +
      "one beat rather than a scene.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      path: z.string().describe("Path to the .webp sticker, normally state/stickers/<name>.webp"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, path }) => {
    const refusal = guardSend(to);
    if (refusal) return refusal;
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return { isError: true, content: [{ type: "text", text: `Refused: ${pathError}.` }] };
    }
    // Checked rather than assumed: WhatsApp rejects a non-WebP sticker outright instead of
    // converting it, and the failure surfaces as a silent no-show in the chat rather than an error
    // here — far easier to catch at the door.
    if (!real.toLowerCase().endsWith(".webp")) {
      return {
        isError: true,
        content: [{ type: "text", text: "Refused: a sticker must be a .webp file (build one with make_sticker.py)." }],
      };
    }
    let buffer;
    try {
      buffer = readFileSync(real);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Could not read ${path}: ${err}` }] };
    }
    const sent = await getSocket().sendMessage(to, { sticker: buffer });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      // No ATTRIBUTION: a sticker has no caption field to put it in. The `by` tag above is what
      // marks this as Claude's for wa_edit/wa_delete and for the reply-detection in handleIncoming.
      text: `[sticker] ${basename(real)}`,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent sticker ${basename(real)} to ${to}.` }] };
  },
);

server.registerTool(
  "wa_send_video",
  {
    title: "Send a WhatsApp video",
    description:
      "Send a video file to an allowlisted WhatsApp JID, with an optional caption. " +
      "Refuses anything not in state/config.json's allowlist.",
    inputSchema: {
      to: z.string().describe("Recipient JID, e.g. 491701234567@s.whatsapp.net"),
      path: z.string().describe("Absolute local path to the video file (mp4/mkv/mov etc.)"),
      caption: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, path, caption }) => {
    const refusal = guardSend(to, caption);
    if (refusal) return refusal;
    const sock = getSocket();
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${pathError}.` }],
      };
    }
    let buffer;
    try {
      // 100 MB ceiling for videos (larger than images/audio, but still reasonable)
      if (statSync(real).size > 100 * 1024 * 1024) {
        return {
          isError: true,
          content: [{ type: "text", text: "Refused: file exceeds 100 MB." }],
        };
      }
      buffer = readFileSync(real);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Could not read ${path}: ${err}` }],
      };
    }
    const fullCaption = (caption ?? "") + ATTRIBUTION;
    const sent = await sock.sendMessage(to, {
      video: buffer,
      caption: fullCaption,
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullCaption,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent video to ${to}.` }] };
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    try {
      await startWhatsApp({
        onMessage: handleIncoming,
        onReaction: handleReaction,
        onPresence: handlePresenceUpdate,
        onNotice: notify,
        onPollUpdate: handlePollUpdate,
        getMessage: getStoredPollMessage,
      });
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
          content: [
            {
              type: "text",
              text: `Not connected: ${lastError ?? "timed out waiting for WhatsApp"}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "Connected." }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Connect failed: ${err}` }],
      };
    }
  },
);

// Importing this file otherwise connects to WhatsApp as a side effect, which would evict the
// running server. The guard is what lets the test import the parsers above without doing that.
if (!process.env.WA_NO_CONNECT) {
  // Started here rather than next to the tool registrations so importing this file for tests does
  // not start a timer, same reason the socket is behind this guard.
  //
  // The line goes to inbox.log, not queueWake: a scheduled task belongs to no chat, and it must not
  // sit behind the presence debounce waiting for someone to stop typing.
  startScheduler({
    onDue: (task) => {
      notify("info", `scheduled task due: ${task.id}`, { id: task.id, at: task.at });
      logInbox("(scheduler)", `⏰ ${task.id}`, task.prompt);
    },
  });

  // Fire-and-forget: a slow or unreachable WhatsApp handshake must never block MCP tool availability.
  void startWhatsApp({
    onMessage: handleIncoming,
    onReaction: handleReaction,
    onPresence: handlePresenceUpdate,
    onNotice: notify,
    onPollUpdate: handlePollUpdate,
    getMessage: getStoredPollMessage,
  }).catch((err) => {
    process.stderr.write(`whatsapp-mcp-personal: startup failed: ${err}\n`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
