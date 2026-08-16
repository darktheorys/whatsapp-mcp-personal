import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const STATE_DIR = join(ROOT, "state");
export const AUTH_DIR = join(STATE_DIR, "auth");
export const MEDIA_DIR = join(STATE_DIR, "media");
export const MEMES_DIR = join(STATE_DIR, "memes");
// Scratch space for raw yt-dlp/ffmpeg output (sidecars, intermediate formats, anything a
// title-with-slashes trick might spray around) -- never a sendable source, never indexed. Keeps
// that debris out of both the repo root and state/memes/ (the sendable, indexed directory).
export const TMP_DIR = join(STATE_DIR, "tmp");
// Overridable so the allowlist test can run against a throwaway config instead of your real one.
export const CONFIG_PATH = process.env.WA_CONFIG_PATH ?? join(STATE_DIR, "config.json");
export const LOG_PATH = join(STATE_DIR, "baileys.log");

export function ensureDirs() {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  // A sendable directory that never exists is a send tool that always fails: state/memes is
  // gitignored, so on a fresh clone every wa_send_image died on it before resolveSendable could
  // even judge the path.
  mkdirSync(MEMES_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
}

// The Turkish Piper voice phonemizes text with a Turkish letter-to-sound frontend (espeak-ng), so
// an English tech word embedded in Turkish gets read with Turkish spelling rules applied to
// English spelling ("harness" -> letter-by-letter Turkish, not the English word). There is no
// SSML/language-tagging in Piper's VITS pipeline to mark a substring as English, so the fix is a
// substitution dictionary: respell each loanword phonetically in Turkish orthography before
// synthesis (see respellLoanwords in server.mjs), so the *same* Turkish phonemizer produces
// roughly the right sound. Lives in config, not code, so it can grow from conversation without a
// deploy — hand-edit state/config.json's loanword_respellings, or extend this seed default.
//
// Plural/longer entries listed before their shorter prefix: respellLoanwords's regex alternation
// matches the first alternative that fits at a position, not the longest, so "tokens" must be
// tried before "token" or it would never be reached ("token" would already match and consume it).
function defaultLoanwordRespellings() {
  return {
    tokens: "tokenler",
    token: "token",
    plugins: "plaginlar",
    plugin: "plagin",
    features: "fiçırlar",
    feature: "fiiçır",
    harness: "härnıs",
    loop: "luup",
    agent: "eycınt",
    subagent: "sabeycınt",
    stream: "sıtreem",
    session: "sesşın",
    frameworks: "freymvörkler",
    framework: "freymvörk",
    workflow: "vörkflov",
    reasoning: "rizınink",
    contexts: "kontekstler",
    context: "kontekst",
    replay: "ripley",
    resume: "rizyum",
    retrieval: "ritrivıl",
    transcript: "transkript",
    telemetry: "telemetri",
    persistence: "pörsistıns",
    config: "konfig",
    pipeline: "payplayn",
    deploy: "diploy",
    commit: "kommit",
    branch: "bırenç",
    merge: "mörc",
    push: "puş",
    checkout: "çekaut",
    repository: "ripozitori",
    webhook: "vebhuk",
    cache: "keş",
    thread: "tıred",
    backend: "bekend",
    frontend: "frontend",
    database: "databeyz",
    endpoint: "endpoynt",
    schema: "skima",
    render: "rendır",
    buffer: "baffır",
    queue: "kuğ",
    socket: "soket",
    sandbox: "sendbaks",
    library: "laybreri",
    exception: "eksepşın",
    debug: "dibag",
    upgrade: "apgreyd",
    deepseek: "diipsik",
    claude: "kılaudi",
    anthropic: "antıropik",
    openai: "openeyay",
    ai: "eyay",
  };
}

// state/config.json is plain JSON -- no comment syntax, and every setter below does a full
// read-modify-write of the file, so any hand-added "// comment"-style text or a "_comment" key
// would just get silently dropped the next time any single setting changes (e.g. the next
// /language command in any chat). This function is the durable place for what each field means --
// read it here, not by asking someone to annotate the JSON file itself.
function defaultConfig() {
  return {
    // JIDs allowed to be read from or written to at all -- the single gate every inbound/outbound
    // path checks (allowedJid). Anything not here is invisible in both directions.
    allowlist: [],
    // Opt-*out* lists (see hasImageDisabled/hasVoiceDisabled): a chat in here still gets its
    // caption/transcript logged, only the media file itself isn't downloaded/transcribed.
    no_image_jids: [],
    no_voice_jids: [],
    // "/wakelevel mention-only" chats: only a message containing "@claude" wakes the session via
    // state/inbox.log -- everything is still logged either way, only the wake trigger is gated.
    mention_only_jids: [],
    // "/speaking voice-only" chats: every reply wa_send sends to this chat auto-routes through TTS
    // and goes out as a voice note instead of text.
    voice_only_jids: [],
    // Display name for the owner's own messages in logs/prompts -- not currently exposed via any
    // in-chat command, hand-edit if it needs to change.
    owner_name: "Me",
    // "/speaking-speed N" -- global TTS speed multiplier for outgoing voice notes (1.0 = each
    // engine's native pace, >1 faster, <1 slower). Not per-chat: there's no per-chat use case for
    // it the way there is for wake level or voice mode.
    speaking_rate: 1.15,
    // "/s2t-tier low|mid|high" -- global whisper.cpp model tier for transcribing *incoming* voice
    // notes (low=ggml-small.bin, mid=ggml-medium.bin, high=ggml-large-v3-turbo.bin -- see
    // S2T_MODELS below). Global because transcription quality doesn't vary by who's speaking.
    s2t_tier: "low",
    // "/t2s-tier low|mid|high" -- global Piper voice quality tier for *outgoing* voice notes.
    // Decoupled from s2t_tier on purpose: wanting a fast transcript and a good-sounding reply are
    // independent preferences (see PIPER_VOICES below for what each tier maps to per language).
    t2s_tier: "low",
    // "/language tr|en" per chat: which Piper voice (PIPER_VOICES[lang][t2s_tier]) this chat's
    // *outgoing* voice notes default to. Opt-in, not opt-out -- almost every allowlisted chat is
    // Turkish, so this list only needs to name the English exception. Incoming voice notes are
    // unaffected either way (whisper runs with "-l auto", adapting per clip automatically).
    english_jids: [],
    // word -> Turkish-orthography respelling, so Piper's Turkish phonemizer reads an embedded
    // English/tech word roughly correctly instead of applying Turkish letter-to-sound rules to
    // English spelling (see respellLoanwords in server.mjs). No in-chat command yet -- extend by
    // hand-editing this map directly, or via config.mjs's setLoanwordRespelling().
    loanword_respellings: defaultLoanwordRespellings(),
    // "/verbosity low|mid|high" per chat: how much detail/length Claude's own replies to *that*
    // chat carry -- not a mechanical truncation enforced in code, just what verbosity(jid) reads
    // back for Claude to self-regulate reply length/detail by. Defaults to "low" for any chat
    // absent from this map (a WhatsApp reply is a chat message, not a report).
    verbosity_jids: {},
    // "/incognito on|off" per chat: while on, this chat leaves no trace at all -- no
    // state/messages.db row, no state/media/ download, no contacts.json update, and no wake via
    // state/inbox.log (overriding mention_only_jids/wakelevel entirely -- not even "@claude"
    // wakes a session while incognito is on). See isIncognito()/setIncognito() below and the
    // early-return in handleIncoming (server.mjs) that this gates.
    incognito_jids: [],
  };
}

// "/verbosity low|mid|high", per chat like /language -- how much explanation/detail Claude's own
// replies to *that chat* carry. Not a mechanical truncation enforced anywhere in this file: this
// only ever changes what verbosity(jid) reads back, so Claude can self-regulate reply length/detail
// per chat at reply time. "low" is the default for any chat not in the map -- a WhatsApp reply is a
// chat message, not a report.
export const VERBOSITY_LEVELS = ["low", "mid", "high"];

// Whisper model per tier. All three are the same whisper.cpp binary and flags — only the file
// differs — so switching is a config change, not a code path. `large-v3-turbo` is both the most
// accurate and faster than `medium`, which is why there is no tier above it here.
export const S2T_MODELS = {
  low: "ggml-small.bin",
  mid: "ggml-medium.bin",
  high: "ggml-large-v3-turbo.bin",
};

// Piper voice file per language per t2s tier. Both languages currently map every tier to the
// same single file: Turkish has exactly one voice on huggingface.co/rhasspy/piper-voices
// (dfki-medium — the others were pulled at the contributors' request), and English uses
// hfc_male-medium (a male voice — the alternative "lessac" voice is female and does have real
// low/medium/high variants, but hfc_male only ships a "medium" tier). /t2s-tier still switches
// the setting either way; on English it just has nothing to bite on right now.
export const PIPER_VOICES = {
  tr: {
    low: "tr_TR-dfki-medium.onnx",
    mid: "tr_TR-dfki-medium.onnx",
    high: "tr_TR-dfki-medium.onnx",
  },
  en: {
    low: "en_US-hfc_male-medium.onnx",
    mid: "en_US-hfc_male-medium.onnx",
    high: "en_US-hfc_male-medium.onnx",
  },
};

export function loadConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), {
      mode: 0o600,
    });
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist : [],
    no_image_jids: Array.isArray(raw.no_image_jids) ? raw.no_image_jids : [],
    no_voice_jids: Array.isArray(raw.no_voice_jids) ? raw.no_voice_jids : [],
    mention_only_jids: Array.isArray(raw.mention_only_jids) ? raw.mention_only_jids : [],
    voice_only_jids: Array.isArray(raw.voice_only_jids) ? raw.voice_only_jids : [],
    owner_name: typeof raw.owner_name === "string" ? raw.owner_name : "Me",
    speaking_rate: typeof raw.speaking_rate === "number" ? raw.speaking_rate : 1.15,
    // An unknown tier falls back to "low" rather than throwing: a typo in a hand-edited config
    // should degrade transcription, not stop every voice note from being transcribed at all.
    // Object.hasOwn, not `in`: `in` walks the prototype, so a hand-edited "constructor" passed
    // this guard and then threw inside whisperModel() — the exact break the fallback exists to stop.
    s2t_tier: Object.hasOwn(S2T_MODELS, raw.s2t_tier ?? "") ? raw.s2t_tier : "low",
    t2s_tier: Object.hasOwn(S2T_MODELS, raw.t2s_tier ?? "") ? raw.t2s_tier : "low",
    english_jids: Array.isArray(raw.english_jids) ? raw.english_jids : [],
    // Backfills the seed dictionary for configs written before this field existed, rather than
    // silently going empty (no respelling at all, back to raw Turkish-phonemized English) the
    // first time an install upgrades.
    loanword_respellings:
      raw.loanword_respellings && typeof raw.loanword_respellings === "object"
        ? raw.loanword_respellings
        : defaultLoanwordRespellings(),
    // A hand-edited or stale entry falls back to "low" per-jid rather than throwing, same
    // rationale as s2t_tier/t2s_tier above -- one bad value shouldn't break every chat's status.
    verbosity_jids: raw.verbosity_jids && typeof raw.verbosity_jids === "object" ? raw.verbosity_jids : {},
    incognito_jids: Array.isArray(raw.incognito_jids) ? raw.incognito_jids : [],
  };
}

// "/verbosity low|mid|high" reply for one chat -- how much explanation/detail Claude's own
// replies to *that* chat carry. Defaults to "low" for any chat not in the map.
export function verbosity(jid) {
  const level = loadConfig().verbosity_jids[jid];
  return VERBOSITY_LEVELS.includes(level) ? level : "low";
}

// "/incognito on|off" per chat. While on: no message row, no media download, no contact update,
// no wake -- see the comment on incognito_jids in defaultConfig() above for the full list, and
// the early-return in handleIncoming (server.mjs) that actually enforces it.
export function isIncognito(jid) {
  return loadConfig().incognito_jids.includes(jid);
}

export function setIncognito(jid, on) {
  const cfg = loadConfig();
  cfg.incognito_jids = on ? [...new Set([...cfg.incognito_jids, jid])] : cfg.incognito_jids.filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function setVerbosity(jid, level) {
  const cfg = loadConfig();
  cfg.verbosity_jids = { ...cfg.verbosity_jids, [jid]: level };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Read fresh each call (not cached) so a hand-edit to state/config.json's loanword_respellings
// takes effect on the next voice note without a server restart.
export function loanwordRespellings() {
  return loadConfig().loanword_respellings;
}

// No in-chat command wired to this yet -- extend via editing state/config.json directly, or call
// this from a future "/loanword <word> <respelling>" command if that turns out to be wanted.
export function setLoanwordRespelling(word, respelling) {
  const cfg = loadConfig();
  cfg.loanword_respellings = {
    ...cfg.loanword_respellings,
    [word.toLowerCase()]: respelling,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// "/s2t-tier low|mid|high" picks the whisper model used for incoming voice notes. Global, like
// speaking_rate — the transcription quality you want doesn't vary by who is talking.
export function s2tTier() {
  return loadConfig().s2t_tier;
}

export function setS2tTier(tier) {
  const cfg = loadConfig();
  cfg.s2t_tier = tier;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// "/t2s low|mid|high" picks the Piper voice quality for outgoing voice notes. Separate from
// s2t_tier on purpose: STT accuracy and TTS voice quality are different things to want different
// levels of, and they use different model files (whisper vs. Piper).
export function t2sTier() {
  return loadConfig().t2s_tier;
}

export function setT2sTier(tier) {
  const cfg = loadConfig();
  cfg.t2s_tier = tier;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// "/language tr|en" per chat: which Piper voice (via PIPER_VOICES[lang][t2s_tier]) that chat's
// outgoing voice notes default to. Opt-in like voice_only_jids, not opt-out like no_image_jids —
// almost every allowlisted chat is Turkish, so "not in this list" should mean the common case.
// Incoming voice notes deliberately don't use this: whisper is run with "-l auto" (see
// transcribeVoice in server.mjs) so STT adapts per clip regardless of who's texting.
// A per-call override still exists (wa_send_voice's `language` param) for the case Claude is
// replying in a different language than the chat's usual one for that one message.
export function isEnglish(jid) {
  return loadConfig().english_jids.includes(jid);
}

export function setEnglish(jid, on) {
  const cfg = loadConfig();
  cfg.english_jids = on ? [...new Set([...cfg.english_jids, jid])] : cfg.english_jids.filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function ownerName() {
  return loadConfig().owner_name;
}

// "/speaking-speed 1.15" sets the default TTS speed multiplier (1.0 = each engine's native pace).
// Global, not per-chat — there's no per-chat use case for this the way there is for wake level or
// voice-only mode.
export function speakingRate() {
  return loadConfig().speaking_rate;
}

export function setSpeakingRate(rate) {
  const cfg = loadConfig();
  cfg.speaking_rate = rate;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Returns the allowlisted JID that matched, or undefined. Callers use it as a boolean guard and
// as the canonical storage key, so a chat logs under one filename no matter which of its
// addresses a given message happened to arrive on.
//
// WhatsApp addresses the same person two ways: the phone-number JID (`4917...@s.whatsapp.net`)
// and the privacy-preserving LID (`1234...@lid`). Which one lands in `key.remoteJid` is not
// ours to choose, so every candidate form gets checked against the allowlist.
export function allowedJid(...jids) {
  const { allowlist } = loadConfig();
  return jids.find((jid) => jid && allowlist.includes(jid));
}

// "/ai off" removes a chat from the allowlist entirely -- unlike every other per-chat setting
// above, there is deliberately no "/ai on" to re-add it (Burak, 2026-08-17: "/ai on will not
// exists apparently, but thats is ok for now"). Re-adding means hand-editing state/config.json's
// allowlist, same as bringing in a brand new chat -- see README's Setup section. This is a one-way
// door on purpose: once a chat opts out, getting back in takes deliberate action outside the chat.
export function removeFromAllowlist(jid) {
  const cfg = loadConfig();
  cfg.allowlist = cfg.allowlist.filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function hasImageDisabled(jid) {
  const { no_image_jids } = loadConfig();
  return no_image_jids.includes(jid);
}

// Separate from no_image_jids on purpose: that one is about not keeping pictures, this one is
// about not keeping (or transcribing) speech. A chat can reasonably want either without the
// other, and voice is the one whose audio carries the only copy of the words.
export function hasVoiceDisabled(jid) {
  const { no_voice_jids } = loadConfig();
  return no_voice_jids.includes(jid);
}

// Both lists are opt-*out*, so the in-chat commands read the friendlier way round:
// "/read-image yes" means downloads are on, i.e. the chat is absent from no_image_jids.
function setListed(key, jid, listed) {
  const cfg = loadConfig();
  cfg[key] = listed ? [...new Set([...cfg[key], jid])] : cfg[key].filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export const setImageEnabled = (jid, on) => setListed("no_image_jids", jid, !on);
export const setVoiceEnabled = (jid, on) => setListed("no_voice_jids", jid, !on);

// "/wakelevel mention-only" for a chat: Claude only wakes for a message containing "@claude",
// instead of every inbound message. "/wakelevel verbose" is the default (not in this list).
export function isMentionOnly(jid) {
  const { mention_only_jids } = loadConfig();
  return mention_only_jids.includes(jid);
}

export function setMentionOnly(jid, on) {
  const cfg = loadConfig();
  cfg.mention_only_jids = on
    ? [...new Set([...cfg.mention_only_jids, jid])]
    : cfg.mention_only_jids.filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// "/speaking voice-only" for a chat: every outbound message to it goes out as a TTS voice note
// instead of text. "/speaking text-only" is the default (not in this list).
export function isVoiceOnly(jid) {
  const { voice_only_jids } = loadConfig();
  return voice_only_jids.includes(jid);
}

export function setVoiceOnly(jid, on) {
  const cfg = loadConfig();
  cfg.voice_only_jids = on ? [...new Set([...cfg.voice_only_jids, jid])] : cfg.voice_only_jids.filter((j) => j !== jid);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
