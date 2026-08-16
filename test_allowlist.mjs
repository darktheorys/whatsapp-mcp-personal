// Run: npm test
// Covers the one piece of logic here that can fail silently: which incoming messages the
// allowlist lets through, and which JID a chat gets stored under once it does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DM = "4917012345678@s.whatsapp.net";
const DM_LID = "112167902834798@lid";
const GROUP = "120363001234567890@g.us";

const cfg = join(mkdtempSync(join(tmpdir(), "wa-test-")), "config.json");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));
process.env.WA_CONFIG_PATH = cfg;

// Imported late: CONFIG_PATH is resolved at module load, so the env var must be set first.
const { allowedJid, hasImageDisabled, isMentionOnly } = await import("./src/config.mjs");

assert.equal(allowedJid(DM), DM, "phone-form DM should match");
assert.equal(allowedJid(GROUP), GROUP, "group should match");

// loadConfig() used to return only `{ allowlist }`, silently dropping every other key — so
// hasImageDisabled/isMentionOnly always read `undefined` and never actually gated anything.
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP], no_image_jids: [DM], mention_only_jids: [GROUP] }));
assert.equal(hasImageDisabled(DM), true, "no_image_jids should disable images for a listed jid");
assert.equal(hasImageDisabled(GROUP), false, "unlisted jid keeps images enabled");
assert.equal(isMentionOnly(GROUP), true, "mention_only_jids gates a listed jid");
assert.equal(isMentionOnly(DM), false, "unlisted jid stays verbose");

// Restore the plain allowlist-only config for the rest of the allowedJid assertions below.
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));

// The case that made messages vanish before: WhatsApp delivers the chat LID-first, and only
// `remoteJidAlt` carries the phone form the allowlist was written in.
assert.equal(allowedJid(DM_LID, DM), DM, "LID-addressed DM should match on its alt form");
assert.equal(allowedJid(DM_LID), undefined, "an unmapped LID alone is not a match");

assert.equal(allowedJid("4900000000000@s.whatsapp.net"), undefined, "stranger stays out");
assert.equal(allowedJid("120363999999999999@g.us"), undefined, "unlisted group stays out");
assert.equal(allowedJid(undefined, null), undefined, "missing JIDs must not throw");

// A throwaway database, so the store tests never touch the real message history.
process.env.WA_DB_PATH = join(mkdtempSync(join(tmpdir(), "wa-db-")), "test.db");

// WA_NO_CONNECT keeps the import from opening a WhatsApp socket and evicting the live server.
process.env.WA_NO_CONNECT = "1";
const { extractContent, mediaName } = await import("./src/server.mjs");

assert.deepEqual(extractContent({ conversation: "hi" }), { text: "hi" }, "plain text");
assert.equal(extractContent({ extendedTextMessage: { text: "quoted" } }).text, "quoted", "extended text");
assert.equal(extractContent(null), null, "empty payload");
assert.equal(extractContent({ videoMessage: {} }), null, "video stays out of scope");

// The caption is the part that has to survive even if the download later fails.
const img = extractContent({ imageMessage: { caption: "look", mimetype: "image/jpeg" } });
assert.equal(img.kind, "image");
assert.equal(img.text, "look");
assert.equal(
  extractContent({ imageMessage: { mimetype: "image/jpeg" } }).text,
  "",
  "caption-less media logs empty text, not null",
);

assert.equal(extractContent({ stickerMessage: { mimetype: "image/webp" } }).kind, "sticker", "stickers are kept");

assert.equal(mediaName({ mimetype: "image/jpeg" }, "ABC123"), "ABC123.jpeg", "extension from mimetype");
assert.equal(mediaName({ mimetype: "image/webp" }, "S1"), "S1.webp", "sticker keeps its webp extension");
assert.equal(
  mediaName({ fileName: "Q3 report.pdf" }, "ABC123"),
  "ABC123-Q3_report.pdf",
  "document keeps a sanitized filename",
);
assert.equal(mediaName({}, "A/B"), "A_B.bin", "unknown type and unsafe id both sanitized");

// The in-chat commands are gated on key.fromMe, so these regexes are a trust boundary: a loose
// one would let a group member's message reconfigure the bot for everyone.
// Imported, not copied: these used to be duplicate literals in this file, so loosening the real
// anchors in server.mjs left every assertion below still passing.
const { COMMANDS } = await import("./src/server.mjs");
const WAKELEVEL = COMMANDS.wakelevel;
const SPEAKING = COMMANDS.speaking;
const SPEED = COMMANDS.speakingSpeed;

assert.equal(WAKELEVEL.exec("/wakelevel mention-only")[1], "mention-only", "plain command matches");
assert.equal(WAKELEVEL.exec("/wakelevel  VERBOSE ")[1], "VERBOSE", "case and padding tolerated");
assert.equal(WAKELEVEL.exec(" /wakelevel verbose"), null, "leading text must not match");
assert.equal(WAKELEVEL.exec("x/wakelevel verbose"), null, "command must start the message");
assert.equal(WAKELEVEL.exec("/wakelevel verbose extra"), null, "trailing text must not match");
assert.equal(WAKELEVEL.exec("/wakelevel loud"), null, "unknown level rejected");
assert.equal(SPEAKING.exec("/speaking voice-only")[1], "voice-only", "speaking command matches");
assert.equal(SPEAKING.exec("please /speaking text-only"), null, "embedded command must not match");
assert.equal(SPEED.exec("/speaking-speed 1.15")[1], "1.15", "speed command captures its number");
assert.equal(SPEED.exec("/speaking-speed fast"), null, "non-numeric speed rejected");

const S2T_TIER = COMMANDS.s2tTier;
assert.equal(S2T_TIER.exec("/s2t-tier high")[1], "high", "tier command parses");
assert.equal(S2T_TIER.exec("/s2t-tier MID ")[1], "MID", "case and padding tolerated");
assert.equal(S2T_TIER.exec("/s2t-tier huge"), null, "unknown tier rejected");
assert.equal(S2T_TIER.exec("hey /s2t-tier low"), null, "embedded command must not match");

// A hand-edited typo in config.json must degrade to the default, not break transcription outright.
const { S2T_MODELS } = await import("./src/config.mjs");
assert.deepEqual(Object.keys(S2T_MODELS), ["low", "mid", "high"], "tiers stay in step with setup-voice.sh");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM], s2t_tier: "enormous" }));
const { s2tTier } = await import("./src/config.mjs");
assert.equal(s2tTier(), "low", "an unknown tier in config falls back to low");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));

const T2S_TIER = COMMANDS.t2sTier;
assert.equal(T2S_TIER.exec("/t2s-tier high")[1], "high", "t2s tier command parses");
assert.equal(T2S_TIER.exec("/t2s-tier MID ")[1], "MID", "case and padding tolerated");
assert.equal(T2S_TIER.exec("/t2s-tier huge"), null, "unknown tier rejected");
assert.equal(T2S_TIER.exec("hey /t2s-tier low"), null, "embedded command must not match");

const LANGUAGE = COMMANDS.language;
assert.equal(LANGUAGE.exec("/language en")[1], "en", "language command parses");
assert.equal(LANGUAGE.exec("/language TR ")[1], "TR", "case and padding tolerated");
assert.equal(LANGUAGE.exec("/language fr"), null, "unsupported language rejected");
assert.equal(LANGUAGE.exec("hey /language en"), null, "embedded command must not match");

// PIPER_VOICES must cover both languages at every s2t/t2s tier name.
const { PIPER_VOICES } = await import("./src/config.mjs");
assert.deepEqual(Object.keys(PIPER_VOICES).sort(), ["en", "tr"], "language has exactly tr and en");
for (const lang of Object.keys(PIPER_VOICES)) {
  assert.deepEqual(Object.keys(PIPER_VOICES[lang]), ["low", "mid", "high"], `${lang} covers all tiers`);
}

// language is per-chat (opt-in english_jids), not global — same isEnabled/setEnabled shape as
// voice_only_jids, and a hand-edited typo in t2s_tier must degrade to "low", not break TTS.
const { isEnglish, setEnglish, t2sTier } = await import("./src/config.mjs");
assert.equal(isEnglish(DM), false, "a chat not in english_jids defaults to Turkish");
setEnglish(DM, true);
assert.equal(isEnglish(DM), true, "/language en marks a chat english");
assert.equal(isEnglish(GROUP), false, "...without affecting other chats");
setEnglish(DM, false);
assert.equal(isEnglish(DM), false, "/language tr clears it again");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM], t2s_tier: "enormous" }));
assert.equal(t2sTier(), "low", "an unknown t2s tier in config falls back to low");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));

const MEDIA_CMD = COMMANDS.readMedia;
assert.deepEqual(MEDIA_CMD.exec("/read-image no").slice(1, 3), ["image", "no"], "image off parses");
assert.deepEqual(
  MEDIA_CMD.exec("/read-audio YES").slice(1, 3),
  ["audio", "YES"],
  "audio on parses, case-insensitively",
);
assert.equal(MEDIA_CMD.exec("/read-video yes"), null, "unknown media kind rejected");
assert.equal(MEDIA_CMD.exec("/read-image maybe"), null, "non-boolean rejected");
assert.equal(MEDIA_CMD.exec("hey /read-image no"), null, "embedded command must not match");

// A reply to an image is itself an imageMessage carrying contextInfo, so quoting has to be read
// off any node — not just extendedTextMessage — or replies to media lose their context.
const { extractQuoted } = await import("./src/server.mjs");
assert.equal(
  extractQuoted({ extendedTextMessage: { text: "ok", contextInfo: { quotedMessage: { conversation: "orig" } } } }).text,
  "orig",
  "quote read off a text reply",
);
assert.equal(
  extractQuoted({ imageMessage: { mimetype: "image/jpeg", contextInfo: { quotedMessage: { conversation: "orig" } } } })
    .text,
  "orig",
  "quote read off a media reply",
);
assert.equal(extractQuoted({ conversation: "no quote here" }), null, "unquoted message yields null");
assert.equal(extractQuoted(null), null, "empty payload must not throw");

// The send-side backstop: this is what still holds if the model is talked into assembling a
// message out of something it shouldn't have. A miss here is silent, so each shape gets a case.
const { scanOutbound, overSendLimit } = await import("./src/server.mjs");

assert.equal(scanOutbound("selam dayı, normal bir mesaj"), null, "ordinary text sends");
assert.equal(scanOutbound("look at state/media/x.jpg"), null, "a path mention is not a secret");
assert.match(scanOutbound("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb"), /private key/, "private key blocked");
assert.match(scanOutbound("key AKIAIOSFODNN7EXAMPLE here"), /AWS/, "AWS key id blocked");
assert.match(scanOutbound(`token ghp_${"a".repeat(36)}`), /GitHub/, "GitHub token blocked");
assert.match(scanOutbound(`xoxb-${"1".repeat(20)}`), /Slack/, "Slack token blocked");
assert.match(
  scanOutbound("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"),
  /JWT/,
  "JWT blocked",
);

// A reaction sent by wa_react used to be logged twice: once on send, once when WhatsApp echoed it
// back as an event. The echo is suppressed exactly once, and only for a matching own reaction.
const { noteOwnReaction, isEchoOfOwnReactionForTest } = await import("./src/server.mjs");
const RJID = "4917012345678@s.whatsapp.net";
noteOwnReaction(RJID, "MSG1", "😂");
assert.equal(isEchoOfOwnReactionForTest(RJID, "MSG1", "😂"), true, "the echo of our own reaction is suppressed");
assert.equal(isEchoOfOwnReactionForTest(RJID, "MSG1", "😂"), false, "only once — a second, real reaction still logs");
assert.equal(isEchoOfOwnReactionForTest(RJID, "MSG1", "👍"), false, "a different emoji is not our echo");
assert.equal(isEchoOfOwnReactionForTest(RJID, "MSG2", "😂"), false, "a different message is not our echo");

// state/media holds what other chats sent in, so it must never be a source for an outbound file —
// otherwise "forward that photo" crosses a chat boundary in one tool call.
const { resolveSendable } = await import("./src/server.mjs");
const { MEDIA_DIR, STATE_DIR } = await import("./src/config.mjs");
mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(join(STATE_DIR, "memes"), { recursive: true });
const inbound = join(MEDIA_DIR, "test-inbound.jpg");
const meme = join(STATE_DIR, "memes", "test-meme.jpg");
writeFileSync(inbound, "x");
writeFileSync(meme, "x");
try {
  assert.match(resolveSendable(inbound).error, /never a send source/, "state/media is refused as a source");
  assert.equal(resolveSendable(meme).error, undefined, "state/memes is sendable");
  assert.match(
    resolveSendable(join(STATE_DIR, "nope.jpg")).error,
    /does not exist/,
    "missing file says so, not 'forbidden'",
  );
  assert.match(resolveSendable("/etc/hosts").error, /outside the sendable/, "an arbitrary path is refused");
} finally {
  rmSync(inbound, { force: true });
  rmSync(meme, { force: true });
}

// wa_edit/wa_delete must not touch Burak's own phone-typed messages, which are `direction: "out"`
// exactly like Claude's — the `by` tag is the only thing separating them.
const { guardOwnMessage } = await import("./src/server.mjs");
const { appendMessage, readRecent, messageCount, searchMessages, archiveOldMessages, findMessage } =
  await import("./src/store.mjs");
const FAKE = "999999999999@s.whatsapp.net";
appendMessage(FAKE, { direction: "out", by: "claude", text: "sent by claude", ts: 1000, id: "CLAUDE1" });
appendMessage(FAKE, { direction: "out", text: "typed by burak on his phone", ts: 2000, id: "BURAK1" });
appendMessage(FAKE, { direction: "in", text: "from someone else", ts: 3000, id: "THEM1" });

assert.equal(guardOwnMessage(FAKE, "CLAUDE1").error, undefined, "Claude's own message is editable");
assert.match(guardOwnMessage(FAKE, "BURAK1").error.content[0].text, /not sent by Claude/, "Burak's own is refused");
assert.match(guardOwnMessage(FAKE, "THEM1").error.content[0].text, /not sent by Claude/, "an inbound one is refused");
assert.match(guardOwnMessage(FAKE, "NOSUCH").error.content[0].text, /not found/, "unknown id is refused");

// The store moved from append-only JSONL to SQLite, so these cover what the files used to give for
// free: ordering by time, the arbitrary-shaped entry surviving a round trip, and the active/archive
// split now being a flag rather than a second file.
assert.equal(messageCount(FAKE), 3, "count is per chat");
assert.deepEqual(
  readRecent(FAKE, 2).map((m) => m.id),
  ["BURAK1", "THEM1"],
  "readRecent returns the newest N, oldest first",
);
assert.equal(readRecent(FAKE, 1)[0].by, undefined, "entries without a `by` tag round-trip without gaining one");
assert.equal(findMessage(FAKE, "CLAUDE1").text, "sent by claude", "findMessage reads the stored entry back whole");
appendMessage(FAKE, {
  direction: "in",
  text: "with media",
  ts: 4000,
  id: "MEDIA1",
  media: { kind: "voice", path: "/x.ogg" },
});
assert.equal(findMessage(FAKE, "MEDIA1").media.kind, "voice", "nested media survives the round trip");

assert.deepEqual(
  searchMessages([FAKE], "SENT BY", 10).map((m) => m.id),
  ["CLAUDE1"],
  "search is case-insensitive substring",
);
assert.deepEqual(
  searchMessages([FAKE], "100%", 10),
  [],
  "a LIKE wildcard in the query matches literally, not as a glob",
);
assert.deepEqual(searchMessages([], "anything", 10), [], "no chats means no results, not every result");

// Edits and deletes are their own rows pointing at the original, which stays untouched. Reads
// therefore have to say so, or a chat renders with text that has since been changed or revoked.
appendMessage(FAKE, { direction: "out", by: "claude", text: "before", ts: 4000, id: "EDITME" });
appendMessage(FAKE, { direction: "out", by: "claude", text: "gone soon", ts: 5000, id: "DELME" });
appendMessage(FAKE, { direction: "out", by: "claude", kind: "edit", text: "after", to: "EDITME", ts: 6000 });
appendMessage(FAKE, { direction: "out", by: "claude", kind: "edit", text: "after twice", to: "EDITME", ts: 7000 });
appendMessage(FAKE, { direction: "out", by: "claude", kind: "delete", to: "DELME", ts: 8000 });

const edited = findMessage(FAKE, "EDITME");
assert.equal(edited.text, "before", "the original text is preserved, never overwritten");
assert.equal(edited.edited, true, "...but the read flags it as edited");
assert.equal(edited.editedText, "after twice", "the latest edit wins when there are several");
const deleted = findMessage(FAKE, "DELME");
assert.equal(deleted.text, "gone soon", "a deleted message's text stays in the local history");
assert.equal(deleted.deleted, true, "...flagged as deleted");
assert.equal(findMessage(FAKE, "CLAUDE1").edited, undefined, "an untouched message gains no flags");
assert.match(
  guardOwnMessage(FAKE, "DELME").error.content[0].text,
  /already deleted/,
  "editing an already-deleted message is refused, not silently sent",
);
assert.equal(readRecent(FAKE, 10).find((m) => m.id === "EDITME").edited, true, "readRecent carries the flags too");

archiveOldMessages(FAKE, 0);
assert.equal(messageCount(FAKE), 0, "archived messages drop out of the active count");
assert.equal(readRecent(FAKE, 10).length, 0, "...and out of readRecent");
assert.equal(searchMessages([FAKE], "sent by", 10).length, 1, "...but search still spans the archive");

// guardSend is what every outbound tool actually calls. scanOutbound and overSendLimit are each
// tested above in isolation, so dropping the scanOutbound call from inside guardSend — disabling
// the secret backstop for every send tool at once — used to leave this suite entirely green.
const { guardSend, COMMANDS: CMDS, isViewOnce, unwrapped, extractContent: extract } = await import("./src/server.mjs");
assert.match(
  guardSend(DM, "here is the key AKIAIOSFODNN7EXAMPLE").content[0].text,
  /Refused/,
  "guardSend refuses a message carrying a secret, not just scanOutbound in isolation",
);
assert.match(guardSend("4900000000000@s.whatsapp.net", "hi").content[0].text, /allowlist/, "guardSend gates recipient");

// A message this server sent ends in the attribution, and every command is anchored — so our own
// sends can never be parsed as in-chat commands even if WhatsApp began echoing them back.
const ATTR = "\n\n(_Claude_)";
for (const [name, re] of Object.entries(CMDS)) {
  const sample = {
    wakelevel: "/wakelevel verbose",
    speaking: "/speaking text-only",
    speakingSpeed: "/speaking-speed 1.2",
    s2tTier: "/s2t-tier low",
    t2sTier: "/t2s-tier low",
    language: "/language en",
    readMedia: "/read-image no",
    verbosity: "/verbosity low",
    help: "/help",
  }[name];
  assert.ok(re.exec(sample), `${name} matches its own command form`);
  assert.equal(re.exec(sample + ATTR), null, `${name} cannot match a message carrying the (_Claude_) attribution`);
}

// Wrapped payloads: Baileys emits these raw, and an unrecognised wrapper used to be dropped whole —
// turning on disappearing messages made an entire chat silently invisible.
const ephemeral = { ephemeralMessage: { message: { conversation: "inside a disappearing chat" } } };
assert.equal(extract(unwrapped(ephemeral))?.text, "inside a disappearing chat", "ephemeral wrapper is unwrapped");
const viewOnce = { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg", caption: "once" } } } };
assert.equal(isViewOnce(viewOnce), true, "view-once is detected so the row can be marked");
assert.equal(extract(unwrapped(viewOnce))?.kind, "image", "view-once still yields content to store");
assert.equal(isViewOnce({ conversation: "hi" }), false, "an ordinary message is not flagged view-once");

// Turkish case folding: SQLite's own lower() is ASCII-only, so this missed silently in chats that
// are entirely Turkish.
appendMessage(FAKE, { direction: "in", text: "ŞEKER ve İSTANBUL", ts: 9000, id: "TR1" });
assert.equal(
  searchMessages([FAKE], "şeker", 10).length,
  1,
  "lowercase Turkish query finds an uppercase Turkish message",
);
assert.equal(searchMessages([FAKE], "İSTANBUL", 10).length, 1, "and the same in reverse");

// Runs last: it deliberately exhausts the window, so anything after it would see a full budget.
let sent = 0;
while (!overSendLimit()) sent++;
assert.equal(sent, 20, "rate limit allows exactly 20 sends per minute, then refuses");

console.log(
  "ok — allowlist, media naming, command regexes, quotes, secret scan, edit/delete ownership guard, sendable-source guard, sqlite store and rate limit",
);
