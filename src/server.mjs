import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadOrCreateDaemonToken, serveOnSocket } from "./daemon-transport.mjs";
import { DocumentScanError, documentScanTexts } from "./doc-scan.mjs";
import { MAX_SEGMENTS, parseSpeechMarkup, speechSegmentCount, splitSentences, toSayText } from "./speech-markup.mjs";
import { ELEVENLABS_SAMPLE_RATE, elevenLabsAvailable, elevenLabsRender } from "./elevenlabs-client.mjs";
import { XTTS_SAMPLE_RATE, xttsRender } from "./xtts-client.mjs";
import { defaultCloneFor, resolveClone } from "./voices.mjs";
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
  isMentionBlocked,
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
  DAEMON_SOCK_PATH,
  DAEMON_TOKEN_PATH,
  XTTS_DEFAULT_SPEAKER,
  STATE_DIR,
  t2sTier,
  verbosity,
} from "./config.mjs";
import {
  appendMessage,
  archiveOldMessages,
  chatStats,
  addMemory,
  chatsOfMessage,
  findMessage,
  forgetMemory,
  INBOX_FILE,
  listMemories,
  receiptsFor,
  recordReceipt,
  logCommand,
  logInbox,
  messageCount,
  normalizeForSearch,
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
import {
  decryptVote,
  getPoll,
  pollCreationMessageFor,
  renderTally,
  saveVote,
  savePoll,
  saveTally,
  voteWakeLine,
} from "./polls.mjs";
import { ackTask, loadSchedule, removeTask, startScheduler, upsertTask } from "./schedule.mjs";
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
// The languages a voice can be rendered in. German has an XTTS voice but no Piper one, so a German
// note never falls back to Piper: reading German text with a Turkish or English Piper voice would be
// wrong in a way that failing is not.
const WHISPER_LANGS = new Set(["tr", "en", "de"]);
function piperModel(lang) {
  if (!PIPER_VOICES[lang]) {
    throw new Error(`there is no Piper voice for "${lang}", only the XTTS service can speak it`);
  }
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
// machine shares. The session scratchpad lives under `/private/tmp/claude-<uid>/`, but only its
// `outbox/` folder is a send source (owner decision, 2026-10-14): the scratchpad as a whole also holds
// tool-result files and anything the model copies there, including a copy of something from
// state/media, which would reopen the cross-chat forwarding hole above.
const CLAUDE_TMP_ROOT = `/private/tmp/claude-${process.getuid()}`;
// state/outbox is where the /generate command's renders land until they are sent and removed. The
// server writes there itself, nothing inbound ever does.
const GENERATE_OUT_DIR = join(STATE_DIR, "outbox");
const SENDABLE_DIRS = [MEMES_DIR, STICKERS_DIR, GENERATE_OUT_DIR];

// A path is in a session outbox when, below the claude tmp root, it passes through
// `scratchpad/outbox/`. Checked on the real path, so a symlink cannot smuggle a file in.
function inSessionOutbox(real) {
  let root;
  try {
    root = realpathSync(CLAUDE_TMP_ROOT);
  } catch {
    return false;
  }
  if (!real.startsWith(root + sep)) return false;
  const parts = real.slice(root.length + 1).split(sep);
  const i = parts.indexOf("scratchpad");
  return i !== -1 && parts[i + 1] === "outbox" && parts.length > i + 2;
}

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
  const ok =
    inSessionOutbox(real) ||
    SENDABLE_DIRS.some((dir) => {
      // A sendable directory that doesn't exist yet must not throw: state/memes is gitignored, so on
      // a fresh clone this threw ENOENT and every send, including one with a perfectly valid path in
      // another sendable dir, died looking like a bug rather than a refusal.
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
      error: `${path} is outside the sendable directories (state/memes, state/stickers, state/outbox, the session scratchpad's outbox/ folder). state/media holds what other chats sent you and is never a send source`,
    };
  }
  return { real };
}

// Renders `segments` (speech and pauses, from speech-markup.mjs) into one wav at `outWav`.
// `renderSpeech(segment, file)` writes one spoken segment to `file` and may be async. A single plain
// segment is rendered straight to `outWav`. Otherwise each segment is rendered separately and the
// pieces are joined with real silence, which is what makes a pause an actual pause.
async function joinSegments(segments, sampleRate, renderSpeech, outWav) {
  if (segments.length === 1 && segments[0].type === "speech" && segments[0].scale === 1) {
    await renderSpeech(segments[0], outWav);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "wa-seg-"));
  try {
    const files = [];
    for (const [i, segment] of segments.entries()) {
      const file = join(dir, `${i}.wav`);
      if (segment.type === "pause") {
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `anullsrc=r=${sampleRate}:cl=mono`,
            "-t",
            String(segment.ms / 1000),
            "-c:a",
            "pcm_s16le",
            file,
          ],
          { stdio: "ignore" },
        );
      } else {
        await renderSpeech(segment, file);
      }
      files.push(file);
    }
    // The concat filter wants identical formats, so every input is normalised first.
    const normalise = files
      .map((_, i) => `[${i}:a]aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=mono[a${i}]`)
      .join(";");
    const joined = files.map((_, i) => `[a${i}]`).join("");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        ...files.flatMap((f) => ["-i", f]),
        "-filter_complex",
        `${normalise};${joined}concat=n=${files.length}:v=0:a=1[out]`,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16le",
        outWav,
      ],
      { stdio: "ignore" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// XTTS sometimes keeps going after the last word and says something it was never given, which a
// listener hears as a random syllable or two at the end of every note. The note is transcribed again
// with word timestamps, and the audio is cut just after the last word of the text that was meant.
// Anything unexpected (no match, a match far from the end, a transcript that will not parse) leaves
// the audio alone: an untrimmed note with a stray syllable beats a note with its last word cut off.

// Compares a spoken word with a written one: lowercase, no diacritics, letters and digits only.
const wordKey = (w) =>
  w
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/[^\p{L}\p{N}]/gu, "");

// whisper-cli prints `[00:00:01.020 --> 00:00:01.170]   word` per word with -ml 1 -sow.
export function parseWordTimestamps(stdout) {
  const words = [];
  for (const m of stdout.matchAll(/\[(\d+):(\d+):(\d+\.\d+) --> (\d+):(\d+):(\d+\.\d+)\]\s+(.+)/g)) {
    const at = (h, mi, sec) => Number(h) * 3600 + Number(mi) * 60 + Number(sec);
    words.push({ start: at(m[1], m[2], m[3]), end: at(m[4], m[5], m[6]), text: m[7].trim() });
  }
  return words;
}

// Where the intended speech ends, in seconds, or null when it cannot be told. Only the last three
// transcribed words are considered: an identical word earlier in the note must never be mistaken for
// the end. A match that merely starts with the intended word ("ocakta" for "ocak") means extra
// syllables are glued on, so the cut lands proportionally inside that word.
export function speechEndSeconds(words, text) {
  const written = text.split(/\s+/).map(wordKey).filter(Boolean);
  const last = written.at(-1);
  if (!last) return null;
  for (let i = words.length - 1; i >= Math.max(0, words.length - 3); i--) {
    const k = wordKey(words[i].text);
    if (!k) continue;
    if (k === last) return words[i].end;
    if (k.startsWith(last)) {
      return words[i].start + (words[i].end - words[i].start) * (last.length / k.length);
    }
  }
  return null;
}

// How well a render says what it was meant to: the longest run of intended words heard in order,
// over the longer of the two word counts. Babble added in the middle or at the end ("anlatıyorum
// bunun") and a dropped word both lower it. 1 is exact, an empty transcript is 0.
// Numbers are left out on both sides: the text spells them ("iki bin yirmi iki", "yüzde seksen")
// and whisper writes digits ("2022", "%80"), which are the same words, not a bad take.
// Whole words only, with the few endings a spelled number takes ("sekseni", "yüzde", "ikinci"):
// a bare prefix match also swallowed "önce", "önemli", "onlar" and "birlikte".
const NUMBER_WORD =
  /^(sifir|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz|yuzde|bin|milyon|milyar)(i|si|de|da|nci|inci|uncu)?$/;
const isNumberish = (k) => /\d/.test(k) || NUMBER_WORD.test(k);
export function speechMatchScore(words, text) {
  const want = text
    .split(/\s+/)
    .map(wordKey)
    .filter((k) => k && !isNumberish(k));
  const heard = words.map((w) => wordKey(w.text)).filter((k) => k && !isNumberish(k));
  if (!want.length) return 1;
  if (!want.length || !heard.length) return 0;
  const row = Array.from({ length: heard.length + 1 }, () => 0);
  for (const w of want) {
    let prev = 0;
    for (let j = 1; j <= heard.length; j++) {
      const keep = row[j];
      row[j] = w === heard[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[heard.length] / Math.max(want.length, heard.length);
}

// `lang` is the language the note was spoken in: whisper forced to Turkish on an English note finds
// the wrong words, so the end of speech came out wrong.
async function trimTrailingBabble(wav, text, lang = "tr") {
  const dir = mkdtempSync(join(tmpdir(), "wa-trim-"));
  try {
    const limit = { timeout: 60_000, killSignal: "SIGKILL" };
    const wav16 = join(dir, "in16k.wav");
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-ar", "16000", "-ac", "1", wav16], limit);
    const { stdout } = await execFileAsync(
      "whisper-cli",
      ["-m", whisperModel(), "-f", wav16, "-l", WHISPER_LANGS.has(lang) ? lang : "tr", "-ml", "1", "-sow"],
      { ...limit, encoding: "utf8" },
    );
    const words = parseWordTimestamps(stdout);
    const end = speechEndSeconds(words, text);
    if (end === null) return speechMatchScore(words, text);
    const keptScore = speechMatchScore(
      words.filter((w) => w.start < end + 0.12),
      text,
    );
    const total = Number(
      (
        await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], {
          ...limit,
          encoding: "utf8",
        })
      ).stdout,
    );
    const cut = end + 0.12;
    // Only a real tail is removed: nothing under a quarter second, and never more than 40% of the note.
    if (!(total - cut > 0.25) || cut < total * 0.6) return speechMatchScore(words, text);
    const trimmed = join(dir, "trimmed.wav");
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        wav,
        "-t",
        String(cut),
        "-af",
        `afade=t=out:st=${Math.max(0, cut - 0.06)}:d=0.06`,
        "-c:a",
        "pcm_s16le",
        trimmed,
      ],
      limit,
    );
    renameSync(trimmed, wav);
    return keptScore;
  } catch (err) {
    logger.warn(
      { err: String(err?.message ?? err) },
      "could not trim the tail of a voice note, sending it as rendered",
    );
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One XTTS sentence, checked. XTTS samples, so the same text gives a different take each time, and
// now and then a take adds a syllable or a word ("anlatıyorum bunun") or garbles one. With `verify`
// each take is transcribed (the babble trim already does that) and scored against the text, and a
// poor take is rendered again, up to MAX_TAKES, keeping the best. A score of null means the check
// itself could not run, which is not a reason to retry. -> { score, takes }
const MAX_TAKES = 3;
const GOOD_TAKE = 0.85;
// Whisper is shaky on a sentence of two or three words, so those pass at a lower score instead of
// burning takes on a transcription error.
const goodEnough = (score, text) => score >= (text.split(/\s+/).length <= 3 ? 0.6 : GOOD_TAKE);
async function renderXttsChecked(request, lang, verify) {
  let best = null;
  let attempts = 0;
  for (let take = 1; take <= (verify ? MAX_TAKES : 1); take++) {
    const file = take === 1 ? request.outWav : `${request.outWav}.take${take}.wav`;
    try {
      await xttsRender({ ...request, outWav: file });
    } catch (err) {
      // The first take failing is a real failure. A retry failing is not: there is already a usable
      // take, and losing it would fail the whole note (or send it to Piper) over an optional redo.
      if (take === 1) throw err;
      rmSync(file, { force: true });
      break;
    }
    attempts = take;
    const score = await trimTrailingBabble(file, request.text, lang);
    if (best === null || (score ?? 1) > (best.score ?? 1)) {
      if (best && best.file !== request.outWav) rmSync(best.file, { force: true });
      best = { file, score, takes: take };
    } else if (file !== request.outWav) {
      rmSync(file, { force: true });
    }
    if (score === null || goodEnough(score, request.text)) break;
  }
  if (best.file !== request.outWav) renameSync(best.file, request.outWav);
  return { score: best.score, takes: attempts };
}

// Writes `text` to `outWav`. The default engine is the resident XTTS-v2 service (xtts-client.mjs):
// a more natural voice, at roughly real-time speed. If it is down, still loading or too slow, the
// note falls back to Piper (using PIPER_VOICES[lang]) rather than failing, so a voice note is never
// lost to it. Naming a macOS `say` voice uses that instead, for other languages/genders (`lang` is
// unused there, the voice name already picks the language). `rate` is a speed multiplier (1.0
// normal, >1 faster, <1 slower), passed to XTTS as its speed, applied as Piper's inverse
// length-scale, or as `say`'s -r words-per-minute.
//
// `clone` ({ ref }) asks for a cloned voice instead. That never falls back: a note that was meant to
// be in someone's voice and is read in another voice is wrong in a way that no note is not.
//
// Delivery markup (speech-markup.mjs) adds chosen pauses and slow/fast spans on every engine, by
// rendering segments separately and joining them with silence.
//
// [voice NAME] spans put several voices in one note. `voices` maps each clone name in the text to the
// reference clip resolveVoiceSpans approved for this chat. A note with spans has no Piper fallback: a
// dialogue where one part silently comes out in the wrong voice is wrong in the same way a clone that
// falls back is.
//
// `verify` re-renders a sentence whose transcript does not match its text (renderXttsChecked), and
// `split` renders each sentence on its own with a short beat between, so a stray syllable at a
// sentence end is trimmed instead of carried into the next one. Both apply to XTTS only. Returns a
// report per spoken XTTS part: [{ text, score, takes }].
export async function synthWav(
  text,
  voice,
  rate,
  lang,
  outWav,
  { clone, cloneOptional, voices = {}, verify = true, split = true } = {},
) {
  const parsed = parseSpeechMarkup(text);
  const segments = parsed.length ? parsed : [{ type: "speech", text, scale: 1, voice: null }];
  const report = [];
  const xtts = async (request) => {
    const result = await renderXttsChecked(request, lang, verify);
    report.push({ text: request.text, ...result });
  };
  if (segments.some((s) => s.voice)) {
    const spanSegments = split ? splitSentences(segments) : segments;
    if (spanSegments.length > 2 * MAX_SEGMENTS) {
      throw new Error(
        `the text has ${spanSegments.length} parts once split into sentences, split it into shorter notes`,
      );
    }
    await joinSegments(
      spanSegments,
      XTTS_SAMPLE_RATE,
      async (segment, file) => {
        const span = segment.voice;
        if (span?.startsWith("say:")) return sayRender(segment.text, span.slice(4), rate / segment.scale, file);
        if (!span && voice) return sayRender(segment.text, voice, rate / segment.scale, file);
        const ref = span ? voices[span] : clone?.ref;
        if (span && !ref) throw new Error(`the "${span}" voice was not approved for this chat`);
        await xtts({
          text: segment.text,
          lang,
          speaker: ref ? undefined : XTTS_DEFAULT_SPEAKER,
          ref,
          speed: rate / segment.scale,
          outWav: file,
        });
      },
      outWav,
    );
    return report;
  }
  if (voice) {
    sayRender(toSayText(text), voice, rate, outWav);
    return report;
  }
  // First choice for an ordinary note: ElevenLabs. Never for a clone (nobody asked for that vendor's
  // voice there, and a clone must not fall back). Any failure, including a used-up quota, drops
  // through to XTTS, then Piper, then macOS `say`, so the note still goes out.
  if (!clone && elevenLabsAvailable()) {
    try {
      await joinSegments(
        segments,
        ELEVENLABS_SAMPLE_RATE,
        (segment, file) => elevenLabsRender({ text: segment.text, lang, speed: rate / segment.scale, outWav: file }),
        outWav,
      );
      report.push({ text, score: null, takes: 1, engine: "elevenlabs" });
      return report;
    } catch (err) {
      logger.warn({ err: String(err.message ?? err) }, "elevenlabs unavailable, using the local voice for this note");
    }
  }
  const xttsSegments = split ? splitSentences(segments) : segments;
  // The part limit is checked before sentences are split, so it is checked again here: a single
  // very long text would otherwise become dozens of sentences, each with up to three takes.
  if (xttsSegments.length > 2 * MAX_SEGMENTS) {
    throw new Error(`the text has ${xttsSegments.length} parts once split into sentences, split it into shorter notes`);
  }
  try {
    await joinSegments(
      xttsSegments,
      XTTS_SAMPLE_RATE,
      async (segment, file) => {
        await xtts({
          text: segment.text,
          lang,
          speaker: clone ? undefined : XTTS_DEFAULT_SPEAKER,
          ref: clone?.ref,
          speed: rate / segment.scale,
          outWav: file,
        });
      },
      outWav,
    );
    return report;
  } catch (err) {
    // An explicitly requested clone never falls back. A chat whose *default* voice is a clone
    // (cloneOptional) does: nobody asked for that voice in particular, and being unable to answer at
    // all because the service is down is the worse outcome.
    if (clone && !cloneOptional) {
      throw new Error(`the cloned voice is unavailable (${err.message}), not falling back to another voice`);
    }
    logger.warn({ err: String(err.message ?? err) }, "xtts unavailable, using piper for this voice note");
    report.length = 0; // whatever XTTS managed before failing is not in the note that goes out
  }
  try {
    await joinSegments(
      segments,
      piperSampleRate(lang),
      (segment, file) => piperRender(segment.text, lang, rate, segment.scale, file),
      outWav,
    );
  } catch (err) {
    // No Piper voice for this language (German has none) or Piper is broken: the system voice is the
    // last resort, so the note still goes out.
    logger.warn({ err: String(err.message ?? err) }, "piper unavailable, using the macOS voice for this note");
    await joinSegments(
      segments,
      XTTS_SAMPLE_RATE,
      (segment, file) =>
        sayRender(toSayText(segment.text), SAY_FALLBACK_VOICE[lang] ?? "Samantha", rate / segment.scale, file),
      outWav,
    );
  }
  return report;
}

// The macOS voice per language when every other engine is down (`say -v '?'` lists what is installed).
const SAY_FALLBACK_VOICE = { tr: "Yelda", en: "Samantha", de: "Anna" };

// One macOS `say` render to a wav. `rate` is the multiplier on say's own default pace. The text goes
// in through a file, never as an argument: `say` parses a text argument that starts with "-f" as its
// input-file option, so "-f<path>" in a voice note would read that file out loud and send it, past
// the secret scan, which only ever saw the text.
function sayRender(text, name, rate, outWav) {
  const aiff = `${outWav}.aiff`;
  const input = `${outWav}.txt`;
  writeFileSync(input, text);
  try {
    execFileSync("say", ["-v", name, "-r", String(Math.round(DEFAULT_SAY_WPM * rate)), "-o", aiff, "-f", input]);
    execFileSync("afconvert", [aiff, outWav, "-d", "LEI16", "-f", "WAVE"]);
  } finally {
    rmSync(aiff, { force: true });
    rmSync(input, { force: true });
  }
}

// Checks the [voice NAME] spans in a voice note's text before anything is spent on it. Every clone
// named goes through resolveClone for this chat, the same check a whole-note clone gets, so a span
// cannot carry a voice into a chat its owner did not list. A tag that does not parse is refused
// rather than read out loud. -> { voices: { name: ref } } or { error }.
export function resolveVoiceSpans(text, to) {
  const count = speechSegmentCount(text);
  if (count > MAX_SEGMENTS) {
    return { error: `the note has ${count} parts and at most ${MAX_SEGMENTS} fit, split it into two notes` };
  }
  const segments = parseSpeechMarkup(text);
  if (segments.some((s) => s.type === "speech" && /\[\/?voice\b/i.test(s.text))) {
    return { error: "a [voice] tag is malformed: use [voice NAME] or [voice say:NAME], closed by [/voice]" };
  }
  const voices = {};
  for (const name of new Set(segments.map((s) => s.voice).filter((v) => v && !v.startsWith("say:")))) {
    const resolved = resolveClone(name, to);
    if (resolved.error) return { error: resolved.error };
    voices[name] = resolved.ref;
  }
  return { voices };
}

// One Piper call. `scale` stretches this render's length (1.35 slow, 0.8 fast) on top of the chat's
// speaking rate.
function piperRender(text, lang, rate, scale, outWav) {
  execFileSync(
    PIPER_BIN,
    [
      "--model",
      piperModel(lang),
      "--length-scale",
      String(scale / rate),
      "--sentence-silence",
      SENTENCE_SILENCE,
      "--output_file",
      outWav,
    ],
    { input: text },
  );
}

// The model's own sample rate, so inserted silence matches what Piper writes.
function piperSampleRate(lang) {
  try {
    return JSON.parse(readFileSync(`${piperModel(lang)}.json`, "utf8")).audio.sample_rate || 22050;
  } catch {
    return 22050;
  }
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

// Loanword respelling for Turkish. Markup tags are left alone: respelling "[voice loop]" into
// "[voice lup]" would name a voice nobody approved for the chat.
function spokenText(clean, lang) {
  if (lang !== "tr") return clean;
  return clean
    .split(/(\[[^\]]*\])/)
    .map((part, i) => (i % 2 ? part : respellLoanwords(part)))
    .join("");
}

// Shared by wa_send_voice and wa_send's voice-only auto-route, so both go through one TTS path.
// `rate` omitted falls back to the persisted default (see speakingRate()/"/speaking-speed"),
// not to each engine's own stock pace. `lang` ("tr"/"en") picks the Piper voice on the default
// (no `voice`) path — callers resolve it from the chat's default (isEnglish) unless overridden.
// Loanword respelling only applies for `lang === "tr"` -- an English word read by the English
// voice doesn't need Turkish-orthography help.
async function speakToBuffer(
  text,
  voice,
  rate = speakingRate(),
  lang = "tr",
  clone,
  cloneOptional = false,
  voices = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "wa-tts-"));
  try {
    const wav = join(dir, "out.wav");
    const clean = stripEmoji(text);
    const spoken = spokenText(clean, lang);
    await synthWav(spoken, voice, rate, lang, wav, { clone, cloneOptional, voices });
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

// Quoted replies (owner decision, 2026-10-15). A send tool can take `reply_to`, a message id from
// wa_recent, and the new message goes out as a reply to it. The id is looked up in the log of the SAME
// chat the message is being sent to, so another chat's message can never be quoted here: quoting copies
// the original's text into the new message, which would be a one-call leak across chats.
export function quoteOptions(sock, to, replyTo) {
  if (!replyTo) return undefined;
  const row = findMessage(to, replyTo);
  if (!row) throw new Error(`Refused: message ${replyTo} is not in ${to}'s log, so it cannot be quoted there.`);
  const fromMe = row.direction === "out";
  const participant = to.endsWith("@g.us") ? (fromMe ? jidNormalizedUser(sock.user?.id) : row.from) : undefined;
  const text = (row.text || `[${row.media?.kind ?? "message"}]`).slice(0, 300);
  return {
    quoted: {
      key: { remoteJid: to, id: replyTo, fromMe, ...(participant ? { participant } : {}) },
      message: { conversation: text },
    },
  };
}

// Tagging people (owner decision, 2026-10-15: use it on my own judgement, sparingly). `mention` is a list
// of names as they show up in the chat; the text carries `@Name` where the tag belongs. A tag sends a
// notification to that person's phone, so it is narrow on purpose: groups only, at most two people,
// only people who have written in THIS chat (so a name can never be used to reach someone outside it),
// never a number on the no_mention_jids list (other chatbots), and never "all".
export const MAX_MENTIONS = 2;
export function resolveMentions(to, names, ownJid) {
  if (!names?.length) return [];
  if (!to.endsWith("@g.us")) throw new Error("Refused: tagging only works in a group.");
  if (names.length > MAX_MENTIONS) throw new Error(`Refused: at most ${MAX_MENTIONS} people per message.`);
  const people = participantStats(to).participants;
  const resolved = [];
  for (const query of names) {
    const q = normalizeForSearch(String(query).replace(/^@/, "").trim());
    if (!q || ["all", "everyone", "herkes", "hepsi"].includes(q)) {
      throw new Error("Refused: tagging everyone is not allowed.");
    }
    const matches = people.filter(
      (p) =>
        (p.name && normalizeForSearch(p.name) === q) ||
        (p.who !== "(you)" && p.who.split("@")[0] === q.replace(/\D/g, "") && q.replace(/\D/g, "")),
    );
    if (matches.length === 0) throw new Error(`Refused: nobody called "${query}" has written in this chat.`);
    if (matches.length > 1) throw new Error(`Refused: "${query}" matches more than one person in this chat.`);
    const jid = matches[0].who === "(you)" ? jidNormalizedUser(ownJid) : matches[0].who;
    if (!jid) throw new Error(`Refused: cannot work out the number for "${query}".`);
    if (isMentionBlocked(jid)) throw new Error(`Refused: "${query}" is on the do-not-tag list.`);
    // The do-not-tag list holds phone numbers, and a lid's digits are a different number, so a person
    // whose number never resolved could be a listed bot behind a lid. Not tagging them is the safe side.
    if (jid.endsWith("@lid")) throw new Error(`Refused: "${query}" has no known phone number, so it is not tagged.`);
    resolved.push({ query: String(query).replace(/^@/, "").trim(), jid, digits: jid.split("@")[0] });
  }
  return resolved;
}

// Puts `@digits` where the text has `@Name` (WhatsApp renders the person's name from the mentions
// list), or at the front if the text never wrote the name.
export function applyMentions(text, resolved) {
  let out = text;
  for (const r of resolved) {
    const re = new RegExp(`@${r.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
    out = re.test(out) ? out.replace(re, `@${r.digits}`) : `@${r.digits} ${out}`;
  }
  return out;
}

function sendWithQuote(sock, to, replyTo, content) {
  return sock.sendMessage(to, content, quoteOptions(sock, to, replyTo));
}

// Which chat a send goes to (owner decisions, 2026-10-17). The allowlist says who may be written to; it
// cannot tell a reply meant for one chat from the same text sent to another allowlisted chat by a wrong
// id. Two checks close that:
//  - `reply_to` alone is enough: the chat is taken from the quoted message, so the target cannot be
//    mistyped. A `to` that disagrees with it is refused.
//  - A chat counts as live for LIVE_MS after something in it woke the session (a tag, a reply, the
//    owner writing there, a scheduled task naming it). A send to a chat that is not live is refused
//    unless the call says why in `unprompted`, which is logged. The owner's own DM is always live.
export const LIVE_MS = 90 * 60_000;
const liveChats = new Map();
export function markLive(jid, now = Date.now()) {
  if (jid) liveChats.set(jid, now);
}
export function isLive(jid, now = Date.now()) {
  const at = liveChats.get(jid);
  return at !== undefined && now - at <= LIVE_MS;
}
// Chat ids written in a scheduled task's prompt: the task names its own target there.
export function jidsIn(text) {
  return [...new Set(String(text ?? "").match(/\b\d{6,}(?:-\d+)?@(?:g\.us|s\.whatsapp\.net)\b/g) ?? [])];
}

// After a restart the map is empty, which would refuse replies to wakes that arrived just before it.
// It is rebuilt from the tail of inbox.log, which holds exactly the wake lines.
export function liveFromInboxLines(lines, now = Date.now()) {
  const out = new Map();
  for (const line of lines) {
    const m = /^\[([^\]]+)\] \[([^\]]+)\] (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || now - at > LIVE_MS) continue;
    for (const jid of m[2] === "(scheduler)" ? jidsIn(m[3]) : [m[2]]) out.set(jid, Math.max(out.get(jid) ?? 0, at));
  }
  return out;
}
function seedLiveChats() {
  try {
    const buf = readFileSync(INBOX_FILE);
    const tail = buf
      .subarray(Math.max(0, buf.length - 256 * 1024))
      .toString("utf8")
      .split("\n");
    for (const [jid, at] of liveFromInboxLines(tail)) markLive(jid, at);
  } catch {
    /* no inbox.log yet */
  }
}

const refused = (text) => ({ isError: true, content: [{ type: "text", text: `Refused: ${text}` }] });

export function resolveTarget({ to, replyTo, unprompted, ownJid, chatsOf = chatsOfMessage, live = isLive }) {
  let target = to;
  if (replyTo) {
    const chats = chatsOf(replyTo);
    if (chats.length === 0) return { error: refused(`message ${replyTo} is not in any chat's log.`) };
    if (to && !chats.includes(to)) {
      return { error: refused(`message ${replyTo} is in ${chats.join(", ")}, not in ${to}. Nothing was sent.`) };
    }
    if (!to && chats.length > 1) {
      return { error: refused(`message ${replyTo} exists in more than one chat, pass \`to\` as well.`) };
    }
    target = to ?? chats[0];
  }
  if (!target) return { error: refused("give `to`, or `reply_to` so the chat can be taken from the quoted message.") };
  if (target !== ownJid && !live(target) && !unprompted?.trim()) {
    return {
      error: refused(
        `${target} has not woken this session in the last ${LIVE_MS / 60_000} minutes, so a send there looks like ` +
          "the wrong chat. If it is meant (a scheduled task, or the owner asked for it), pass `unprompted` with the reason.",
      ),
    };
  }
  return { target };
}

// The schema fields every send tool shares, and the step that turns them into a target.
const TARGET_FIELDS = {
  to: z
    .string()
    .optional()
    .describe("Recipient JID, e.g. 491701234567@s.whatsapp.net. Optional when reply_to is given."),
  reply_to: z
    .string()
    .optional()
    .describe(
      "Message id to quote as a reply (the id field from wa_recent). The send goes to the chat that message is in.",
    ),
  unprompted: z
    .string()
    .optional()
    .describe(
      "Only for a send to a chat that has not woken this session in the last 90 minutes: why it is meant " +
        "(a scheduled task's id, or the owner's instruction). Logged.",
    ),
};

function targetFor({ to, reply_to, unprompted }) {
  const result = resolveTarget({ to, replyTo: reply_to, unprompted, ownJid: jidNormalizedUser(getSocket()?.user?.id) });
  if (result.target && unprompted?.trim() && !isLive(result.target)) {
    logCommand(result.target, "unprompted-send", unprompted.trim().slice(0, 200));
  }
  return result;
}

// A long reply goes out as up to three shorter messages, cut at paragraph boundaries (or sentence
// boundaries when it is one paragraph), the way a person types it (owner decision, 2026-10-15). Text
// at or under SPLIT_OVER characters stays one message. A single unbroken sentence is never cut in the
// middle.
export const SPLIT_OVER = 300;
export const MAX_PARTS = 3;
export function splitForSend(text) {
  const t = text.trim();
  if (t.length <= SPLIT_OVER) return [t];
  let units = t
    .split(/\n{2,}/)
    .map((u) => u.trim())
    .filter(Boolean);
  let glue = "\n\n";
  // No blank lines but single line breaks (a list, URLs one per line): split on the lines and glue
  // them back with a line break, so the formatting survives. Splitting on sentences here used to
  // swallow every newline and send the list as one run-on line.
  if (units.length < 2 && t.includes("\n")) {
    units = t
      .split(/\n/)
      .map((u) => u.trim())
      .filter(Boolean);
    glue = "\n";
  }
  if (units.length < 2) {
    units = t
      .split(/(?<=[.!?\u2026])\s+/u)
      .map((u) => u.trim())
      .filter(Boolean);
    glue = " ";
  }
  if (units.length < 2) return [t];
  // Up to three paragraphs are already the natural messages.
  if (glue === "\n\n" && units.length <= MAX_PARTS) return units;
  const target = t.length / MAX_PARTS;
  const parts = [];
  let cur = "";
  for (const unit of units) {
    if (cur && cur.length >= target && parts.length < MAX_PARTS - 1) {
      parts.push(cur);
      cur = unit;
    } else {
      cur = cur ? `${cur}${glue}${unit}` : unit;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// What woke the session, as a short marker at the start of the wake line, so it can tell a message
// meant for it from background chat at a glance (owner decision, 2026-10-15).
export function triggerLabel({ fromMe, tagged, replyingToMe }) {
  if (tagged) return "[tag]";
  if (replyingToMe) return "[reply to you]";
  return fromMe ? "" : "[ambient]";
}

// The chat since this server last spoke in it, for a wake in a mention-only chat. Those chats store
// untagged messages without waking anything, so the session otherwise sees a tag with none of the
// conversation around it. `rows` come from the same chat's log. Newest 15, oldest first, each cut short.
export function contextBlock(rows, { beforeTs, exceptId }) {
  const spoken = rows
    .filter((r) => r.ts <= beforeTs && r.id !== exceptId && !["reaction", "edit", "delete"].includes(r.kind))
    .sort((a, b) => a.ts - b.ts);
  let lastOwn = -1;
  spoken.forEach((r, i) => {
    if (r.by === "claude") lastOwn = i;
  });
  const since = spoken.slice(lastOwn + 1).slice(-15);
  return since
    .map((r) => `${r.name || "?"}: ${(r.text || `[${r.media?.kind ?? "media"}]`).replace(/\s+/g, " ").slice(0, 140)}`)
    .join(" | ");
}

// Sends `text` as one message, or as up to three when it is long (see splitForSend). Only the first part
// quotes `replyTo`, and the attribution goes on the last. The first part has already passed guardSend
// in the caller; every later part spends its own rate-limit slot, so a long reply costs what it sends.
// A preview card is only built for a part that carries a link, and never for a chat that opted out.
async function sendTextParts(sock, to, text, replyTo, mentionNames = []) {
  const resolved = resolveMentions(to, mentionNames, sock.user?.id);
  const tagged = applyMentions(text.endsWith(ATTRIBUTION) ? text.slice(0, -ATTRIBUTION.length) : text, resolved);
  const parts = splitForSend(tagged);
  let sentCount = 0;
  for (const [i, part] of parts.entries()) {
    if (i > 0) {
      const refusal = guardSend(to, part);
      if (refusal) return { sentCount, refusal };
      // A person does not fire three messages in one breath.
      await new Promise((r) => setTimeout(r, 500 + Math.min(1500, part.length * 6) + Math.random() * 300));
    }
    const fullText = i === parts.length - 1 ? part + ATTRIBUTION : part;
    const linkPreview = hasLinkPreviewDisabled(to) ? null : await buildUrlInfo(fullText);
    const partMentions = resolved.filter((r) => part.includes(`@${r.digits}`)).map((r) => r.jid);
    const sent = await sendWithQuote(sock, to, i === 0 ? replyTo : undefined, {
      text: fullText,
      ...(linkPreview ? { linkPreview } : {}),
      ...(partMentions.length ? { mentions: partMentions } : {}),
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullText,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    sentCount += 1;
  }
  return { sentCount };
}

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
// Tests only: an empty window, for the test that counts the limit exactly.
export function resetSendLimitForTest() {
  if (!process.env.WA_NO_CONNECT) throw new Error("resetSendLimitForTest is for tests only");
  recentSends.length = 0;
}

// `consume: false` only looks: it answers "would a send be refused right now" without spending a slot.
export function overSendLimit(consume = true) {
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > 60_000) recentSends.shift();
  if (recentSends.length >= SEND_LIMIT_PER_MIN) return true;
  if (consume) recentSends.push(now);
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
//
// `consume: false` runs every check, including the limit, but does not spend a slot. Tools that have
// more to validate after this (a file's path, type, content) call `guardCheck` first, do their own
// refusals, and only then `guardSend`, so a loop of bad requests cannot use up the budget that the
// owner's real sends need (owner decision, 2026-10-14).
export function guardCheck(to, text) {
  return guardSend(to, text, { consume: false });
}

export function guardSend(to, text, { consume = true } = {}) {
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
  if (overSendLimit(consume)) {
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
export const SPEAKING_RATE_MIN = 0.5;
export const SPEAKING_RATE_MAX = 3;

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
  // `/generate` takes free text, so the usual `^...$` anchoring is not enough: the attribution this
  // server puts on its own messages would match too. The lookahead refuses anything that carries it.
  generate: /^\/generate(?![\s\S]*\(_Claude_\))(?:\s+([\s\S]*?))?\s*$/i,
  ai: /^\/ai\s+off\s*$/i,
  incognito: /^\/incognito\s+(on|off)\s*$/i,
  memory: /^\/memory\s*$/i,
  forget: /^\/forget\s+(\d{1,9})\s*$/i,
};

// A chat's memories as a short numbered list, for /memory and wa_memory list.
export function formatMemories(rows) {
  if (rows.length === 0) return "bu sohbet icin kayitli bir sey yok";
  return rows.map((r) => `#${r.id} ${r.about ? `${r.about}: ` : ""}${r.text}`).join("\n");
}

// `/generate` (owner decision, 2026-10-15): typed on the owner's own device in any allowlisted chat, the
// server runs scripts/imggen.py itself and sends the picture back as a reply, with no session involved.
// Like every command it is gated on `key.fromMe` where it is dispatched, so nobody else in a group can
// start a render. The text is parsed here into a fixed set of options and handed to imggen.py as separate
// arguments, never through a shell.
export const GENERATE_FLAGS = ["--model", "--prompt", "--negative", "--steps", "--width", "--height", "--seed"];

export function parseGenerateArgs(rest) {
  const text = (rest ?? "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  if (!text) return { error: "usage" };
  const tokens = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => ({
    value: m[1] ?? m[2] ?? m[3],
    quoted: m[3] === undefined,
  }));
  const opts = {};
  if (!GENERATE_FLAGS.includes(tokens[0].value) || tokens[0].quoted) {
    // No flags at all: the whole thing is the prompt.
    opts["--prompt"] = tokens.map((t) => t.value).join(" ");
  } else {
    let flag = null;
    for (const t of tokens) {
      if (!t.quoted && GENERATE_FLAGS.includes(t.value)) {
        flag = t.value;
        opts[flag] = opts[flag] ?? "";
      } else if (flag) {
        opts[flag] = opts[flag] ? `${opts[flag]} ${t.value}` : t.value;
      } else {
        return { error: "usage" };
      }
    }
  }
  const prompt = (opts["--prompt"] ?? "").trim();
  if (!prompt) return { error: "usage" };
  if (prompt.length > 600) return { error: "the prompt is too long (600 characters at most)" };
  const negative = (opts["--negative"] ?? "").trim();
  if (negative.length > 300) return { error: "the negative prompt is too long (300 characters at most)" };
  const model = (opts["--model"] ?? "qwen").trim();
  if (!/^[a-z0-9_-]{1,40}$/.test(model)) return { error: "that is not a model name" };
  const int = (flag, min, max, step = 1) => {
    if (opts[flag] === undefined) return undefined;
    const n = Number(opts[flag]);
    if (!Number.isInteger(n) || n < min || n > max || n % step !== 0) return null;
    return n;
  };
  const steps = int("--steps", 1, 60);
  const width = int("--width", 256, 1280, 16);
  const height = int("--height", 256, 1280, 16);
  const seed = int("--seed", 0, 2147483647);
  if (steps === null) return { error: "--steps must be 1 to 60" };
  if (width === null || height === null) return { error: "--width and --height must be multiples of 16, 256 to 1280" };
  if (seed === null) return { error: "--seed must be a whole number" };
  return { model, prompt, negative, steps, width, height, seed };
}

// `/generate cancel` (also stop, iptal) stops every render started with /generate, running or still
// waiting, from any chat. One person can start them, so one person can stop them all.
export function isCancelRequest(rest) {
  return /^(cancel|stop|iptal)$/i.test((rest ?? "").trim());
}
// Renders in flight, by the number /generate status uses to name them.
const generateRegistry = new Map();
let nextGenerateId = 1;

// `/generate status` lists this chat's renders, `/generate status 7` shows render 7 as it is now: the
// latest step image mflux saved, with how far along it is. Null when the text is not a status request.
export function parseStatusRequest(rest) {
  const m = /^status(?:\s+#?(\d{1,6}))?$/i.exec((rest ?? "").trim());
  return m ? { id: m[1] === undefined ? null : Number(m[1]) } : null;
}

// Newest step image that is finished being written. mflux names them `...step<K>of<N>.png`; the highest K
// is the latest, but a file touched in the last second may still be half written, so it is skipped
// unless it is the only one.
export function latestStep(files, now = Date.now()) {
  const steps = files
    .map((f) => ({ ...f, m: /step(\d+)of(\d+)\.png$/.exec(f.name) }))
    .filter((f) => f.m)
    .map((f) => ({ name: f.name, mtimeMs: f.mtimeMs, step: Number(f.m[1]), total: Number(f.m[2]) }))
    .sort((a, b) => b.step - a.step);
  return steps.find((f) => now - f.mtimeMs >= 1000) ?? steps.at(-1) ?? null;
}

// At most this many renders waiting or running from /generate, so a burst of commands cannot pile up
// hours of GPU work. imggen.py itself runs one render at a time.
const MAX_GENERATE_JOBS = 3;
let generateJobs = 0;
const IMGGEN_SCRIPT = fileURLToPath(new URL("../scripts/imggen.py", import.meta.url));
const IMGGEN_PYTHON = join(STATE_DIR, "imggen-venv", "bin", "python");

async function ownReact(jid, key, emoji) {
  if (guardSend(jid)) return;
  await getSocket()
    ?.sendMessage(jid, { react: { text: emoji, key } })
    .catch(() => {});
}

// A reply that quotes the owner's command. The command message is never stored (commands return before
// the log), so the quote is built from its key and text rather than looked up.
function quoteOwnCommand(sock, jid, key, text) {
  const own = jidNormalizedUser(sock.user?.id);
  return {
    quoted: {
      key: { remoteJid: jid, id: key.id, fromMe: true, ...(jid.endsWith("@g.us") ? { participant: own } : {}) },
      message: { conversation: text.slice(0, 300) },
    },
  };
}

// A command's own reply: through guardSend (allowlist, secret scan, rate limit) and into the log like
// every other message this server sends. Some replies used to go straight to the socket and were
// neither rate-limited nor stored.
async function commandReply(jid, text, options) {
  const sock = getSocket();
  if (!sock || guardSend(jid, text)) return;
  const sent = await sock.sendMessage(jid, { text: text + ATTRIBUTION }, options);
  appendMessage(jid, {
    direction: "out",
    by: "claude",
    text: text + ATTRIBUTION,
    ts: Date.now(),
    id: sent?.key?.id ?? null,
  });
}

async function replyToCommand(jid, key, commandText, text, image = null) {
  const sock = getSocket();
  if (!sock) return;
  const quote = quoteOwnCommand(sock, jid, key, commandText);
  if (!image) return commandReply(jid, text, quote);
  if (guardSend(jid, text)) return;
  const { real, error } = resolveSendable(image);
  if (error) return;
  const sent = await sock.sendMessage(jid, { image: readFileSync(real), caption: text + ATTRIBUTION }, quote);
  appendMessage(jid, {
    direction: "out",
    by: "claude",
    text: text + ATTRIBUTION,
    ts: Date.now(),
    id: sent?.key?.id ?? null,
  });
}

const minutes = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Only this chat's renders are shown here: a picture from a render started in another chat does not
// appear in this one.
async function generateStatus(jid, key, commandText, id) {
  const jobs = [...generateRegistry.values()].filter((j) => j.jid === jid);
  const describe = (job) => {
    let step = null;
    try {
      step = latestStep(
        readdirSync(job.stepsDir).map((name) => ({ name, mtimeMs: statSync(join(job.stepsDir, name)).mtimeMs })),
      );
    } catch {
      /* the folder is gone: the render just finished */
    }
    const elapsed = minutes(Date.now() - job.startedAt);
    const text = step
      ? `#${job.id} ${job.model}: ${step.step}/${step.total} adim, ${elapsed}`
      : `#${job.id} ${job.model}: henuz adim yok (sirada ya da model yukleniyor), ${elapsed}`;
    return { text, image: step ? join(job.stepsDir, step.name) : null };
  };
  if (id !== null) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return replyToCommand(jid, key, commandText, `#${id} yok ya da bitti`);
    const { text, image } = describe(job);
    return replyToCommand(jid, key, commandText, text, image);
  }
  if (jobs.length === 0) return replyToCommand(jid, key, commandText, "calisan yok");
  const lines = jobs.map((j) => describe(j).text);
  // The newest render's picture goes with the list.
  const newest = describe(jobs.at(-1));
  return replyToCommand(jid, key, commandText, lines.join("\n"), newest.image);
}

async function runGenerate(jid, key, rest, commandText) {
  const sock = getSocket();
  if (!sock) return;
  const parsed = parseGenerateArgs(rest);
  const say = (text) => commandReply(jid, text, quoteOwnCommand(sock, jid, key, commandText));
  if (parsed.error === "usage") {
    return say(
      '/generate --model qwen --prompt "a red fez on a desk" --negative "blurry" [--steps N --width N --height N --seed N]',
    );
  }
  if (parsed.error) return say(parsed.error);
  if (generateJobs >= MAX_GENERATE_JOBS) return say("kuyruk dolu, biraz sonra dene");
  generateJobs += 1;
  const controller = new AbortController();
  const id = nextGenerateId++;
  const stepsDir = join(GENERATE_OUT_DIR, `steps-${id}`);
  mkdirSync(stepsDir, { recursive: true });
  generateRegistry.set(id, { id, jid, controller, model: parsed.model, startedAt: Date.now(), stepsDir });
  const file = join(GENERATE_OUT_DIR, `gen-${Date.now()}-${randomBytes(3).toString("hex")}.png`);
  await ownReact(jid, key, "\u23f3");
  try {
    const args = [
      IMGGEN_SCRIPT,
      "generate",
      "--model",
      parsed.model,
      "--prompt",
      parsed.prompt,
      "--out",
      file,
      "--steps-dir",
      stepsDir,
    ];
    if (parsed.negative) args.push("--negative", parsed.negative);
    for (const [flag, value] of [
      ["--steps", parsed.steps],
      ["--width", parsed.width],
      ["--height", parsed.height],
      ["--seed", parsed.seed],
    ]) {
      if (value !== undefined) args.push(flag, String(value));
    }
    // SIGTERM, not SIGKILL: imggen.py catches it and stops its mflux child too.
    const { stdout } = await execFileAsync(IMGGEN_PYTHON, args, {
      timeout: 40 * 60_000,
      killSignal: "SIGTERM",
      signal: controller.signal,
      encoding: "utf8",
    }).catch((err) => ({ stdout: err.stdout ?? "", failed: err }));
    if (controller.signal.aborted) {
      await ownReact(jid, key, "\u{1F6D1}");
      return;
    }
    const last = String(stdout).trim().split("\n").at(-1) ?? "";
    let result = {};
    try {
      result = JSON.parse(last);
    } catch {
      /* not JSON, treated as a failure below */
    }
    if (!result.ok || !existsSync(file)) {
      notify("warning", `/generate failed: ${result.error ?? "no result"}`, { jid, model: parsed.model });
      await ownReact(jid, key, "\u274c");
      return say(/unknown model/.test(result.error ?? "") ? "bilinmeyen model" : "olmadi");
    }
    const { real, error } = resolveSendable(file);
    if (error) throw new Error(error);
    const buffer = readFileSync(real);
    const refusal = guardSend(jid, ATTRIBUTION);
    if (refusal) return;
    const caption = ATTRIBUTION.trim();
    const sent = await sock.sendMessage(jid, { image: buffer, caption }, quoteOwnCommand(sock, jid, key, commandText));
    appendMessage(jid, { direction: "out", by: "claude", text: caption, ts: Date.now(), id: sent?.key?.id ?? null });
    await ownReact(jid, key, "\u2705");
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err) }, "/generate failed");
    await ownReact(jid, key, "\u274c");
  } finally {
    generateRegistry.delete(id);
    generateJobs -= 1;
    rmSync(file, { force: true });
    rmSync(stepsDir, { recursive: true, force: true });
  }
}

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
    '/generate --model qwen --prompt "..." [--negative "..."] [--steps N --width N --height N --seed N] — the server draws an image and sends it here, no session needed',
    "/generate status [id] — progress of this chat's renders, with the latest step; /generate cancel stops them",
    "/memory — what is remembered about this chat and its people, numbered",
    "/forget N — drop memory #N from this chat",
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

// The queue mirrored to disk, so a daemon restart inside the debounce window does not swallow wake
// lines (owner decision, 2026-10-14). The messages themselves were always safe in the store, only the
// wake was lost. Written on every change and replayed once at startup.
const PENDING_WAKE_FILE = process.env.WA_PENDING_WAKE_PATH ?? join(STATE_DIR, "pending-wake.json");
function persistPendingWake() {
  try {
    const out = {};
    for (const [jid, entry] of pendingWake) out[jid] = entry.lines;
    if (Object.keys(out).length === 0) rmSync(PENDING_WAKE_FILE, { force: true });
    else writeFileSync(PENDING_WAKE_FILE, JSON.stringify(out), { mode: 0o600 });
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err) }, "could not persist the pending wake queue");
  }
}

// Called once at startup: anything left on disk was queued by a process that died before flushing.
function replayPendingWake() {
  try {
    if (!existsSync(PENDING_WAKE_FILE)) return;
    const saved = JSON.parse(readFileSync(PENDING_WAKE_FILE, "utf8"));
    rmSync(PENDING_WAKE_FILE, { force: true });
    for (const [jid, lines] of Object.entries(saved)) {
      if (!Array.isArray(lines)) continue;
      for (const { label, text } of lines) logInbox(jid, label, text);
    }
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err) }, "could not replay the pending wake queue");
  }
}

function flushWake(jid) {
  const entry = pendingWake.get(jid);
  if (!entry) return;
  clearTimeout(entry.debounceTimer);
  clearTimeout(entry.ceilingTimer);
  pendingWake.delete(jid);
  for (const { label, text } of entry.lines) logInbox(jid, label, text);
  persistPendingWake();
}

// Tests only: write every queued wake now instead of after the debounce, so a test neither waits 10s
// nor leaves timers running.
export function flushAllWakesForTest() {
  for (const jid of [...pendingWake.keys()]) flushWake(jid);
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
  markLive(jid);
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
  persistPendingWake();
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

// WAProto ProtocolMessage.Type values.
export const PROTOCOL_REVOKE = 0;
export const PROTOCOL_MESSAGE_EDIT = 14;

// The row an edit or delete becomes, or null when there is nothing to store. Pure, for the test.
// The person behind a jid, without the device suffix or the address form's domain.
const authorKey = (jid) =>
  String(jid ?? "")
    .split("@")[0]
    .split(":")[0];

// `target` is the logged message the change points at. Only its own author may change it: a
// protocolMessage names its target by id alone, so without this check anyone in a group could mark
// the owner's message deleted or give it new text, and every read would then show their version.
export function protocolChangeEntry(protocol, { fromMe, ts, from, name, editedText, targetByClaude, target }) {
  const targetId = protocol?.key?.id;
  if (!targetId) return null;
  if (protocol.type !== PROTOCOL_REVOKE && protocol.type !== PROTOCOL_MESSAGE_EDIT) return null;
  // This server already wrote a row when it edited or deleted its own message.
  if (targetByClaude) return null;
  const direction = fromMe ? "out" : "in";
  // A change to a message that is not in the log has nothing to point at.
  if (!target) return null;
  if (target.direction !== direction) return null;
  if (direction === "in" && authorKey(target.from) !== authorKey(from)) return null;
  const kind = protocol.type === PROTOCOL_REVOKE ? "delete" : "edit";
  return {
    direction,
    kind,
    to: targetId,
    ts,
    ...(kind === "edit" ? { text: editedText ?? "" } : {}),
    ...(from ? { from, name } : {}),
  };
}

async function recordProtocolChange(jid, waMessage, protocol) {
  const { key } = waMessage;
  const from = key.participant ? await resolveSender(key.participantAlt ?? key.participant) : null;
  const target = protocol.key?.id ? findMessage(jid, protocol.key.id) : null;
  const edited = protocol.editedMessage ? extractContent(unwrapped(protocol.editedMessage)) : null;
  const entry = protocolChangeEntry(protocol, {
    fromMe: key.fromMe,
    ts: Number(waMessage.messageTimestamp) * 1000 || Date.now(),
    from,
    name: waMessage.pushName,
    editedText: edited?.text,
    targetByClaude: target?.by === "claude",
    target,
  });
  if (entry) appendMessage(jid, entry);
}

export async function handleIncoming(waMessage) {
  const { key } = waMessage;
  const jid = allowedJid(key.remoteJid, key.remoteJidAlt);
  if (!jid) return;
  // A resent copy of a message that first failed to decrypt: cancel its pending "lost" report. Only a
  // message with real content counts: Baileys also upserts the undecryptable CIPHERTEXT stub itself,
  // under the same id, as a placeholder.
  if (waMessage.message && !waMessage.messageStubType) noteArrived(key.id);
  const viewOnce = isViewOnce(waMessage.message);
  // An edit or delete by someone else arrives as a protocolMessage pointing at the original. It used to
  // be dropped as plumbing, so the stored text stayed the original forever. It is now a row of its own
  // (kind edit/delete, `to` the original), the same shape this server already writes for its own edits,
  // which reads derive "edited"/"deleted" from. It never wakes anything.
  const protocol = unwrapped(waMessage.message)?.protocolMessage;
  if (protocol) {
    if (!isIncognito(jid)) {
      await recordProtocolChange(jid, waMessage, protocol).catch((err) =>
        logger.warn({ err: String(err?.message ?? err) }, "could not record an edit or delete"),
      );
    }
    return;
  }
  const pollVote = isIncognito(jid) ? null : unwrapped(waMessage.message)?.pollUpdateMessage;
  if (pollVote) {
    // Never allowed to throw out of here: a vote that cannot be read must not stop the message
    // pipeline for everything after it.
    await handlePollVoteMessage(waMessage, pollVote).catch((err) => logger.error(err, "poll vote handling failed"));
  }
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
      // 0 used to pass the regex and make every voice note fail (Piper got an infinite length scale).
      const rate = Number(speed[1]);
      if (!(rate >= SPEAKING_RATE_MIN && rate <= SPEAKING_RATE_MAX)) {
        await commandReply(jid, `speaking-speed ${SPEAKING_RATE_MIN} ile ${SPEAKING_RATE_MAX} arasinda olmali`);
        return;
      }
      setSpeakingRate(rate);
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
        await commandReply(
          jid,
          `Model for "${tier}" not downloaded yet (${S2T_MODELS[tier]}). Run: bash scripts/setup-voice.sh ${tier}`,
        );
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
        await commandReply(
          jid,
          `Piper voice for "${tier}" not downloaded yet (${voice}). Run: bash scripts/setup-voice.sh ${tier}`,
        );
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
        await commandReply(
          jid,
          `Piper voice for "${newLang}" at the current t2s tier not downloaded yet (${voice}). Run: bash scripts/setup-voice.sh ${t2sTier()}`,
        );
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
    // Starts a render and returns at once: the picture arrives as a reply when it is done, and the
    // command itself never reaches a session or the wake log.
    const generateCmd = COMMANDS.generate.exec(trimmed);
    if (generateCmd) {
      const statusReq = parseStatusRequest(generateCmd[1]);
      if (statusReq) {
        logCommand(jid, "generate", "status");
        void generateStatus(jid, key, trimmed, statusReq.id);
        return;
      }
      if (isCancelRequest(generateCmd[1])) {
        logCommand(jid, "generate", "cancel");
        const count = generateRegistry.size;
        for (const job of generateRegistry.values()) job.controller.abort();
        void ownReact(jid, key, "\u{1F6D1}");
        if (count === 0) void commandReply(jid, "calisan yok");
        return;
      }
      logCommand(jid, "generate", null);
      void runGenerate(jid, key, generateCmd[1] ?? "", trimmed);
      return;
    }
    if (COMMANDS.help.exec(trimmed)) {
      await commandReply(jid, helpText(jid));
      logCommand(jid, "help", null);
      return;
    }
    // Only this chat's memories are shown or touched: the list and the delete are both keyed by jid.
    if (COMMANDS.memory.exec(trimmed)) {
      logCommand(jid, "memory", "list");
      await commandReply(jid, formatMemories(listMemories(jid)));
      return;
    }
    const forgetCmd = COMMANDS.forget.exec(trimmed);
    if (forgetCmd) {
      const ok = forgetMemory(jid, Number(forgetCmd[1]));
      logCommand(jid, "forget", forgetCmd[1]);
      await commandReply(jid, ok ? `#${forgetCmd[1]} silindi` : `#${forgetCmd[1]} bu sohbette yok`);
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
  let linkNote = null;
  if (!hasLinkPreviewDisabled(jid)) {
    const links = await enrichLinks(text);
    if (links) {
      linkNote = links;
      text = text ? `${text}\n${links}` : links;
    }
  }
  // What the wake line shows. The stored `text` above is left as it is (search and wa_recent rely
  // on it), but in the feed a model reads, everything a machine produced is labelled untrusted: an
  // OCR'd meme, a transcript and a page title are all text the sender or a third party controls, and
  // nothing in them is an instruction (owner decision, 2026-10-14).
  const wakeText = transcript
    ? `[voice transcript, untrusted] ${transcript}`
    : [
        content.text,
        extracted ? `[text in image, untrusted]\n${extracted}` : "",
        linkNote ? `[link info, untrusted]\n${linkNote}` : "",
      ]
        .filter(Boolean)
        .join("\n");
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
    const logText = wakeText || `[${content.kind}]`;
    // `?? "media"`: a reply to a video (or any kind extractContent doesn't handle) has neither text
    // nor kind, and rendered "[undefined]" in the wake feed — which reads like a bug in the quote
    // rather than "they replied to something I don't store".
    const quotedLabel = quoted?.text || `[${quoted?.kind ?? "media"}]`;
    // Queued, not written immediately -- see the presence-aware wake debounce above. The message
    // itself is already durably stored (appendMessage above ran before this point), so nothing
    // here affects wa_recent/wa_search; only when the Monitor-visible wake line appears is delayed.
    const tagged = /@claude/i.test(text ?? "");
    const trigger = triggerLabel({ fromMe: Boolean(key.fromMe), tagged, replyingToMe });
    // Mention-only chats store untagged messages without waking anything, so on a wake the session would
    // see the tag and none of the conversation around it. Hand it what was said since it last spoke.
    let context = "";
    if (isMentionOnly(jid) && (tagged || replyingToMe)) {
      const block = contextBlock(readRecent(jid, 60), {
        beforeTs: Number(waMessage.messageTimestamp) * 1000 || Date.now(),
        exceptId: key.id,
      });
      if (block) context = ` || [since your last reply] ${block}`;
    }
    const body = quoted ? `(replying to "${quotedLabel}") ${logText}` : logText;
    // The message itself comes first and the context after it: the wake line is truncated for long
    // lines, and what gets cut must be the background, never the message that needs answering.
    queueWake(jid, label, `${trigger ? `${trigger} ` : ""}${body}${context}`);
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
// Where votes actually arrive on this Baileys version: as a raw pollUpdateMessage in messages.upsert,
// not as a decrypted messages.update (see decryptVote in polls.mjs). handlePollUpdate below is kept
// for a Baileys that restores that path, and would simply record the same vote again.
async function handlePollVoteMessage(waMessage, pollVote) {
  const creationKey = pollVote.pollCreationMessageKey;
  const entry = creationKey?.id ? getPoll(creationKey.id) : null;
  if (!entry) return; // a poll this server did not send, whose secret it never had
  const sock = getSocket();
  const meIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const decrypted = decryptVote(entry, { creationKey, voteKey: waMessage.key, vote: pollVote.vote, meIds });
  if (!decrypted) {
    logger.warn({ poll: creationKey.id }, "could not decrypt a poll vote with any identity pairing");
    return;
  }
  const sentAt = pollVote.senderTimestampMs;
  const ts = Number(sentAt?.toNumber ? sentAt.toNumber() : (sentAt ?? Date.now()));
  const tally = saveVote(creationKey.id, decrypted.voterJid, decrypted.hashes, ts, meIds);
  // Only a poll sent to the owner's own DM wakes a session: that is how Claude asks Burak for
  // permission, and the answer has to reach the session that asked. A vote in a group poll (the
  // weekly attendance one) is read on request with wa_poll_results and must not wake anything.
  if (tally && meIds.includes(jidNormalizedUser(entry.jid))) {
    logInbox(entry.jid, "🗳️ poll vote", voteWakeLine(entry, tally));
  }
}

// A receipt for one of this account's own messages: only for allowlisted, non-incognito chats, and only
// for messages that are in the log. It never wakes anything; reads show it on the message itself.
async function handleReceipt({ key, status, who }) {
  const jid = allowedJid(key.remoteJid, key.remoteJidAlt);
  if (!jid || isIncognito(jid) || !key.id || !findMessage(jid, key.id)) return;
  // Normalised: a receipt names the reader's device (number:0@...), and the same person must count once.
  const reader = who ? jidNormalizedUser(await resolveSender(who)) : "";
  recordReceipt(jid, key.id, jid.endsWith("@g.us") ? reader : "", status);
}

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
  // Only a poll sent to the owner's own DM wakes a session: that is how Claude asks Burak for
  // permission, and the answer has to reach the session that asked. A vote in a group poll (the
  // weekly attendance one) is read on request with wa_poll_results and must not wake anything.
  if (entry.jid === ownJid) logInbox(entry.jid, "🗳️ poll vote", voteWakeLine(entry, tally));
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
// A message that failed to decrypt is not necessarily lost: Baileys 7 asks the phone to resend it
// (placeholder resend, and a retry receipt to the sender), and it often arrives a few seconds later
// under the same id. Reporting it at once said "lost forever" about messages that were then stored
// normally. A drop with an id now waits RECOVERY_WAIT_MS; if the id arrives in the meantime it was
// recovered and nothing is reported. A drop without an id (a whole batch) is reported at once.
export const RECOVERY_WAIT_MS = 30_000;
const pendingDrops = new Map();

export function noteArrived(id) {
  const pending = id ? pendingDrops.get(id) : null;
  if (!pending) return false;
  clearTimeout(pending);
  pendingDrops.delete(id);
  logger.info({ id }, "a message that failed to decrypt was recovered by the resend");
  return true;
}

setDropNotifier((message, jids = [], id = null) => {
  // whatsapp.mjs stays protocol-only and hands up whatever candidate JIDs the log line carried
  // (both the phone-number and @lid form, when present) rather than deciding relevance itself.
  // Two batch-level signatures ("handling notification", "processing offline notification") never
  // carry one — a whole batch failed, not one message's key — so `jids` is empty for those, and an
  // unknown source is treated as relevant rather than silently swallowed: this filter exists to cut
  // noise from groups the model was never watching in the first place, never to hide a drop it
  // can't identify. A drop that *is* identified and matches nothing on the allowlist would have
  // been discarded on arrival anyway (allowedJid gates storage), so losing it costs nothing —
  // that's the actual reason to filter it, not that it is somehow less real.
  if (jids.length > 0 && !allowedJid(...jids)) {
    process.stderr.write(`dropped message ignored (not an allowlisted chat): ${message} ${jids.join(",")}\n`);
    return;
  }
  if (!id) return reportDrop(message, false);
  if (pendingDrops.has(id)) return;
  const timer = setTimeout(() => {
    pendingDrops.delete(id);
    reportDrop(message, true);
  }, RECOVERY_WAIT_MS);
  timer.unref?.();
  pendingDrops.set(id, timer);
});

function reportDrop(message, resendTried) {
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
    resendTried
      ? `${message}${suffix} — the phone was asked to resend it and it did not arrive within ${RECOVERY_WAIT_MS / 1000}s; only the phone has it now`
      : `${message}${suffix} — only the phone has it now; this server cannot recover it`,
  );
}

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
      ...TARGET_FIELDS,
      mention: z
        .array(z.string())
        .max(2)
        .optional()
        .describe(
          "Groups only. Names, as shown in the chat, of up to two people to tag. Write @Name in the text where the tag goes. People who have not written in this chat are refused, so are bots and everyone-style tags.",
        ),
      text: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, text, reply_to, unprompted, mention }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const spans = isVoiceOnly(to) ? resolveVoiceSpans(text, to) : { voices: {} };
    if (spans.error) return { isError: true, content: [{ type: "text", text: `Refused: ${spans.error}.` }] };
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    // "/speaking voice-only" for this chat: speak the text instead of sending it as-is, so callers
    // of wa_send don't need to know or care which mode a given chat is in.
    if (isVoiceOnly(to)) {
      let buffer;
      try {
        buffer = await speakToBuffer(
          text,
          undefined,
          undefined,
          isEnglish(to) ? "en" : "tr",
          defaultCloneFor(to),
          true,
          spans.voices,
        );
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `TTS failed: ${err}` }],
        };
      }
      const sent = await sendWithQuote(sock, to, reply_to, {
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
    const { sentCount, refusal: partRefusal } = await sendTextParts(sock, to, text, reply_to, mention);
    if (partRefusal) {
      return {
        ...partRefusal,
        content: [
          { type: "text", text: `Sent ${sentCount} part(s) to ${to}, then stopped: ${partRefusal.content[0].text}` },
        ],
      };
    }
    return { content: [{ type: "text", text: `Sent to ${to}${sentCount > 1 ? ` (${sentCount} messages)` : ""}.` }] };
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
      ...TARGET_FIELDS,
      path: z.string().describe("Absolute local path to the audio file (m4a/ogg/mp3 etc.)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, path }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const refusal = guardCheck(to);
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
    const spend = guardSend(to);
    if (spend) return spend;
    const sent = await sendWithQuote(sock, to, reply_to, {
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
      ...TARGET_FIELDS,
      path: z.string().describe("Absolute local path to the image file"),
      caption: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, path, caption, reply_to, unprompted }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const refusal = guardCheck(to, caption);
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
    const spend = guardSend(to, caption);
    if (spend) return spend;
    const sent = await sendWithQuote(sock, to, reply_to, {
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
      "of pace instead of always texting. Defaults to the local XTTS voice (Piper if that service is " +
      "down); pass a macOS `say` voice name (see `say -v '?'`) to use that instead, or `clone` for a " +
      "cloned voice. Several voices fit in one note: wrap a part in [voice NAME]...[/voice] for a " +
      "cloned voice or [voice say:NAME]...[/voice] for a macOS one (each clone is checked against " +
      "this chat like `clone` is), and the rest is read in the note's own voice. " +
      "`language` defaults to this chat's usual language (set with /language) but can be overridden " +
      "per call — e.g. to reply in English for one message in an otherwise-Turkish chat.",
    inputSchema: {
      ...TARGET_FIELDS,
      text: z.string().min(1),
      voice: z
        .string()
        .optional()
        .describe("A macOS `say` voice name, e.g. Cem or Daniel — omit for the default Piper voice"),
      language: z
        .enum(["tr", "en", "de"])
        .optional()
        .describe(
          "Language for this one message — omit to use the chat's default (see /language). German is XTTS only: there is no German Piper voice, so it needs the XTTS service up",
        ),
      clone: z
        .string()
        .optional()
        .describe(
          "Name of a cloned voice (state/voices/voices.json), only usable in the chats that voice lists. " +
            "Never falls back to another voice: if the clone cannot be rendered the call fails.",
        ),
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
  async ({ to: toArg, text, voice, language: lang, rate, clone, reply_to, unprompted }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    // Every refusal runs before guardSend, which spends a rate-limit slot.
    const check = guardCheck(to, text);
    if (check) return check;
    let cloned;
    if (clone) {
      cloned = resolveClone(clone, to);
      if (cloned.error) return { isError: true, content: [{ type: "text", text: `Refused: ${cloned.error}.` }] };
    }
    const spans = resolveVoiceSpans(text, to);
    if (spans.error) return { isError: true, content: [{ type: "text", text: `Refused: ${spans.error}.` }] };
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    let buffer;
    try {
      // No explicit clone and no `say` voice named: the chat's default clone, if it has one.
      const fallbackClone = !cloned && !voice ? defaultCloneFor(to) : null;
      buffer = await speakToBuffer(
        text,
        voice,
        rate,
        lang ?? (isEnglish(to) ? "en" : "tr"),
        cloned ?? fallbackClone ?? undefined,
        !cloned && Boolean(fallbackClone),
        spans.voices,
      );
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `TTS failed: ${err}` }],
      };
    }
    const sent = await sendWithQuote(sock, to, reply_to, {
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

// Voices that may be rendered to a file. A file in the outbox can be sent to any allowlisted chat
// (inside a video, as audio), so a clone qualifies only when it is already allowed in every chat,
// "*" in voices.json. A voice limited to certain chats stays a voice-note-only voice, and the file
// path can never take it anywhere a voice note could not go.
export function resolveFileVoices(text, clone) {
  const limited = (name) => `the "${name}" voice is limited to certain chats, so it cannot be rendered to a file`;
  const spans = resolveVoiceSpans(text, "*");
  if (spans.error) {
    const name = /is not allowed/.test(spans.error) ? spans.error.match(/"([^"]+)"/)?.[1] : null;
    return { error: name ? limited(name) : spans.error };
  }
  if (!clone) return { voices: spans.voices };
  const cloned = resolveClone(clone, "*");
  if (cloned.error) return { error: /is not allowed/.test(cloned.error) ? limited(clone) : cloned.error };
  return { voices: spans.voices, clone: cloned };
}

server.registerTool(
  "wa_render_voice",
  {
    title: "Render speech to files in the outbox",
    description:
      "Speak text into state/outbox/NAME.wav without sending anything, for narration under a video or " +
      "a soundtrack built with the sound-design skill. Give `text` and `name` for one line, or `lines` " +
      "for many in one call. Same engines and [voice NAME] spans as wa_send_voice. Each sentence is " +
      "rendered alone and checked against its text, with up to three takes, and the result reports " +
      "each line's length and match score (1 is exact). A cloned voice is only allowed when " +
      "voices.json lets it into every chat, since the file can go anywhere afterwards. The text gets " +
      "the same secret scan as a send.",
    inputSchema: {
      text: z.string().min(1).optional(),
      name: z.string().optional().describe("File name without extension: lowercase letters, digits, - or _"),
      voice: z.string().optional().describe("A macOS `say` voice name for the parts outside [voice] tags"),
      clone: z.string().optional().describe("A cloned voice for the parts outside [voice] tags"),
      lines: z
        .array(
          z.object({
            name: z.string(),
            text: z.string().min(1),
            clone: z.string().optional(),
            voice: z.string().optional(),
          }),
        )
        .max(40)
        .optional()
        .describe("Several lines in one call; each takes its own name, text and voice"),
      language: z.enum(["tr", "en", "de"]).optional(),
      rate: z.number().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ text, name, voice, clone, lines, language, rate }) => {
    const refuse = (why) => ({ isError: true, content: [{ type: "text", text: `Refused: ${why}.` }] });
    const jobs = lines ?? (text && name ? [{ name, text, voice, clone }] : null);
    if (!jobs?.length) return refuse("give `text` and `name`, or `lines`");
    // Every line is checked before any is rendered, so a bad one does not leave half a batch behind.
    for (const job of jobs) {
      if (!/^[a-z0-9_-]{1,40}$/.test(job.name))
        return refuse(`"${job.name}" must be lowercase letters, digits, - or _`);
      const secret = scanOutbound(job.text);
      if (secret) return refuse(`line "${job.name}": ${secret}`);
      const resolved = resolveFileVoices(job.text, job.clone);
      if (resolved.error) return refuse(`line "${job.name}": ${resolved.error}`);
      job.resolved = resolved;
    }
    if (new Set(jobs.map((j) => j.name)).size !== jobs.length) return refuse("two lines have the same name");
    mkdirSync(GENERATE_OUT_DIR, { recursive: true });
    const lang = language ?? "tr";
    const results = [];
    for (const job of jobs) {
      const out = join(GENERATE_OUT_DIR, `${job.name}.wav`);
      // The XTTS service only writes under the temp directory (its own guard), so the render happens
      // there and the finished file is copied into the outbox.
      const dir = mkdtempSync(join(tmpdir(), "wa-render-"));
      try {
        const tmp = join(dir, "out.wav");
        const report = await synthWav(
          spokenText(stripEmoji(job.text), lang),
          job.voice,
          rate ?? speakingRate(),
          lang,
          tmp,
          {
            clone: job.resolved.clone,
            voices: job.resolved.voices,
          },
        );
        // Never write through something that is not a plain file (a symlink planted in the outbox),
        // and only put the file in place once it is known to be readable audio.
        if (existsSync(out) && !lstatSync(out).isFile()) throw new Error(`${out} exists and is not a regular file`);
        const seconds = Number(
          execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp], {
            encoding: "utf8",
          }).trim(),
        );
        const part = `${out}.part`;
        copyFileSync(tmp, part);
        renameSync(part, out);
        const scores = report.map((r) => r.score).filter((x) => typeof x === "number");
        results.push({
          name: job.name,
          path: out,
          seconds,
          score: scores.length ? Math.round(Math.min(...scores) * 100) / 100 : null,
          takes: report.reduce((n, r) => n + r.takes, 0),
        });
      } catch (err) {
        results.push({ name: job.name, error: String(err.message ?? err) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const failed = results.filter((r) => r.error);
    return {
      ...(failed.length === results.length ? { isError: true } : {}),
      content: [{ type: "text", text: JSON.stringify(results, null, 1) }],
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
      ...TARGET_FIELDS,
      name: z.string().min(1).describe("The poll question"),
      values: z.array(z.string().min(1)).min(2).max(12).describe("2-12 options"),
      selectableCount: z.number().int().min(1).optional().describe("How many options one voter may pick (default 1)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, name, values, selectableCount }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    // guardCheck here, guardSend after the option checks below: a refused poll must not spend a slot.
    const refusal = guardCheck(to, name);
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
    const spend = guardSend(to, name);
    if (spend) return spend;
    const secret = randomBytes(32);
    const sock = getSocket();
    // Passed explicitly because Baileys treats an unset selectableCount as 0, which WhatsApp reads as
    // "any number of options". The documented default of 1 used to exist only in what was stored, so
    // every poll sent without a count was multi-select: a yes/no permission poll let both be ticked.
    const pickCount = selectableCount ?? 1;
    const sent = await sendWithQuote(sock, to, reply_to, {
      poll: { name, values, selectableCount: pickCount, messageSecret: secret },
    });
    const messageId = sent?.key?.id ?? null;
    // Saved before anything else touches this poll: if a vote arrives before this line runs,
    // getStoredPollMessage still has the secret to answer with.
    //
    // The send above has already happened by this point, so a failure here is not a refusal —
    // it is a poll that exists on WhatsApp with votes nobody can ever read, and the caller has to
    // be told that plainly rather than shown a generic error that implies nothing went out.
    if (messageId) {
      try {
        savePoll(to, messageId, { name, values, selectableCount: pickCount, secret });
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
    // The poll must belong to the chat that was named: otherwise naming any allowlisted chat would
    // read another chat's question, options and who voted for what.
    if (allowedJid(entry.jid) !== allowedJid(jid)) {
      return { isError: true, content: [{ type: "text", text: `Refused: poll ${messageId} is not in ${jid}.` }] };
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

// A person's "About" text and profile picture (owner decision, 2026-10-15), for chats on the allowlist
// only. Both are the person's own public-facing content, but fetching them is a request to WhatsApp, so
// answers are cached for five minutes and a hidden or missing picture is reported rather than retried.
// The picture lands in state/media, the inbound folder: it is never a send source, so it cannot be
// forwarded to another chat without being copied somewhere on purpose.
export function parseAbout(res) {
  const first = Array.isArray(res) ? res[0] : res;
  const st = first?.status;
  const text = typeof st === "string" ? st : st?.status;
  const setAt = typeof st === "object" && st ? st.setAt : first?.setAt;
  const when = setAt ? new Date(setAt) : null;
  return {
    about: typeof text === "string" && text.trim() ? text : null,
    setAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
  };
}

const PROFILE_HOST = /(^|\.)(whatsapp\.net|fbcdn\.net)$/;
const profileCache = new Map();
const PROFILE_TTL_MS = 5 * 60_000;

async function fetchProfilePicture(sock, jid) {
  const url = await sock.profilePictureUrl(jid, "image");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !PROFILE_HOST.test(parsed.hostname)) {
    throw new Error("the picture is not on a WhatsApp host, not fetching it");
  }
  const res = await fetch(parsed, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!res.ok) throw new Error(`picture download returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) throw new Error("the picture is empty or too large");
  const file = join(MEDIA_DIR, `profile-${jid.split("@")[0].split(":")[0]}.jpg`);
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

server.registerTool(
  "wa_profile",
  {
    title: "A person's About text and profile picture",
    description:
      "Fetch the About text (and when it was set) and the profile picture of an allowlisted chat: a person's " +
      "or a group's picture, a person's About. The picture is saved under state/media and its path is " +
      "returned, so it can be read; it is never a send source. A hidden picture or empty About comes back " +
      "as null, which is normal. Cached for five minutes.",
    inputSchema: { jid: z.string().describe("An allowlisted chat JID, person or group") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ jid }) => {
    if (!allowedJid(jid)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Refused: ${jid} is not on the allowlist (state/config.json).` }],
      };
    }
    const { live, lastError } = connectionState();
    if (!live) {
      return {
        isError: true,
        content: [{ type: "text", text: `Not connected to WhatsApp: ${lastError ?? "still connecting"}.` }],
      };
    }
    const cached = profileCache.get(jid);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
      return { content: [{ type: "text", text: JSON.stringify(cached.value, null, 2) }] };
    }
    const sock = getSocket();
    const value = { jid };
    if (!jid.endsWith("@g.us")) {
      try {
        value.about = parseAbout(await sock.fetchStatus(jid));
      } catch (err) {
        value.about = { error: String(err?.message ?? err) };
      }
    }
    try {
      value.picture = await fetchProfilePicture(sock, jid);
    } catch (err) {
      value.picture = null;
      value.pictureNote = String(err?.message ?? err);
    }
    profileCache.set(jid, { at: Date.now(), value });
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
    title: "Scheduled work and reminders",
    description:
      "List, add, update or remove recurring tasks and one-off reminders (`once`) that the SERVER fires, not the session — they " +
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
      at: z
        .string()
        .optional()
        .describe('Daily task: local 24-hour time, "HH:MM", e.g. "10:03". Give this or `once` for set.'),
      once: z
        .string()
        .optional()
        .describe(
          'One-off reminder: local date and time, "YYYY-MM-DDTHH:MM", e.g. "2026-10-23T18:00". It fires once and ' +
            "switches itself off after it is acknowledged. Put the target chat's full id in the prompt.",
        ),
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
  async ({ action, id, at, once, days, prompt, enabled, catchUpMinutes }) => {
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
      // Whichever kind is given replaces the other, so an edited task cannot end up with both.
      ...(once === undefined ? { at, once: undefined } : { once, at: undefined }),
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
  "wa_schedule_ack",
  {
    title: "Acknowledge a scheduled task",
    description:
      "Tell the server a woken session has picked up a scheduled task, so it stops writing the wake line " +
      "again every 20 minutes. Call it first thing when a `⏰ <id>` line arrives, before doing the work. " +
      "It changes nothing else.",
    inputSchema: { id: z.string().describe("Task id from the ⏰ line, e.g. 'daily-digest'") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => ({
    content: [{ type: "text", text: ackTask(id) ? `Acknowledged ${id}.` : `No task with id ${id}.` }],
  }),
);

server.registerTool(
  "wa_send_text_only",
  {
    title: "Send a WhatsApp text message (bypassing voice-only mode)",
    description:
      "Send plain text to a voice-only chat without converting it to a voice note. Useful for sharing " +
      "structured information (URLs, metadata, transcripts) where text is clearer than spoken audio.",
    inputSchema: {
      ...TARGET_FIELDS,
      mention: z
        .array(z.string())
        .max(2)
        .optional()
        .describe(
          "Groups only. Names, as shown in the chat, of up to two people to tag. Write @Name in the text where the tag goes. People who have not written in this chat are refused, so are bots and everyone-style tags.",
        ),
      text: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, text, reply_to, unprompted, mention }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const refusal = guardSend(to, text);
    if (refusal) return refusal;
    const sock = getSocket();
    const { sentCount, refusal: partRefusal } = await sendTextParts(sock, to, text, reply_to, mention);
    if (partRefusal) {
      return {
        ...partRefusal,
        content: [
          { type: "text", text: `Sent ${sentCount} part(s) to ${to}, then stopped: ${partRefusal.content[0].text}` },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Sent text to ${to}${sentCount > 1 ? ` (${sentCount} messages)` : ""} (bypassed voice-only).`,
        },
      ],
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
      ...TARGET_FIELDS,
      path: z.string().describe("Path to the .webp sticker, normally state/stickers/<name>.webp"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, path }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const refusal = guardCheck(to);
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
    const spend = guardSend(to);
    if (spend) return spend;
    const sent = await sendWithQuote(getSocket(), to, reply_to, { sticker: buffer });
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
      ...TARGET_FIELDS,
      path: z.string().describe("Absolute local path to the video file (mp4/mkv/mov etc.)"),
      caption: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, path, caption }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const refusal = guardCheck(to, caption);
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
    const spend = guardSend(to, caption);
    if (spend) return spend;
    const sent = await sendWithQuote(sock, to, reply_to, {
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

// Documents are an allowlist of extensions, not "anything in a sendable dir": an unknown extension is
// more likely a stray artefact (a .db, a .pem, a log) than something meant for a chat. The file is read
// ONCE and the same buffer is both scanned and sent, so nothing can change between the scan and the
// send. Every format is scanned: plain text directly, pdf by inflating its streams, office files by
// inflating their zip entries (see doc-scan.mjs).
export const DOCUMENT_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
};
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

// Returns { mimetype } for an allowed document path, or { error }. Cheap checks only, the content is
// read and scanned by the caller.
export function documentInfo(real) {
  const ext = extname(real).toLowerCase();
  const mimetype = DOCUMENT_TYPES[ext];
  if (!mimetype) {
    return {
      error: `${ext || "a file with no extension"} is not an allowed document type (${Object.keys(DOCUMENT_TYPES).join(", ")})`,
    };
  }
  if (statSync(real).size > MAX_DOCUMENT_BYTES) return { error: "file exceeds 50 MB" };
  return { mimetype };
}

// Secret-scans a document's content. Returns a refusal reason, or null when it is clean.
export function scanDocument(buffer, ext) {
  let texts;
  try {
    texts = documentScanTexts(buffer, ext);
  } catch (err) {
    // Fails closed: a document the scanner cannot read in full is not sent.
    if (err instanceof DocumentScanError) return `it could not be scanned (${err.message})`;
    throw err;
  }
  for (const text of texts) {
    const reason = scanOutbound(text);
    if (reason) return reason;
  }
  return null;
}

server.registerTool(
  "wa_send_document",
  {
    title: "Send a WhatsApp document",
    description:
      "Send a document (pdf, docx, xlsx, pptx, csv, txt, md) from a local file path to an allowlisted " +
      "WhatsApp JID, with an optional caption. Same source rule as images: only state/memes, state/stickers, " +
      "state/outbox and the session scratchpad's outbox/ folder, never state/media. The content is secret-scanned before " +
      "sending. Refuses anything not in state/config.json's allowlist.",
    inputSchema: {
      ...TARGET_FIELDS,
      path: z.string().describe("Absolute local path to the document"),
      caption: z.string().optional(),
      fileName: z
        .string()
        .optional()
        .describe("Name shown in the chat, defaults to the file's own name. Its extension must match the file."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, path, caption, fileName, reply_to, unprompted }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    // Everything that can refuse runs before guardSend, which is the step that spends a rate-limit slot.
    const check = guardCheck(to, [caption, fileName].filter(Boolean).join("\n") || undefined);
    if (check) return check;
    const { real, error: pathError } = resolveSendable(path);
    if (pathError) return { isError: true, content: [{ type: "text", text: `Refused: ${pathError}.` }] };
    let info;
    let buffer;
    try {
      info = documentInfo(real);
      if (info.error) return { isError: true, content: [{ type: "text", text: `Refused: ${info.error}.` }] };
      buffer = readFileSync(real);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Could not read ${path}: ${err}` }] };
    }
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      return { isError: true, content: [{ type: "text", text: "Refused: file exceeds 50 MB." }] };
    }
    const ext = extname(real).toLowerCase();
    const leak = scanDocument(buffer, ext);
    if (leak) {
      notify("warning", `wa_send_document refused: ${basename(real)} matched the secret scan (${leak})`);
      return { isError: true, content: [{ type: "text", text: `Refused: ${basename(real)}, ${leak}.` }] };
    }
    const name = basename(fileName ?? real);
    if (extname(name).toLowerCase() !== ext) {
      return {
        isError: true,
        content: [{ type: "text", text: "Refused: fileName must keep the file's real extension." }],
      };
    }
    const refusal = guardSend(to, [caption, fileName].filter(Boolean).join("\n") || undefined);
    if (refusal) return refusal;
    const sock = getSocket();
    const fullCaption = (caption ?? "") + ATTRIBUTION;
    const sent = await sendWithQuote(sock, to, reply_to, {
      document: buffer,
      mimetype: info.mimetype,
      fileName: name,
      caption: fullCaption,
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: fullCaption,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent document ${name} to ${to}.` }] };
  },
);

server.registerTool(
  "wa_memory",
  {
    title: "Remember things about a chat and its people",
    description:
      "Keep short notes about people and a chat (preferences, facts, running jokes) so later replies can use " +
      "them. Every note belongs to ONE chat: list and forget only ever see that chat's notes, so what is known " +
      "in one chat never surfaces in another. Never store secrets, health or money details, or anything a person " +
      "said in confidence. The owner can see them with /memory and drop one with /forget N.",
    inputSchema: {
      action: z.enum(["add", "list", "forget"]),
      jid: z.string().describe("The allowlisted chat the note belongs to"),
      about: z.string().optional().describe("The person it is about, as named in that chat; omit for the chat itself"),
      text: z.string().optional().describe("add: the note, one short sentence"),
      id: z.number().int().positive().optional().describe("forget: the note's number from list"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ action, jid, about, text, id }) => {
    const chat = allowedJid(jid);
    if (!chat) return refused(`${jid} is not on the allowlist.`);
    if (action === "list") {
      return { content: [{ type: "text", text: formatMemories(listMemories(chat, about)) }] };
    }
    if (action === "forget") {
      if (!id) return refused("forget needs the note's id.");
      return {
        content: [{ type: "text", text: forgetMemory(chat, id) ? `Forgot #${id}.` : `No note #${id} in ${chat}.` }],
      };
    }
    if (!text) return refused("add needs text.");
    const leak = scanOutbound(text);
    if (leak) return refused(`not storing that, ${leak}.`);
    const result = addMemory(chat, about, text);
    if (result.error) return refused(`${result.error}.`);
    return {
      content: [
        { type: "text", text: result.duplicate ? `Already known as #${result.id}.` : `Remembered as #${result.id}.` },
      ],
    };
  },
);

server.registerTool(
  "wa_receipts",
  {
    title: "Did they see it?",
    description:
      "Delivery and read receipts for a message this account sent: in a DM delivered/read/played, in a group " +
      "who read it. Receipts only come from people who have read receipts switched on, so a missing 'read' does " +
      "not prove a message was not read. This server never sends read receipts itself.",
    inputSchema: {
      jid: z.string().describe("The allowlisted chat"),
      messageId: z.string().describe("The id of a message this account sent (from wa_recent)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ jid, messageId }) => {
    const chat = allowedJid(jid);
    if (!chat) return refused(`${jid} is not on the allowlist.`);
    const row = findMessage(chat, messageId);
    if (!row) return refused(`message ${messageId} is not in ${chat}'s log.`);
    if (row.direction !== "out") return refused("receipts only exist for messages this account sent.");
    const rows = receiptsFor(chat, messageId);
    const text = rows.length ? JSON.stringify(rows, null, 2) : "no receipt yet (not delivered, or receipts are off)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "wa_send_location",
  {
    title: "Send a WhatsApp location pin",
    description: "Send a map pin (latitude/longitude, optional place name and address) to an allowlisted chat.",
    inputSchema: {
      ...TARGET_FIELDS,
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().max(120).optional().describe("Place name shown on the pin"),
      address: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, latitude, longitude, name, address }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const label = [name, address].filter(Boolean).join(" — ");
    const refusal = guardSend(to, label || undefined);
    if (refusal) return refusal;
    const sent = await sendWithQuote(getSocket(), to, reply_to, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
      },
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: `[location] ${label ? `${label} ` : ""}(${latitude}, ${longitude})`,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent location to ${to}.` }] };
  },
);

// A contact card hands a phone number to everyone in the chat, so only numbers already known to that
// chat can be shared: someone who has written there, or the owner. Never a number from another chat.
export function contactAllowed(chat, digits, ownJid, participants) {
  if (digits === String(ownJid ?? "").split(/[@:]/)[0]) return true;
  // In a DM the other person is the chat itself.
  if (!chat.endsWith("@g.us") && digits === chat.split("@")[0]) return true;
  return participants.some((p) => p.who !== "(you)" && String(p.who).split("@")[0] === digits);
}

export function vcardFor(name, digits) {
  const safe = String(name)
    .replace(/[\r\n;]/g, " ")
    .trim();
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${safe}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
}

server.registerTool(
  "wa_send_contact",
  {
    title: "Send a WhatsApp contact card",
    description:
      "Send a tappable contact card. Only for a number already known to the target chat (someone who has " +
      "written there, or the owner), so a number from another chat can never be passed on.",
    inputSchema: {
      ...TARGET_FIELDS,
      name: z.string().min(1).max(80).describe("Name shown on the card"),
      phone: z.string().describe("The number with country code, digits only or with + and spaces"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to: toArg, reply_to, unprompted, name, phone }) => {
    const { target: to, error } = targetFor({ to: toArg, reply_to, unprompted });
    if (error) return error;
    const digits = String(phone).replace(/\D/g, "");
    if (!/^\d{7,15}$/.test(digits)) return refused("that is not a phone number with a country code.");
    const check = guardCheck(to, name);
    if (check) return check;
    if (!contactAllowed(to, digits, getSocket()?.user?.id, participantStats(to).participants)) {
      return refused("that number has not written in this chat, so it is not shared here.");
    }
    const refusal = guardSend(to, name);
    if (refusal) return refusal;
    const sent = await sendWithQuote(getSocket(), to, reply_to, {
      contacts: { displayName: name, contacts: [{ vcard: vcardFor(name, digits) }] },
    });
    appendMessage(to, {
      direction: "out",
      by: "claude",
      text: `[contact] ${name} +${digits}`,
      ts: Date.now(),
      id: sent?.key?.id ?? null,
    });
    return { content: [{ type: "text", text: `Sent contact card for ${name} to ${to}.` }] };
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
        onReceipt: handleReceipt,
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
  replayPendingWake();
  // Started here rather than next to the tool registrations so importing this file for tests does
  // not start a timer, same reason the socket is behind this guard.
  //
  seedLiveChats();
  // The line goes to inbox.log, not queueWake: a scheduled task belongs to no chat, and it must not
  // sit behind the presence debounce waiting for someone to stop typing.
  startScheduler({
    onDue: (task) => {
      for (const jid of jidsIn(task.prompt)) markLive(jid);
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
    onReceipt: handleReceipt,
    getMessage: getStoredPollMessage,
  }).catch((err) => {
    process.stderr.write(`whatsapp-mcp-personal: startup failed: ${err}\n`);
  });

  if (process.env.WA_TRANSPORT === "socket") {
    // Run by src/daemon.mjs: the process outlives any one client, which connects through
    // src/shim.mjs. stderr only, stdout belongs to nothing here but is kept clean on principle.
    await serveOnSocket(server, {
      path: DAEMON_SOCK_PATH,
      token: loadOrCreateDaemonToken(DAEMON_TOKEN_PATH),
      log: (line) => process.stderr.write(`whatsapp-mcp daemon: ${line}\n`),
      // A line in the wake feed, so the session that was displaced (or the owner reading the log) sees it.
      onReplace: () =>
        logInbox("(daemon)", "client replaced", "a new authenticated client took over the daemon connection"),
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
