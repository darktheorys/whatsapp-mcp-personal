// Run: npm test
// Covers the one piece of logic here that can fail silently: which incoming messages the
// allowlist lets through, and which JID a chat gets stored under once it does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DM = "4917012345678@s.whatsapp.net";
const DM_LID = "112167902834798@lid";
const GROUP = "120363001234567890@g.us";

const cfg = join(mkdtempSync(join(tmpdir(), "wa-test-")), "config.json");
writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));
process.env.WA_CONFIG_PATH = cfg;
// The voice paths (cloned voices, the XTTS socket, the daemon token) are also resolved when config.mjs
// loads, so a test must not be able to touch the real ones.
const voiceDir = mkdtempSync(join(tmpdir(), "wa-voices-"));
process.env.WA_VOICES_DIR = join(voiceDir, "voices");
process.env.WA_XTTS_SOCK = join(voiceDir, "x.sock");
process.env.WA_DAEMON_TOKEN = join(voiceDir, "token");
writeFileSync(process.env.WA_DAEMON_TOKEN, "t".repeat(64) + "\n");
// The files handleIncoming writes besides the database: the wake log the live session tails, contacts,
// the read cursor and the pending wake queue. A test writing to the real inbox.log would wake the real
// session with fake messages.
const stateDir = mkdtempSync(join(tmpdir(), "wa-state-"));
process.env.WA_INBOX_PATH = join(stateDir, "inbox.log");
process.env.WA_CONTACTS_PATH = join(stateDir, "contacts.json");
process.env.WA_POLL_STATE_PATH = join(stateDir, "poll-state.json");
process.env.WA_PENDING_WAKE_PATH = join(stateDir, "pending-wake.json");
process.env.WA_LOG_PATH = join(stateDir, "baileys.log");

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

// Every key defaultConfig() declares must survive loadConfig(), which whitelists them one by one
// rather than merging. This has now broken twice: the first time a missing key silently read as
// undefined so a gate never gated, the second time a gate called .includes() on undefined and threw
// inside handleIncoming — which safely() caught, so messages were dropped with only a log line.
// Adding a setting in two places and forgetting the third is evidently easy, so assert it instead.
{
  const { loadConfig, defaultConfigForTest } = await import("./src/config.mjs");
  writeFileSync(cfg, JSON.stringify({ allowlist: [DM] })); // a config predating every later setting
  const loaded = loadConfig();
  for (const key of Object.keys(defaultConfigForTest())) {
    assert.notEqual(loaded[key], undefined, `loadConfig drops ${key}, which defaultConfig declares`);
  }
}

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

// Same reason as WA_DB_PATH: schedule.mjs resolves its file at module load, and the tests must not
// touch (or fire) the real schedule.
process.env.WA_SCHEDULE_PATH = join(mkdtempSync(join(tmpdir(), "wa-sched-")), "schedule.json");

// Same again: polls.mjs holds poll secrets, and a test writing to the real file would put fake
// secrets alongside real ones this server might still need to decrypt live votes with.
process.env.WA_POLLS_PATH = join(mkdtempSync(join(tmpdir(), "wa-polls-")), "polls.json");

// WA_NO_CONNECT keeps the import from opening a WhatsApp socket and evicting the live server.
process.env.WA_NO_CONNECT = "1";
const { extractContent, mediaName } = await import("./src/server.mjs");

assert.deepEqual(extractContent({ conversation: "hi" }), { text: "hi" }, "plain text");
assert.equal(extractContent({ extendedTextMessage: { text: "quoted" } }).text, "quoted", "extended text");
assert.equal(extractContent(null), null, "empty payload");
// Video used to be dropped whole. It is now carried so its audio can be transcribed like a voice
// note's — the assertion is inverted deliberately, not relaxed.
assert.equal(extractContent({ videoMessage: {} }).kind, "video", "video is carried, not dropped");
assert.equal(
  extractContent({ videoMessage: { caption: "bak" } }).text,
  "bak",
  "a video's caption survives even when the download later fails",
);

// A shared location has no downloadable body, so it must render to text rather than claim a media
// kind — claiming one would send saveMedia off to download a message with nothing to download.
const loc = extractContent({ locationMessage: { degreesLatitude: 41.0082, degreesLongitude: 28.9784, name: "Ev" } });
assert.equal(loc.kind, undefined, "location is not a media kind");
assert.match(loc.text, /^\[location\] 41\.0082, 28\.9784 — Ev$/, "location renders coordinates and name");
assert.match(
  extractContent({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2, caption: "yoldayım" } }).text,
  /^\[location \(live\)\] 1, 2 — yoldayım$/,
  "live location is marked live and uses its caption (it has no name/address field)",
);
assert.match(
  extractContent({ locationMessage: {} }).text,
  /coordinates missing/,
  "a location without coordinates still logs rather than throwing",
);

// The round video note reuses IVideoMessage, so it must reach the same download+transcribe path.
assert.equal(extractContent({ ptvMessage: {} }).kind, "video", "a video note is carried as video");

// Types that carry no downloadable body and so must render to text rather than claim a media kind.
assert.match(
  extractContent({
    contactMessage: { displayName: "Ali", vcard: "BEGIN:VCARD\nTEL;type=CELL:+90 532 111 22 33\nEND:VCARD" },
  }).text,
  /^\[contact\] Ali \+90 532 111 22 33$/,
  "a shared contact renders name and number out of the vCard",
);
assert.equal(
  extractContent({ contactMessage: { displayName: "Ali" } }).text,
  "[contact] Ali",
  "a vCard with no TEL line still renders, without a trailing separator",
);
assert.match(
  extractContent({ contactsArrayMessage: { contacts: [{ displayName: "Ali" }, { displayName: "Veli" }] } }).text,
  /^\[contacts\] Ali, Veli$/,
  "a contacts array lists the names",
);
assert.match(
  extractContent({
    pollCreationMessageV3: { name: "Nereye?", options: [{ optionName: "Lidl" }, { optionName: "Rossmann" }] },
  }).text,
  /^\[poll\] Nereye\? — Lidl \/ Rossmann$/,
  "polls render question and options, on any of the five versions",
);
assert.match(
  extractContent({ groupInviteMessage: { groupName: "Kahve" } }).text,
  /^\[group invite\] Kahve$/,
  "a group invite names the group",
);
assert.match(
  extractContent({ eventMessage: { name: "Toplantı", isCanceled: true } }).text,
  /^\[event cancelled\] Toplantı$/,
  "a cancelled event says so",
);
assert.match(
  extractContent({ albumMessage: { expectedImageCount: 3 } }).text,
  /3 image/,
  "an album reports its counts",
);

// A message from another of the owner's own linked devices wraps the real one; without unwrapping
// it the inner message is invisible.
assert.equal(
  extractContent({ deviceSentMessage: { message: { conversation: "from my laptop" } } }).text,
  "from my laptop",
  "deviceSentMessage is unwrapped to the message inside it",
);

// The catch-all. This is the regression guard for the whole silent-drop class: an unrecognised
// type must produce a named, searchable row, never null.
const unknown = extractContent({ someFutureMessageTypeWhatsAppInvents: { x: 1 } });
assert.equal(
  unknown.text,
  "[unsupported: someFutureMessageTypeWhatsAppInvents]",
  "unknown types are named, not dropped",
);
assert.equal(unknown.unsupported, "someFutureMessageTypeWhatsAppInvents", "and flagged so the server can report them");

// ...but protocol plumbing must still be dropped, or every key-exchange and receipt becomes a row.
for (const noise of [
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "reactionMessage",
  "pollUpdateMessage",
]) {
  assert.equal(extractContent({ [noise]: {} }), null, `${noise} is protocol plumbing, not a message`);
}
// A sidecar riding along with real content must not mask the content or trigger the catch-all.
assert.equal(
  extractContent({ messageContextInfo: { deviceListMetadata: {} }, conversation: "hi" }).text,
  "hi",
  "messageContextInfo alongside real text does not shadow it",
);
assert.equal(
  extractContent({ protocolMessage: {}, imageMessage: { caption: "bak" } }).kind,
  "image",
  "nor does it mask media",
);

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
const { scanOutbound, scanOutboundAll, overSendLimit } = await import("./src/server.mjs");

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

// wa_send_poll's own scan, over the array a poll actually sends (question is scanned by guardSend
// already; this covers the options guardSend never sees). The regression this guards is a secret
// sitting in an option rather than the question — scanning only element 0 would have caught the
// case above and missed exactly this one.
assert.equal(scanOutboundAll(["kırmızı", "mavi"]), null, "ordinary options send");
assert.equal(
  scanOutboundAll(["evet", "hayır", "AKIAIOSFODNN7EXAMPLE"])?.text,
  "AKIAIOSFODNN7EXAMPLE",
  "a secret in the THIRD option is still caught, not just the first",
);
assert.match(scanOutboundAll(["fine", `token ghp_${"a".repeat(36)}`]).reason, /GitHub/);

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

// wa_send_document: only listed extensions go out, and every format is secret-scanned on its real
// content, not its raw bytes (pdf and office files compress their text). Checks the pure helpers, the
// tool itself needs a live socket.
const { documentInfo, scanDocument, DOCUMENT_TYPES } = await import("./src/server.mjs");
const { deflateSync, deflateRawSync } = await import("node:zlib");
const docDir = join(STATE_DIR, "memes");
mkdirSync(docDir, { recursive: true });
const pdfDoc = join(docDir, "test-doc.PDF");
const dbDoc = join(docDir, "test-doc.db");
writeFileSync(pdfDoc, "%PDF-1.4");
writeFileSync(dbDoc, "x");
const SECRET = "AKIAIOSFODNN7EXAMPLE";
try {
  assert.equal(documentInfo(pdfDoc).mimetype, DOCUMENT_TYPES[".pdf"], "extension match is case-insensitive");
  assert.match(documentInfo(dbDoc).error, /not an allowed document type/, "a .db is refused");
} finally {
  rmSync(pdfDoc, { force: true });
  rmSync(dbDoc, { force: true });
}
assert.equal(scanDocument(Buffer.from("just a normal csv\n1,2,3"), ".csv"), null, "a clean text file passes");
assert.ok(scanDocument(Buffer.from(`key,${SECRET}\n`), ".csv"), "a secret inside a csv is caught");
// A pdf whose page text is Flate-compressed: the raw bytes contain no readable secret at all.
const pdfBody = deflateSync(Buffer.from(`BT (${SECRET}) Tj ET`));
const pdfBuf = Buffer.concat([
  Buffer.from("%PDF-1.4\n1 0 obj\nstream\n"),
  pdfBody,
  Buffer.from("\nendstream\nendobj\n"),
]);
assert.ok(!pdfBuf.toString("latin1").includes(SECRET), "test setup: the secret is not visible in the raw pdf");
assert.ok(scanDocument(pdfBuf, ".pdf"), "a secret inside a compressed pdf stream is caught");
assert.equal(
  scanDocument(
    Buffer.concat([
      Buffer.from("%PDF-1.4\nstream\n"),
      deflateSync(Buffer.from("hello world")),
      Buffer.from("\nendstream"),
    ]),
    ".pdf",
  ),
  null,
  "a clean pdf passes",
);
// A minimal docx-shaped zip: one deflated xml entry, central directory at the end.
function zipOf(name, content) {
  const data = deflateRawSync(Buffer.from(content));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}
assert.ok(
  scanDocument(zipOf("word/document.xml", `<w:t>${SECRET}</w:t>`), ".docx"),
  "a secret inside a docx is caught",
);
assert.equal(scanDocument(zipOf("word/document.xml", "<w:t>hello</w:t>"), ".docx"), null, "a clean docx passes");
// Several streams in one pdf: the secret sits in the SECOND and the FOURTH, which an earlier version of the
// scanner skipped by resuming inside the word "endstream".
{
  const stream = (t) =>
    Buffer.concat([Buffer.from("obj\nstream\n"), deflateSync(Buffer.from(t)), Buffer.from("\nendstream\nendobj\n")]);
  const clean = (n) => stream(`page ${n}`);
  const head = Buffer.from("%PDF-1.4\n");
  assert.ok(
    scanDocument(Buffer.concat([head, clean(1), stream(SECRET), clean(3), clean(4)]), ".pdf"),
    "secret in stream 2",
  );
  assert.ok(
    scanDocument(Buffer.concat([head, clean(1), clean(2), clean(3), stream(SECRET)]), ".pdf"),
    "secret in stream 4",
  );
  assert.equal(
    scanDocument(Buffer.concat([head, clean(1), clean(2), clean(3), clean(4)]), ".pdf"),
    null,
    "four clean streams pass",
  );
  // Fails closed: a stream that starts like Flate but will not inflate is refused, not skipped.
  const broken = Buffer.concat([
    head,
    Buffer.from("obj\nstream\n"),
    Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff]),
    Buffer.from("\nendstream\n"),
  ]);
  assert.match(scanDocument(broken, ".pdf"), /could not be scanned/, "an unreadable stream is refused");
  // The container is recognised by its bytes, not its extension.
  assert.ok(scanDocument(Buffer.concat([head, stream(SECRET)]), ".txt"), "a pdf renamed to .txt is still opened up");
}

// The rate limit is only spent by a real send. A refused request that merely checks must not use a slot.
{
  const { overSendLimit: limit } = await import("./src/server.mjs");
  for (let i = 0; i < 60; i++) assert.equal(limit(false), false, "a check-only call never reports the limit");
  assert.equal(limit(false), false, "...and spent nothing, 60 checks later a real send still fits");
}

// Only a session's outbox/ folder is a send source, not the scratchpad as a whole: anything copied
// there from state/media would otherwise be forwardable.
{
  const scratch = join(`/private/tmp/claude-${process.getuid()}`, `wa-test-${process.pid}`, "scratchpad");
  mkdirSync(join(scratch, "outbox"), { recursive: true });
  const loose = join(scratch, "loose.txt");
  const boxed = join(scratch, "outbox", "ok.txt");
  writeFileSync(loose, "x");
  writeFileSync(boxed, "x");
  try {
    assert.match(resolveSendable(loose).error, /outside the sendable/, "a loose scratchpad file is not sendable");
    assert.equal(resolveSendable(boxed).error, undefined, "a file in scratchpad/outbox is sendable");
  } finally {
    rmSync(join(scratch, ".."), { recursive: true, force: true });
  }
}

// Quoted replies, long-reply splitting, the wake trigger label and the since-your-last-reply block.
{
  const { splitForSend, SPLIT_OVER, MAX_PARTS, triggerLabel, contextBlock, quoteOptions } =
    await import("./src/server.mjs");
  const store = await import("./src/store.mjs");
  assert.deepEqual(splitForSend("kisa bir mesaj"), ["kisa bir mesaj"], "short text stays one message");
  const para = (n) => `${"kelime ".repeat(Math.ceil(120 / 7))}${n}.`;
  const threeParas = [para(1), para(2), para(3)].join("\n\n");
  assert.ok(threeParas.length > SPLIT_OVER);
  assert.equal(splitForSend(threeParas).length, 3, "three paragraphs go out as three messages");
  assert.equal(
    splitForSend(`${threeParas}\n\n${para(4)}\n\n${para(5)}`).length <= MAX_PARTS,
    true,
    "never more than three",
  );
  const sentences = Array.from({ length: 8 }, (_, i) => `Bu ${i} numarali cumle biraz uzun ve noktayla biter.`).join(
    " ",
  );
  const sParts = splitForSend(sentences);
  assert.ok(sParts.length >= 2 && sParts.length <= MAX_PARTS, "one paragraph is cut at sentence boundaries");
  assert.equal(sParts.join(" "), sentences, "nothing is lost or reordered");
  assert.ok(
    sParts.every((p) => /[.!?]$/.test(p)),
    "no part ends mid-sentence",
  );
  const oneLong = "tek ".repeat(150).trim();
  assert.deepEqual(splitForSend(oneLong), [oneLong], "one unbroken sentence is never cut in the middle");

  assert.equal(triggerLabel({ fromMe: false, tagged: true, replyingToMe: false }), "[tag]");
  assert.equal(triggerLabel({ fromMe: false, tagged: false, replyingToMe: true }), "[reply to you]");
  assert.equal(triggerLabel({ fromMe: false, tagged: false, replyingToMe: false }), "[ambient]");
  assert.equal(
    triggerLabel({ fromMe: true, tagged: false, replyingToMe: false }),
    "",
    "the owner's plain message has no marker",
  );

  const rows = [
    { ts: 1, id: "a", name: "A", text: "eski mesaj" },
    { ts: 2, id: "b", by: "claude", text: "bizim yanit" },
    { ts: 3, id: "c", name: "B", text: "sonra yazilan" },
    { ts: 4, id: "d", name: "C", text: "", media: { kind: "image" } },
    { ts: 5, id: "e", kind: "reaction", text: "x" },
    { ts: 6, id: "f", name: "D", text: "etiketli mesaj" },
  ];
  assert.equal(
    contextBlock(rows, { beforeTs: 6, exceptId: "f" }),
    "B: sonra yazilan | C: [image]",
    "only what came after our last message, without the trigger itself or reactions",
  );
  assert.equal(
    contextBlock(rows.slice(0, 2), { beforeTs: 9, exceptId: "zz" }),
    "",
    "nothing since our last reply gives an empty block",
  );

  const QJID = "120363000000000077@g.us";
  store.appendMessage(QJID, {
    direction: "in",
    from: "4915100000000@s.whatsapp.net",
    name: "X",
    text: "alintilacak",
    ts: 10,
    id: "QM1",
  });
  store.appendMessage(QJID, { direction: "out", by: "claude", text: "benim", ts: 11, id: "QM2" });
  const sock = { user: { id: "491700000000:3@s.whatsapp.net" } };
  assert.equal(quoteOptions(sock, QJID, undefined), undefined, "no reply_to means no quote");
  const q1 = quoteOptions(sock, QJID, "QM1").quoted;
  assert.deepEqual(
    q1.key,
    { remoteJid: QJID, id: "QM1", fromMe: false, participant: "4915100000000@s.whatsapp.net" },
    "a group member's message is quoted with its sender",
  );
  assert.equal(q1.message.conversation, "alintilacak");
  assert.equal(quoteOptions(sock, QJID, "QM2").quoted.key.fromMe, true, "our own message is quoted as ours");
  assert.throws(
    () => quoteOptions(sock, "120363000000000078@g.us", "QM1"),
    /not in .* log/,
    "an id from another chat cannot be quoted",
  );
}

// Which chat a send goes to: taken from reply_to when given, a disagreeing `to` refused, and a chat that
// has not woken the session refused unless the call says why (owner decisions, 2026-10-17).
{
  const { resolveTarget, markLive, isLive, jidsIn, liveFromInboxLines, LIVE_MS } = await import("./src/server.mjs");
  const store = await import("./src/store.mjs");
  const A = "120363000000000101@g.us";
  const B = "120363000000000102@g.us";
  const OWN = "491700000000@s.whatsapp.net";
  const chatsOf = (id) => ({ M1: [A], DUP: [A, B] })[id] ?? [];
  const live = (jid) => jid === A;
  const t = (args) => resolveTarget({ ownJid: OWN, chatsOf, live, ...args });

  assert.equal(t({ replyTo: "M1" }).target, A, "reply_to alone gives the chat of the quoted message");
  assert.equal(t({ to: A, replyTo: "M1" }).target, A, "a matching `to` is fine");
  assert.match(t({ to: B, replyTo: "M1" }).error.content[0].text, /is in .*not in/, "a `to` that disagrees is refused");
  assert.match(t({ replyTo: "NOPE" }).error.content[0].text, /not in any chat/, "an unknown id is refused");
  assert.match(t({ replyTo: "DUP" }).error.content[0].text, /more than one chat/, "an ambiguous id needs `to`");
  assert.equal(t({ to: B, replyTo: "DUP", unprompted: "test" }).target, B, "`to` settles an ambiguous id");
  assert.match(t({}).error.content[0].text, /give `to`/, "no target at all is refused");
  assert.match(t({ to: B }).error.content[0].text, /has not woken/, "a chat that did not wake the session is refused");
  assert.match(t({ to: B, unprompted: "   " }).error.content[0].text, /has not woken/, "a blank reason does not count");
  assert.equal(t({ to: B, unprompted: "daily-digest" }).target, B, "a stated reason lets it through");
  assert.equal(t({ to: OWN }).target, OWN, "the owner's own DM is always open");
  assert.equal(t({ to: A }).target, A, "a live chat needs no reason");

  const C = "120363000000000103@g.us";
  markLive(C, 1_000);
  assert.ok(isLive(C, 1_000 + LIVE_MS), "live until the window ends");
  assert.ok(!isLive(C, 1_000 + LIVE_MS + 1), "and not after");
  assert.ok(!isLive("120363000000000104@g.us"), "a chat never marked is not live");

  assert.deepEqual(
    jidsIn(
      "Open a poll in the group (120363000000000110@g.us) and DM 491700000001@s.whatsapp.net, again 120363000000000110@g.us",
    ),
    ["120363000000000110@g.us", "491700000001@s.whatsapp.net"],
    "a scheduled prompt's chat ids are found, once each",
  );
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const seeded = liveFromInboxLines(
    [
      "[2026-10-17T11:30:00.000Z] [120363000000000105@g.us] (them) X: [tag] selam",
      "[2026-10-17T09:00:00.000Z] [120363000000000106@g.us] (them) Y: eski",
      "[2026-10-17T11:59:00.000Z] [(scheduler)] ⏰ poll: Open a poll in 120363000000000107@g.us",
      "not a log line",
    ],
    now,
  );
  assert.deepEqual(
    [...seeded.keys()].sort(),
    ["120363000000000105@g.us", "120363000000000107@g.us"],
    "recent wakes and scheduled targets survive a restart, old ones do not",
  );

  // The store side: which chat holds an id, and archived messages are still found.
  const D = "120363000000000108@g.us";
  store.appendMessage(D, {
    direction: "in",
    from: "4915100000009@s.whatsapp.net",
    text: "eski mesaj",
    ts: 5,
    id: "OLD1",
  });
  store.archiveOldMessages(D, 0);
  assert.ok(store.findMessage(D, "OLD1"), "a message past the archive cut can still be replied to");
  assert.deepEqual(store.chatsOfMessage("OLD1"), [D], "chatsOfMessage names the chat");
  assert.deepEqual(store.chatsOfMessage("NOPE"), [], "and nothing for an unknown id");
}

// Someone else's edit or delete becomes its own row pointing at the original.
{
  const { protocolChangeEntry, PROTOCOL_REVOKE, PROTOCOL_MESSAGE_EDIT, SPEAKING_RATE_MIN, SPEAKING_RATE_MAX } =
    await import("./src/server.mjs");
  const base = { fromMe: false, ts: 99, from: "4915100000001@s.whatsapp.net", name: "Z" };
  assert.deepEqual(
    protocolChangeEntry({ type: PROTOCOL_REVOKE, key: { id: "T1" } }, base),
    { direction: "in", kind: "delete", to: "T1", ts: 99, from: "4915100000001@s.whatsapp.net", name: "Z" },
    "a delete",
  );
  assert.equal(
    protocolChangeEntry({ type: PROTOCOL_MESSAGE_EDIT, key: { id: "T1" } }, { ...base, editedText: "yeni" }).text,
    "yeni",
    "an edit carries the new text",
  );
  assert.equal(
    protocolChangeEntry({ type: PROTOCOL_REVOKE, key: { id: "T1" } }, { ...base, targetByClaude: true }),
    null,
    "our own edits and deletes are already stored when we send them",
  );
  assert.equal(protocolChangeEntry({ type: 3, key: { id: "T1" } }, base), null, "other protocol types are not rows");
  assert.equal(protocolChangeEntry({ type: PROTOCOL_REVOKE }, base), null, "no target, nothing to store");
  const store = await import("./src/store.mjs");
  const E = "120363000000000109@g.us";
  store.appendMessage(E, { direction: "in", from: base.from, text: "ilk hali", ts: 10, id: "ED1" });
  store.appendMessage(
    E,
    protocolChangeEntry(
      { type: PROTOCOL_MESSAGE_EDIT, key: { id: "ED1" } },
      { ...base, ts: 11, editedText: "duzeltilmis" },
    ),
  );
  const found = store.findMessage(E, "ED1");
  assert.equal(found.edited, true, "the original now reads as edited");
  assert.equal(found.editedText, "duzeltilmis", "with the new text");
  assert.ok(SPEAKING_RATE_MIN > 0 && SPEAKING_RATE_MIN < 1 && SPEAKING_RATE_MAX > 1, "speaking speed has a sane range");
}

// Tagging people: only in a group, only people who have written in THAT chat, at most two, never everyone,
// never a number on the do-not-tag list. The text's @Name becomes @number and the person goes in mentions.
{
  const { resolveMentions, applyMentions } = await import("./src/server.mjs");
  const store = await import("./src/store.mjs");
  const { writeFileSync: writeCfg, readFileSync: readCfg } = await import("node:fs");
  const MG = "120363000000000088@g.us";
  const OTHER = "120363000000000089@g.us";
  store.appendMessage(MG, {
    direction: "in",
    from: "4915100000001@s.whatsapp.net",
    name: "Mert",
    text: "a",
    ts: 1,
    id: "MG1",
  });
  store.appendMessage(MG, {
    direction: "in",
    from: "4915100000002@s.whatsapp.net",
    name: "Selin",
    text: "b",
    ts: 2,
    id: "MG2",
  });
  store.appendMessage(MG, {
    direction: "in",
    from: "4915100000003@s.whatsapp.net",
    name: "Bot",
    text: "c",
    ts: 3,
    id: "MG3",
  });
  store.appendMessage(MG, { direction: "out", name: "Burak", text: "d", ts: 4, id: "MG4" });
  store.appendMessage(OTHER, {
    direction: "in",
    from: "4915100000009@s.whatsapp.net",
    name: "Elsewhere",
    text: "e",
    ts: 5,
    id: "OT1",
  });
  const own = "491700000000:3@s.whatsapp.net";
  assert.deepEqual(resolveMentions(MG, [], own), [], "no names, no tags");
  const r = resolveMentions(MG, ["mert", "@Selin"], own);
  assert.deepEqual(
    r.map((x) => x.jid),
    ["4915100000001@s.whatsapp.net", "4915100000002@s.whatsapp.net"],
    "case-insensitive names resolve to their numbers",
  );
  assert.equal(
    resolveMentions(MG, ["Burak"], own)[0].jid,
    "491700000000@s.whatsapp.net",
    "the owner resolves to his own number",
  );
  assert.throws(
    () => resolveMentions(MG, ["Elsewhere"], own),
    /nobody called/,
    "someone who only wrote in another chat cannot be tagged",
  );
  assert.throws(() => resolveMentions(MG, ["Mert", "Selin", "Bot"], own), /at most 2/, "three people is too many");
  assert.throws(() => resolveMentions(MG, ["all"], own), /everyone/, "everyone is refused");
  assert.throws(() => resolveMentions(MG, ["herkes"], own), /everyone/, "in Turkish too");
  assert.throws(
    () => resolveMentions("491700000099@s.whatsapp.net", ["Mert"], own),
    /only works in a group/,
    "a DM cannot tag",
  );
  // The do-not-tag list is read from the config file on every call.
  const cfgPath = process.env.WA_CONFIG_PATH;
  const before = readCfg(cfgPath, "utf8");
  writeCfg(cfgPath, JSON.stringify({ ...JSON.parse(before), no_mention_jids: ["4915100000003@s.whatsapp.net"] }));
  try {
    assert.throws(() => resolveMentions(MG, ["Bot"], own), /do-not-tag list/, "a listed bot is never tagged");
    assert.ok(resolveMentions(MG, ["Mert"], own).length === 1, "others still work");
  } finally {
    writeCfg(cfgPath, before);
  }
  assert.equal(
    applyMentions("selam @Mert nasilsin", [r[0]]),
    "selam @4915100000001 nasilsin",
    "@Name becomes @number in place",
  );
  assert.equal(
    applyMentions("selam nasilsin", [r[0]]),
    "@4915100000001 selam nasilsin",
    "a tag the text never wrote goes at the front",
  );
  assert.equal(
    applyMentions("@Mertcan bir sey", [r[0]]),
    "@4915100000001 @Mertcan bir sey",
    "a longer word that starts with the name is not the name",
  );
}

// A profile's About text arrives in a few shapes depending on the library version.
{
  const { parseAbout } = await import("./src/server.mjs");
  assert.deepEqual(
    parseAbout([{ id: "x", status: { status: "merhaba", setAt: "2026-10-01T10:00:00.000Z" } }]),
    { about: "merhaba", setAt: "2026-10-01T10:00:00.000Z" },
    "array with a status object",
  );
  assert.deepEqual(
    parseAbout({ status: "yalniz metin" }),
    { about: "yalniz metin", setAt: null },
    "a plain string status",
  );
  assert.deepEqual(parseAbout([{ status: { status: "  " } }]), { about: null, setAt: null }, "a blank About is null");
  assert.deepEqual(parseAbout(undefined), { about: null, setAt: null }, "nothing returned is null, not a crash");
}

// /generate: the options are parsed into a fixed set, never passed through a shell, and the server's own
// messages can never trigger it.
{
  const {
    parseGenerateArgs,
    isCancelRequest,
    parseStatusRequest,
    latestStep,
    COMMANDS: C,
  } = await import("./src/server.mjs");
  assert.deepEqual(parseGenerateArgs(""), { error: "usage" }, "no arguments shows the usage");
  assert.deepEqual(
    parseGenerateArgs("a red fez on a desk"),
    {
      model: "qwen",
      prompt: "a red fez on a desk",
      negative: "",
      steps: undefined,
      width: undefined,
      height: undefined,
      seed: undefined,
    },
    "no flags at all means the whole text is the prompt, default model z",
  );
  const full = parseGenerateArgs(
    `--model burak --prompt 'a fez, on a desk' --negative "blurry text" --steps 12 --width 512 --height 768 --seed 7`,
  );
  assert.deepEqual(
    full,
    {
      model: "burak",
      prompt: "a fez, on a desk",
      negative: "blurry text",
      steps: 12,
      width: 512,
      height: 768,
      seed: 7,
    },
    "quoted values and every flag parse",
  );
  assert.equal(
    parseGenerateArgs("--prompt a red fez --negative blurry").prompt,
    "a red fez",
    "an unquoted prompt runs until the next flag",
  );
  assert.equal(
    parseGenerateArgs("--prompt \u201csmart quotes\u201d --steps 4").prompt,
    "smart quotes",
    "phone keyboard quotes work",
  );
  assert.match(
    parseGenerateArgs("--prompt x --model ../../bin/sh").error,
    /not a model name/,
    "a path is not a model name",
  );
  assert.match(parseGenerateArgs("--prompt x --model Bad").error, /not a model name/, "capitals are not allowed");
  assert.match(parseGenerateArgs("--prompt x --steps 500").error, /steps/, "too many steps");
  assert.match(parseGenerateArgs("--prompt x --width 500").error, /multiples of 16/, "not a multiple of 16");
  assert.match(parseGenerateArgs("--prompt x --width 4096").error, /multiples of 16/, "too large");
  assert.match(parseGenerateArgs("--prompt x --seed -1").error, /seed/, "negative seed");
  assert.match(parseGenerateArgs("--prompt " + "a".repeat(601)).error, /too long/, "prompt length is capped");
  assert.deepEqual(parseGenerateArgs("--steps 4"), { error: "usage" }, "options without a prompt is the usage");
  assert.equal(
    parseGenerateArgs("--prompt x; rm -rf /").prompt,
    "x; rm -rf /",
    "shell characters are just prompt text",
  );
  for (const word of ["cancel", "stop", "iptal", " Cancel ", "STOP"]) {
    assert.equal(isCancelRequest(word), true, `"${word}" cancels`);
  }
  for (const text of ["cancel culture", "a red fez", "", undefined, "--prompt cancel"]) {
    assert.equal(isCancelRequest(text), false, `"${text}" does not cancel`);
  }
  assert.ok(C.generate.exec("/generate cancel"), "the cancel form goes through the same command");
  assert.deepEqual(parseStatusRequest("status"), { id: null }, "bare status lists the renders");
  assert.deepEqual(parseStatusRequest(" Status 7 "), { id: 7 }, "status with a number names one render");
  assert.deepEqual(parseStatusRequest("status #12"), { id: 12 }, "a leading # is fine");
  for (const text of ["status of the world", "statuses", "a red fez", "", undefined, "status 1 2", "status abc"]) {
    assert.equal(parseStatusRequest(text), null, `"${text}" is not a status request`);
  }
  const f = (name, age) => ({ name, mtimeMs: 100000 - age });
  assert.equal(
    latestStep([f("seed_1_step0of4.png", 5000), f("seed_1_step2of4.png", 3000), f("seed_1_step1of4.png", 4000)], 100000)
      ?.step,
    2,
    "the highest step is the latest",
  );
  assert.equal(
    latestStep([f("seed_1_step1of4.png", 4000), f("seed_1_step2of4.png", 200)], 100000)?.step,
    1,
    "a file written in the last second is skipped",
  );
  assert.equal(latestStep([f("seed_1_step0of4.png", 200)], 100000)?.step, 0, "unless it is the only one");
  assert.equal(
    latestStep([f("seed_1_composite.png", 9000), f("final.png", 9000)], 100000),
    null,
    "other files are not steps",
  );
  assert.deepEqual(
    latestStep([f("a_step3of8.png", 9000)], 100000),
    { name: "a_step3of8.png", mtimeMs: 91000, step: 3, total: 8 },
    "total is read from the name",
  );

  assert.ok(C.generate.exec("/generate"), "the bare command matches (shows the usage)");
  assert.ok(C.generate.exec("/generate --prompt 'multi\nline'"), "a multi-line prompt matches");
  assert.equal(C.generate.exec("/generate --prompt x\n\n(_Claude_)"), null, "our own attribution never triggers it");
  assert.equal(C.generate.exec("please /generate --prompt x"), null, "it must start the message");
}

// The voice-note tail trim. XTTS sometimes adds syllables after the last word, so the cut point is the end
// of the last intended word in a word-timestamped transcript, found only among the last three words.
{
  const { parseWordTimestamps, speechEndSeconds } = await import("./src/server.mjs");
  const out =
    "[00:00:00.000 --> 00:00:00.010]  \n[00:00:00.010 --> 00:00:00.500]   Korkma,\n[00:00:06.670 --> 00:00:07.680]   ocak.\n";
  const words = parseWordTimestamps(out);
  assert.equal(words.length, 2, "one entry per line that has a word, the blank leading line is skipped");
  assert.deepEqual(words[1], { start: 6.67, end: 7.68, text: "ocak." }, "times and text parse");
  assert.equal(speechEndSeconds(words, "Korkma, ocak."), 7.68, "the end of the last intended word");
  assert.equal(speechEndSeconds(words, "Korkma, OCAK"), 7.68, "case and punctuation do not matter");
  const glued = [{ start: 4, end: 5, text: "ocakta." }];
  assert.ok(
    Math.abs(speechEndSeconds(glued, "son ocak.") - (4 + 1 * (4 / 6))) < 1e-9,
    "extra syllables glued on a word cut proportionally inside it",
  );
  assert.equal(speechEndSeconds(words, "Korkma, bambaşka"), null, "no match leaves the audio alone");
  // An earlier identical word must not be mistaken for the end when the real last word was misheard.
  const early = [
    { start: 0, end: 1, text: "ocak" },
    { start: 1, end: 2, text: "bir" },
    { start: 2, end: 3, text: "iki" },
    { start: 3, end: 4, text: "üç" },
  ];
  assert.equal(speechEndSeconds(early, "ocak"), null, "only the last three words are considered");
}

// wa_edit/wa_delete must not touch Burak's own phone-typed messages, which are `direction: "out"`
// exactly like Claude's — the `by` tag is the only thing separating them.
const { guardOwnMessage } = await import("./src/server.mjs");
const {
  appendMessage,
  readRecent,
  messageCount,
  searchMessages,
  archiveOldMessages,
  findMessage,
  chatStats,
  participantStats,
  threadOf,
  unansweredChats,
  normalizeForSearch,
} = await import("./src/store.mjs");
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
    ai: "/ai off",
    incognito: "/incognito on",
    generate: "/generate --prompt x",
    memory: "/memory",
    forget: "/forget 3",
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

// Diacritic folding, which case folding alone never gave: a query typed on an English keyboard has
// to find Turkish text. Measured behaviour, not assumption — FTS5's trigram tokeniser case-folds
// Turkish correctly by itself but does no diacritic folding at all, so these all failed before
// normalizeForSearch existed, under LIKE and under a naive FTS index alike.
assert.equal(searchMessages([FAKE], "seker", 10).length, 1, "ASCII query finds Turkish text (ş)");
assert.equal(searchMessages([FAKE], "istanbul", 10).length, 1, "ASCII query finds Turkish text (İ)");
appendMessage(FAKE, { direction: "in", text: "ısırdı ve ĞIDI", ts: 9100, id: "TR2" });
assert.equal(searchMessages([FAKE], "isirdi", 10).length, 1, "dotless ı folds to i");
assert.equal(searchMessages([FAKE], "gidi", 10).length, 1, "ğ folds to g");
assert.equal(normalizeForSearch("Straße"), "strasse", "ß folds to ss, matching its uppercase form");

// Substring matching, which the trigram tokeniser preserves and a word-based one would not. This is
// the assertion that fails if anyone ever switches the index to unicode61.
assert.equal(searchMessages([FAKE], "eke", 10).length, 1, "a fragment inside a word still matches");

// Below the trigram index's three-character floor the LIKE path takes over. Both paths must fold
// identically, or a two-character query would behave differently from a three-character one.
assert.ok(
  searchMessages([FAKE], "se", 10).some((m) => m.id === "TR1"),
  "short query falls back to LIKE and still folds ş→s",
);

// FTS5 MATCH takes a query expression, so an unescaped needle is a syntax error or a different
// search than the one asked for. Message text is attacker-controlled, and so is anything the model
// can be talked into searching for.
for (const hostile of ['a" OR 1', "foo*", "NEAR(a b)", "((", "a:b", '""', "\\"]) {
  assert.doesNotThrow(() => searchMessages([FAKE], hostile, 10), `hostile query must not throw: ${hostile}`);
}

// Stats. Reactions and edits are not turns in a conversation and must not be counted as messages.
const STATS = "905000000000@s.whatsapp.net";
const H = 60 * 60 * 1000;
const base = Date.UTC(2026, 0, 5, 12, 0, 0); // a Monday, midday
appendMessage(STATS, { direction: "in", text: "soru", ts: base, id: "S1" });
appendMessage(STATS, { direction: "out", text: "cevap", ts: base + 10 * 60 * 1000, id: "S2" });
appendMessage(STATS, { direction: "out", by: "claude", kind: "reaction", text: "👀", to: "S1", ts: base + 1000 });
appendMessage(STATS, { direction: "in", text: "yeni konu", ts: base + 9 * H, id: "S3" });
const st = chatStats(STATS);
assert.equal(st.total, 3, "reactions are excluded from the message count");
assert.equal(st.inbound, 2);
assert.equal(st.outbound, 1);
assert.equal(st.medianReplyMinutes.out, 10, "reply time measures a direction change, in minutes");
assert.equal(st.replySamples.in, 0, "a 9-hour gap is a new conversation, not a slow reply");
assert.equal(st.conversationsStarted.byThem, 2, "both the first message and the one after the gap");
assert.equal(st.lastDirection, "in");
assert.equal(
  st.byHour.reduce((a, b) => a + b, 0),
  3,
  "every counted message lands in exactly one hour bucket",
);
assert.equal(chatStats("999@s.whatsapp.net").total, 0, "a chat with no messages reports zero, not a crash");

// The upper bound, which is what makes a weekly report able to say "down from 7" rather than just
// printing a number. Without it there is no way to ask for a window that has already closed.
assert.equal(chatStats(STATS, base, base + 5 * 60 * 1000).total, 1, "untilMs excludes the reply 10 minutes later");
assert.equal(chatStats(STATS, base, base + 11 * 60 * 1000).total, 2, "widening the window includes it");
assert.equal(chatStats(STATS, base + 9 * H).total, 1, "sinceMs still bounds the other end");
assert.equal(chatStats(STATS, base, base).total, 0, "an empty window is empty, not everything");

// Unanswered: their message, last in the chat, older than the threshold.
assert.deepEqual(
  unansweredChats([STATS], 1 * H).map((c) => c.jid),
  [STATS],
  "a chat whose last message is theirs and stale is surfaced",
);
appendMessage(STATS, { direction: "out", text: "pardon geç gördüm", ts: Date.now(), id: "S4" });
assert.deepEqual(unansweredChats([STATS], 1 * H), [], "answering it takes it off the list");

// Baileys reports a lost inbound message by logging it and carrying on — no event, no throw, and
// the message never reaches messages.upsert. The log stream is therefore the only place a drop is
// observable, so this asserts the detector reads it. Setting the notifier here also replaces the
// one server.mjs installed, which keeps these synthetic lines out of the real inbox feed.
//
// Child loggers are asserted deliberately: Baileys logs through `logger.child(...)` internally, and
// a detector that only saw the parent would miss every real drop while passing a naive test.
{
  const { logger: waLogger, setDropNotifier } = await import("./src/whatsapp.mjs");
  const seen = [];
  setDropNotifier((msg, jids) => seen.push([msg, jids]));
  waLogger.error({ key: { remoteJid: "1@lid", remoteJidAlt: "2@s.whatsapp.net" } }, "failed to decrypt message");
  waLogger.child({ class: "baileys" }).error({}, "unexpected error in 'processing offline notification'");
  waLogger.warn({}, "an ordinary warning that is not a dropped message");
  assert.equal(seen.length, 2, "only drop signatures are reported, not every warning");
  assert.ok(
    seen.some(([m]) => m.includes("processing offline notification")),
    "a drop logged through a child logger is still caught",
  );
  // server.mjs's setDropNotifier callback decides relevance from these -- whatsapp.mjs's own job
  // ends at handing up whatever candidates the log line actually carried, in the order found.
  const [, decryptJids] = seen.find(([m]) => m.includes("failed to decrypt")) ?? [];
  assert.deepEqual(
    decryptJids,
    ["1@lid", "2@s.whatsapp.net"],
    "a per-message drop hands up both the @lid and phone-number form of its key",
  );
  const [, batchJids] = seen.find(([m]) => m.includes("processing offline notification")) ?? [];
  assert.deepEqual(batchJids, [], "a batch-level drop (no single message's key) hands up no candidates, not a guess");

  // The rc14 group leave/remove stub bug: a SyntaxError out of process-message.js's JSON.parse,
  // logged under the same "handling notification" text as a real loss. It must not alert, but the
  // same text with any other cause must, or the filter would hide genuine drops.
  seen.length = 0;
  const stubErr = new SyntaxError("Unexpected non-whitespace character after JSON at position 14");
  stubErr.stack =
    "SyntaxError: Unexpected non-whitespace character after JSON at position 14\n    at JSON.parse (<anonymous>)\n    at file:///x/baileys/lib/Utils/process-message.js:510:78";
  waLogger.child({ class: "baileys" }).error(stubErr, "unexpected error in 'handling notification'");
  assert.equal(seen.length, 0, "the group-stub JSON.parse bug is not reported as a lost message");
  const otherErr = new Error("boom");
  otherErr.stack = "Error: boom\n    at handleNotification (file:///x/baileys/lib/Socket/messages-recv.js:1:1)";
  waLogger.child({ class: "baileys" }).error(otherErr, "unexpected error in 'handling notification'");
  assert.equal(seen.length, 1, "the same log text from any other cause is still a reported drop");
}

// Per-sender breakdown of a group. chatStats splits a chat into you-and-everyone-else, which is
// right for a DM and useless for a group of five.
{
  const G = "120363000000000001@g.us";
  const t0 = Date.UTC(2026, 0, 5, 12, 0, 0);
  appendMessage(G, { direction: "in", text: "a", ts: t0, id: "G1", from: "111@s.whatsapp.net", name: "Ali" });
  appendMessage(G, { direction: "in", text: "b", ts: t0 + 60_000, id: "G2", from: "111@s.whatsapp.net", name: "Ali" });
  appendMessage(G, {
    direction: "in",
    text: "c",
    ts: t0 + 120_000,
    id: "G3",
    from: "222@s.whatsapp.net",
    name: "Veli",
  });
  appendMessage(G, { direction: "out", text: "d", ts: t0 + 180_000, id: "G4" });
  // Reactions are not turns in a conversation and must not inflate anyone's count.
  appendMessage(G, {
    direction: "in",
    kind: "reaction",
    text: "👀",
    to: "G1",
    ts: t0 + 5000,
    from: "222@s.whatsapp.net",
  });

  const { participants, total } = participantStats(G);
  assert.equal(total, 4, "reactions excluded from the group total");
  assert.deepEqual(
    participants.map((p) => [p.who, p.messages]),
    [
      ["111@s.whatsapp.net", 2],
      ["222@s.whatsapp.net", 1],
      ["(you)", 1],
    ],
    "one row per sender, busiest first, own messages as their own bucket",
  );
  assert.equal(participants[0].name, "Ali", "pushName is carried as a label");

  // The same person arriving from a second linked device carries a :N suffix. Counting that as a
  // separate participant split a real group member into a 212-message person and a 1-message ghost.
  const G2 = "120363000000000002@g.us";
  appendMessage(G2, { direction: "in", text: "a", ts: t0, id: "H1", from: "111@s.whatsapp.net", name: "Ali" });
  appendMessage(G2, { direction: "in", text: "b", ts: t0 + 1000, id: "H2", from: "111:0@s.whatsapp.net", name: "Ali" });
  appendMessage(G2, { direction: "in", text: "c", ts: t0 + 2000, id: "H3", from: "111:18@s.whatsapp.net" });
  const merged = participantStats(G2).participants;
  assert.equal(merged.length, 1, "one human, not three, however many devices they message from");
  assert.equal(merged[0].who, "111@s.whatsapp.net", "reported under the device-less jid");
  assert.equal(merged[0].messages, 3, "and their messages are summed");
  assert.equal(participants[0].share, 50, "share is a percentage of the group total");
  assert.equal(participants[0].started, 1, "the first message after a gap counts as a conversation start");
  assert.equal(participants[1].started, 0, "a reply mid-conversation does not");
  assert.deepEqual(participantStats("120363000000000009@g.us"), { total: 0, participants: [] }, "empty group is empty");
}

// Poll persistence. What is under test here is our own bookkeeping (the secret survives, the
// reconstructed message is the shape Baileys' decrypt functions need, an unknown poll no-ops) — not
// the vote decryption itself, which is Baileys' own crypto and not something worth re-testing here.
{
  const { savePoll, getPoll, pollCreationMessageFor, saveTally, renderTally } = await import("./src/polls.mjs");
  const secret = Buffer.from("0".repeat(64), "hex"); // 32 bytes, fixed so the round-trip is exact

  savePoll("999@s.whatsapp.net", "P1", {
    name: "Hangi renk?",
    values: ["kırmızı", "mavi"],
    selectableCount: 1,
    secret,
  });
  const entry = getPoll("P1");
  assert.equal(entry.name, "Hangi renk?");
  assert.deepEqual(entry.values, ["kırmızı", "mavi"]);
  assert.equal(entry.tally, null, "no votes yet");
  assert.equal(getPoll("nonexistent"), null, "an unknown poll id is null, not a throw");

  // The exact shape Baileys' getAggregateVotesInPollMessage/decryptPollVote need back: options as
  // {optionName}, and the secret as a real Buffer (not the base64 string it is persisted as) inside
  // messageContextInfo, which is where Baileys itself puts it on a message it sends.
  const reconstructed = pollCreationMessageFor(entry);
  assert.deepEqual(reconstructed.pollCreationMessage.options, [{ optionName: "kırmızı" }, { optionName: "mavi" }]);
  assert.ok(Buffer.isBuffer(reconstructed.messageContextInfo.messageSecret), "secret round-trips as a Buffer");
  assert.ok(
    reconstructed.messageContextInfo.messageSecret.equals(secret),
    "and the exact bytes survive base64 round-trip",
  );

  assert.equal(renderTally(entry), "[poll] Hangi renk? — no votes yet");
  saveTally("P1", [
    { name: "kırmızı", voters: ["a@s.whatsapp.net"] },
    { name: "mavi", voters: [] },
  ]);
  assert.equal(
    renderTally(getPoll("P1")),
    "[poll] Hangi renk? — kırmızı: 1, mavi: 0",
    "tally renders per-option vote counts",
  );

  // The wake line a vote writes to inbox.log: only options holding votes are named, and an empty
  // tally reads as a withdrawn vote rather than as an answer.
  const { voteWakeLine } = await import("./src/polls.mjs");
  assert.equal(
    voteWakeLine(getPoll("P1"), getPoll("P1").tally),
    "Hangi renk? → kırmızı",
    "a vote names the chosen option, not every option",
  );
  assert.equal(
    voteWakeLine(getPoll("P1"), [
      { name: "kırmızı", voters: [] },
      { name: "mavi", voters: [] },
    ]),
    "Hangi renk? → vote withdrawn",
    "a tally with no voters reads as a withdrawn vote",
  );

  // A vote update for a poll this server never created (or created before this feature existed)
  // must be a silent no-op, not an attempt to write into an entry that doesn't exist.
  saveTally("never-created", [{ name: "x", voters: ["a"] }]);
  assert.equal(getPoll("never-created"), null, "tallying an unknown poll id creates nothing");

  // Vote decryption, done here because Baileys rc14 stopped doing it. A vote is built exactly the way
  // WhatsApp builds one (HKDF-style key from the secret plus creator and voter JIDs, AES-GCM with the
  // poll id and voter as AAD), encrypted under the @lid form of the voter, and must still decrypt:
  // the phone may use either identity form and nothing in the message says which.
  {
    const { decryptVote, saveVote } = await import("./src/polls.mjs");
    const { aesEncryptGCM, hmacSign, proto } = await import("@whiskeysockets/baileys");
    const { createHash, randomBytes } = await import("node:crypto");
    const sha = (t) => createHash("sha256").update(Buffer.from(t)).digest();
    const me = "999@s.whatsapp.net";
    const meLid = "888@lid";
    const encryptVote = (creatorJid, voterJid, names) => {
      const encIv = randomBytes(12);
      const sign = Buffer.concat([
        Buffer.from("P1"),
        Buffer.from(creatorJid),
        Buffer.from(voterJid),
        Buffer.from("Poll Vote"),
        new Uint8Array([1]),
      ]);
      const decKey = hmacSign(sign, hmacSign(secret, new Uint8Array(32), "sha256"), "sha256");
      const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: names.map(sha) }).finish();
      return { encIv, encPayload: aesEncryptGCM(plain, decKey, encIv, Buffer.from(`P1\u0000${voterJid}`)) };
    };
    const creationKey = { id: "P1", fromMe: true, remoteJid: me };
    const voteKey = { fromMe: true, remoteJid: me };

    const viaPn = decryptVote(getPoll("P1"), {
      creationKey,
      voteKey,
      vote: encryptVote(me, me, ["mavi"]),
      meIds: [me, meLid],
    });
    assert.deepEqual(viaPn?.hashes, [sha("mavi").toString("hex")], "a vote under the phone-number identity decrypts");
    const viaLid = decryptVote(getPoll("P1"), {
      creationKey,
      voteKey,
      vote: encryptVote(meLid, meLid, ["mavi"]),
      meIds: [me, meLid],
    });
    assert.equal(
      viaLid?.voterJid,
      me,
      "a vote under the @lid identity decrypts, and is recorded under one stable identity for the account",
    );
    assert.equal(
      decryptVote(getPoll("P1"), {
        creationKey,
        voteKey,
        vote: encryptVote("777@s.whatsapp.net", "777@s.whatsapp.net", ["mavi"]),
        meIds: [me, meLid],
      }),
      null,
      "a vote under no known identity is refused rather than decrypted to garbage",
    );

    // Changing an answer replaces it, an older vote arriving late never overwrites a newer one.
    saveVote("P1", me, [sha("kırmızı").toString("hex")], 1000);
    saveVote("P1", me, [sha("mavi").toString("hex")], 2000);
    assert.deepEqual(
      getPoll("P1").tally.map((t) => [t.name, t.voters.length]),
      [
        ["kırmızı", 0],
        ["mavi", 1],
      ],
      "a changed answer counts once, for the new option",
    );
    assert.equal(
      saveVote("P1", me, [sha("kırmızı").toString("hex")], 1500),
      null,
      "a stale earlier vote changes nothing and reports nothing, so it cannot wake a session",
    );
    assert.equal(getPoll("P1").tally[1].voters.length, 1, "a stale earlier vote does not overwrite a newer one");
    assert.equal(
      saveVote("P1", me, [sha("mavi").toString("hex")], 2000),
      null,
      "the same vote redelivered changes nothing and reports nothing",
    );
    // The same account voting under two identities is one voter: an earlier vote stored under the
    // @lid form is replaced by the newer one under the phone-number form, not counted beside it.
    saveVote("P1", meLid, [sha("kırmızı").toString("hex")], 1000);
    const merged = saveVote("P1", me, [sha("mavi").toString("hex")], 2500, [me, meLid]);
    assert.deepEqual(
      merged?.map((t) => [t.name, t.voters.length]),
      [
        ["kırmızı", 0],
        ["mavi", 1],
      ],
      "one account under two identities counts once, for its newest answer",
    );
    assert.equal(
      saveVote("P1", me, [sha("mavi").toString("hex")], 3000, [me, meLid]),
      null,
      "re-sending an unchanged choice is not news",
    );
    // A poll whose creationKey is not flagged fromMe still decrypts: every stored poll is ours.
    const unflagged = decryptVote(getPoll("P1"), {
      creationKey: { id: "P1", remoteJid: me },
      voteKey,
      vote: encryptVote(me, me, ["kırmızı"]),
      meIds: [me, meLid],
    });
    assert.deepEqual(unflagged?.hashes, [sha("kırmızı").toString("hex")], "creator identity falls back to our own");
  }

  // The regression this module exists to prevent: readAll's {} fallback on a parse failure is safe
  // for a read, but savePoll/saveTally do read-modify-write, and writing that {} back with one new
  // entry added would silently erase every other poll's secret sitting in the part that failed to
  // parse — permanent, since a poll's secret cannot be regenerated once WhatsApp already has it.
  const pollsFile = process.env.WA_POLLS_PATH;
  const corrupt = "{ this is not valid json";
  writeFileSync(pollsFile, corrupt);
  assert.throws(
    () => savePoll("999@s.whatsapp.net", "P2", { name: "x", values: ["a", "b"], secret }),
    /unparseable/,
    "savePoll refuses to write over a corrupt file rather than silently replacing it",
  );
  assert.equal(
    readFileSync(pollsFile, "utf8"),
    corrupt,
    "the file on disk is untouched — this is the actual regression: P1's secret must not have been erased",
  );
  assert.throws(() => saveTally("P1", [{ name: "x", voters: [] }]), /unparseable/, "saveTally refuses the same way");
  // Reads, unlike writes, are allowed to degrade — a corrupt file makes a read look like "not
  // found" rather than blocking every poll-related call until someone fixes the file by hand.
  assert.equal(getPoll("P1"), null, "a read against a corrupt file returns null, not a throw");
}

// Thread reconstruction. The shape under test is a branching chain, because a message can have
// several replies and each of those its own — a walk that only followed one would look correct on a
// straight-line conversation and silently lose half of a real one.
{
  const T = "905111111111@s.whatsapp.net";
  //  A ── B ── D
  //    └── C
  //  Z is a separate message in the same chat, and must not be pulled in.
  appendMessage(T, { direction: "in", text: "A", ts: 1000, id: "A" });
  appendMessage(T, { direction: "out", text: "B", ts: 2000, id: "B", replyToId: "A" });
  appendMessage(T, { direction: "in", text: "C", ts: 3000, id: "C", replyToId: "A" });
  appendMessage(T, { direction: "out", text: "D", ts: 4000, id: "D", replyToId: "B" });
  appendMessage(T, { direction: "in", text: "Z", ts: 5000, id: "Z" });

  const ids = (id) => threadOf(T, id).map((m) => m.id);
  assert.deepEqual(ids("A"), ["A", "B", "C", "D"], "from the root, every branch is followed forward");
  assert.deepEqual(ids("D"), ["A", "B", "C", "D"], "from a leaf, it walks back up and then out again");
  assert.deepEqual(ids("C"), ["A", "B", "C", "D"], "and from a sibling branch");
  assert.ok(!ids("A").includes("Z"), "an unrelated message in the same chat stays out");
  assert.deepEqual(ids("Z"), ["Z"], "a message with no replies is a thread of one");
  assert.deepEqual(threadOf(T, "nonexistent"), [], "an unknown id is empty, not a crash");

  // A reply pointing at a message this server never logged (sent before it was watching) must end
  // the walk rather than looping or throwing.
  appendMessage(T, { direction: "in", text: "orphan", ts: 6000, id: "ORPH", replyToId: "NEVER_SEEN" });
  assert.deepEqual(ids("ORPH"), ["ORPH"], "a chain leaving the log stops cleanly");
  // A message claiming to reply to itself would loop forever without the seen-set guard.
  appendMessage(T, { direction: "in", text: "loop", ts: 7000, id: "LOOP", replyToId: "LOOP" });
  assert.deepEqual(ids("LOOP"), ["LOOP"], "a self-referential reply terminates");
}

// Server-side scheduling. `now` is injected rather than read from the clock so these assert real
// behaviour instead of whatever time the suite happens to run at. Thursday 17 Sep 2026, local time,
// because the weekday filter is one of the things that has to be right.
{
  const { dueTasks, validateTask, upsertTask, removeTask, loadSchedule, markRan, ackTask } =
    await import("./src/schedule.mjs");
  const at = (h, m) => new Date(2026, 8, 17, h, m, 0, 0).getTime();
  const THURSDAY = 4;
  assert.equal(new Date(at(12, 0)).getDay(), THURSDAY, "sanity: the fixture date really is a Thursday");

  const digest = { id: "daily-digest", at: "10:03", prompt: "send the digest" };
  assert.equal(dueTasks([digest], at(11, 0)).length, 1, "a task whose time has passed today is due");
  assert.equal(dueTasks([digest], at(9, 0)).length, 0, "...but not before its time");
  // The reason catch-up exists: the machine being asleep at 10:03 should not cost you the digest.
  assert.equal(dueTasks([digest], at(12, 2)).length, 1, "still due 119 minutes late, inside the catch-up window");
  assert.equal(dueTasks([digest], at(12, 4)).length, 0, "but not 121 minutes late, which is just confusing");
  assert.equal(
    dueTasks([{ ...digest, catchUpMinutes: 10 }], at(10, 30)).length,
    0,
    "catchUpMinutes narrows the window",
  );

  // The double-fire guard. lastRun holds the occurrence it ran for, so a check a minute later must
  // not fire it again — this is what the session-scoped cron got wrong by firing on wall clock.
  assert.equal(dueTasks([{ ...digest, lastRun: at(10, 3) }], at(11, 0)).length, 0, "already ran for this occurrence");
  assert.equal(
    dueTasks([{ ...digest, lastRun: at(10, 3) - 86_400_000 }], at(11, 0)).length,
    1,
    "yesterday's run does not satisfy today's",
  );

  // Fired but not picked up by a session: it fires again every 20 minutes until acknowledged. A task
  // without the pendingAck mark (one that ran before this existed) keeps the old fire-once behaviour.
  const fired = { ...digest, lastRun: at(10, 3), lastRanAt: at(10, 3), pendingAck: true };
  assert.equal(dueTasks([fired], at(10, 20)).length, 0, "not re-fired 17 minutes after firing");
  assert.equal(dueTasks([fired], at(10, 24)).length, 1, "re-fired once 20 minutes pass with no acknowledgement");
  assert.equal(dueTasks([{ ...fired, pendingAck: false }], at(11, 0)).length, 0, "acknowledged tasks stop re-firing");
  assert.equal(dueTasks([{ ...fired, pendingAck: undefined }], at(11, 0)).length, 0, "old-style tasks never retry");
  assert.equal(dueTasks([fired], at(12, 30)).length, 0, "and retries stop when the catch-up window closes");

  assert.equal(
    dueTasks([{ ...digest, days: [THURSDAY] }], at(11, 0)).length,
    1,
    "weekday filter lets Thursday through",
  );
  assert.equal(dueTasks([{ ...digest, days: [1, 2] }], at(11, 0)).length, 0, "and keeps other days out");
  assert.equal(dueTasks([{ ...digest, enabled: false }], at(11, 0)).length, 0, "disabled tasks never fire");

  // A malformed task must be inert, not an exception — one bad entry cannot be allowed to stop
  // every other scheduled task from running.
  assert.doesNotThrow(() => dueTasks([{ id: "bad", at: "25:00", prompt: "x" }], at(11, 0)));
  assert.equal(dueTasks([{ id: "bad", at: "25:00", prompt: "x" }], at(11, 0)).length, 0, "invalid time never fires");
  assert.match(validateTask({ id: "x", at: "9:00", prompt: "p" }), /HH:MM/, "single-digit hour is rejected");
  assert.match(validateTask({ id: "x", at: "10:03", days: [7], prompt: "p" }), /0-6/, "weekday 7 is rejected");
  assert.equal(validateTask({ id: "x", at: "10:03", prompt: "p" }), null, "a well-formed task validates");

  // Persistence: the whole point is surviving a restart.
  assert.ok(upsertTask(digest).task, "task is stored");
  assert.equal(loadSchedule().length, 1);
  assert.match(upsertTask({ id: "nope", at: "99:99", prompt: "p" }).error, /HH:MM/, "invalid tasks are refused");
  assert.equal(loadSchedule().length, 1, "and not written");
  markRan("daily-digest", at(10, 30));
  assert.equal(loadSchedule()[0].lastRun, at(10, 3), "markRan records the occurrence, not the wall clock it fired at");
  assert.equal(loadSchedule()[0].pendingAck, true, "a fired task waits for a session to acknowledge it");
  assert.equal(ackTask("daily-digest"), true, "acknowledging a known task works");
  assert.equal(ackTask("no-such-task"), false, "acknowledging an unknown task reports it");
  assert.equal(loadSchedule()[0].pendingAck, false, "and clears the wait");
  // Editing a task must not resurrect an occurrence that already ran, or a prompt tweak at 11:00
  // would send a second digest.
  upsertTask({ id: "daily-digest", at: "10:03", prompt: "reworded" });
  assert.equal(loadSchedule()[0].lastRun, at(10, 3), "editing preserves lastRun");
  assert.equal(dueTasks(loadSchedule(), at(11, 0)).length, 0, "so the edited task does not re-fire today");
  assert.equal(removeTask("daily-digest"), true);
  assert.equal(removeTask("daily-digest"), false, "removing a missing task reports it rather than throwing");
}

// Link enrichment. Deliberately no network here: a unit suite that reaches the internet is a suite
// that fails on a train. The SSRF cases below use literal IPs, which are rejected before any
// lookup, so they assert the guard rather than the absence of a connection.
{
  const { extractUrls, fetchLinkInfo, renderLinkInfo } = await import("./src/linkinfo.mjs");

  assert.deepEqual(extractUrls("bak https://x.com/a/status/123?s=48 buna"), ["https://x.com/a/status/123?s=48"]);
  assert.deepEqual(extractUrls("no links here"), [], "text without a url yields nothing to fetch");
  assert.deepEqual(extractUrls(null), [], "a media row with null text must not throw");
  // Trailing punctuation is far likelier to end a sentence than a URL.
  assert.deepEqual(extractUrls("see https://a.com/x."), ["https://a.com/x"], "trailing period is trimmed");
  assert.deepEqual(extractUrls("(https://a.com/x)"), ["https://a.com/x"], "a wrapping paren is trimmed");
  assert.equal(extractUrls("https://a.com/1 https://b.com/2 https://c.com/3").length, 2, "capped per message");
  assert.deepEqual(extractUrls("https://a.com/x and https://a.com/x again"), ["https://a.com/x"], "deduplicated");

  // A link is untrusted input from whoever is in the chat, so it is an instruction to make this
  // server issue a request. These must never leave the machine.
  for (const blocked of [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata, the classic target
    "http://127.0.0.1:8080/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "file:///etc/passwd",
    "ftp://example.com/x",
  ]) {
    assert.equal(await fetchLinkInfo(blocked), null, `must refuse ${blocked}`);
  }

  // Outbound previews are built here rather than by Baileys, so the no-link and refused-link cases
  // must come back null and let the send proceed without a preview, never throw into it.
  const { buildUrlInfo } = await import("./src/linkinfo.mjs");
  assert.equal(await buildUrlInfo("no link in this message"), null, "nothing to preview is not an error");
  assert.equal(await buildUrlInfo("http://169.254.169.254/"), null, "a refused link yields no preview");

  // Routed to oEmbed rather than scraped: YouTube pads its <head> past 260KB, so the page read hit
  // the byte cap before ever reaching <title> and every YouTube link enriched to nothing. Caught in
  // the wild — someone answered a message with a clip whose title *was* the joke, and it was lost.
  const { youtubeUrlForTest } = await import("./src/linkinfo.mjs");
  for (const yt of [
    "https://www.youtube.com/watch?v=bzZ9LyAMdNY",
    "https://youtu.be/bzZ9LyAMdNY",
    "https://m.youtube.com/watch?v=x",
    "https://www.youtube.com/shorts/abc",
  ]) {
    assert.ok(youtubeUrlForTest(yt), `${yt} must take the oEmbed path`);
  }
  assert.ok(!youtubeUrlForTest("https://youtube.example.com/watch?v=x"), "a lookalike host does not");

  assert.equal(renderLinkInfo(null), null, "a failed fetch renders nothing rather than an empty marker");
  assert.equal(renderLinkInfo({ site: "x.com", title: "@a", description: "" }), "[link: x.com] @a");
  assert.equal(
    renderLinkInfo({ site: "x.com", title: "@a", description: "hi" }),
    "[link: x.com] @a\nhi",
    "description goes on its own line, and the marker names the source like [text in image] does",
  );
}

// The daemon/shim split. What is asserted is the part that can fail without anyone noticing: that a
// wrong token is refused, that a real MCP client's traffic round-trips through shim -> socket ->
// McpServer, and that a daemon restart is invisible to the client (initialize is replayed, the tool
// list is refreshed, a call made afterwards works) instead of leaving it talking to a dead pipe.
{
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { connect: netConnect } = await import("node:net");
  const { PassThrough } = await import("node:stream");
  const { serveOnSocket, loadOrCreateDaemonToken } = await import("./src/daemon-transport.mjs");
  const { runShim } = await import("./src/shim.mjs");

  const dir = mkdtempSync(join(tmpdir(), "wa-d-"));
  const path = join(dir, "d.sock");
  const tokenPath = join(dir, "d.token");
  const token = loadOrCreateDaemonToken(tokenPath);
  assert.equal(loadOrCreateDaemonToken(tokenPath), token, "the token is created once and then reused");

  const makeServer = (answer) => {
    const s = new McpServer({ name: "t", version: "0" });
    s.registerTool("ping", { description: "x", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: answer }],
    }));
    return s;
  };
  let daemon = await serveOnSocket(makeServer("one"), { path, token });

  const wait = async (cond, what) => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  // A connection with the wrong token must be closed without being served.
  const bad = netConnect(path);
  let badClosed = false;
  bad.on("close", () => (badClosed = true));
  bad.on("error", () => {});
  bad.write(JSON.stringify({ wa_daemon_auth: "nope" }) + "\n");
  await wait(() => badClosed, "the bad-token connection to be closed");

  // A second daemon must refuse to start over a live one rather than take its socket file.
  await assert.rejects(serveOnSocket(makeServer("x"), { path, token }), /already listening/);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  let buf = "";
  stdout.on("data", (c) => {
    buf += c.toString();
    let at;
    while ((at = buf.indexOf("\n")) !== -1) {
      out.push(JSON.parse(buf.slice(0, at)));
      buf = buf.slice(at + 1);
    }
  });
  const connect = () =>
    new Promise((resolve, reject) => {
      const s = netConnect(path);
      s.once("error", reject);
      s.once("connect", () => {
        s.off("error", reject);
        s.write(JSON.stringify({ wa_daemon_auth: token }) + "\n");
        resolve(s);
      });
    });
  const shim = runShim({ stdin, stdout, connect, retryMs: 50 });
  const send = (o) => stdin.write(JSON.stringify(o) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  await wait(() => out.some((m) => m.id === 1 && m.result), "initialize to be answered");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });
  await wait(() => out.some((m) => m.id === 2), "a tool call through the shim");
  assert.equal(out.find((m) => m.id === 2).result.content[0].text, "one", "a call round-trips shim -> daemon");

  // Restart the daemon underneath a client that never re-initializes.
  await daemon.close();
  daemon = await serveOnSocket(makeServer("two"), { path, token });
  await wait(() => out.some((m) => m.method === "notifications/tools/list_changed"), "the list_changed after restart");
  assert.ok(
    !out.some((m) => String(m.id ?? "").startsWith("wa-shim-reinit")),
    "the daemon's reply to the replayed initialize is swallowed, not shown to the client",
  );
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } });
  await wait(() => out.some((m) => m.id === 3), "a tool call after the daemon restarted");
  assert.equal(out.find((m) => m.id === 3).result.content[0].text, "two", "the restarted daemon serves the call");

  stdin.end();
  assert.equal(await shim, "closed", "a client that hangs up ends the shim normally");

  // A second authenticated client replaces the first. The first is told why before it is closed (so a
  // shim stops instead of reconnecting and displacing the new one in turn), and the new client must
  // keep working afterwards: closing the old connection must not detach the new one. The new
  // client also sends its auth line and its first request in a single write, which is the case a
  // line-at-a-time reader gets wrong.
  const rawClient = async (firstRequest) => {
    const c = netConnect(path);
    c.on("error", () => {});
    const seen = [];
    let acc = "";
    c.on("data", (d) => {
      acc += d.toString();
      let at;
      while ((at = acc.indexOf("\n")) !== -1) {
        seen.push(JSON.parse(acc.slice(0, at)));
        acc = acc.slice(at + 1);
      }
    });
    let closed = false;
    c.on("close", () => (closed = true));
    await new Promise((r) => c.once("connect", r));
    c.write(
      JSON.stringify({ wa_daemon_auth: token }) + "\n" + (firstRequest ? JSON.stringify(firstRequest) + "\n" : ""),
    );
    return { c, seen, isClosed: () => closed };
  };
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
  const first = await rawClient(initialize);
  await wait(() => first.seen.some((m) => m.id === 1), "the first client to be served");
  const second = await rawClient(initialize);
  await wait(() => second.seen.some((m) => m.id === 1), "the second client to be served");
  await wait(() => first.isClosed(), "the first client to be closed");
  assert.ok(
    first.seen.some((m) => m.wa_daemon_replaced),
    "a displaced client is told it was replaced",
  );
  second.c.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  second.c.write(
    JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ping", arguments: {} } }) + "\n",
  );
  await wait(() => second.seen.some((m) => m.id === 9), "a call from the client that replaced the first");
  assert.equal(
    second.seen.find((m) => m.id === 9).result.content[0].text,
    "two",
    "the replacing client keeps working after the old connection is closed",
  );
  second.c.destroy();

  // A shim told it was replaced stops with that result rather than reconnecting.
  const replacedShim = runShim({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    connect: async () => {
      const { Duplex } = await import("node:stream");
      const fake = new Duplex({
        read() {},
        write(_c, _e, cb) {
          cb();
        },
      });
      setTimeout(() => fake.push(JSON.stringify({ wa_daemon_replaced: true }) + "\n"), 20);
      setTimeout(() => fake.destroy(), 40);
      return fake;
    },
    retryMs: 20,
  });
  assert.equal(await replacedShim, "replaced", "a replaced shim exits instead of fighting for the connection");

  // A request queued while the daemon is unreachable is refused once the outage outlasts the limit,
  // instead of waiting forever.
  const downIn = new PassThrough();
  const downOut = new PassThrough();
  const downSeen = [];
  downOut.on("data", (d) =>
    downSeen.push(
      ...d
        .toString()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ),
  );
  const downShim = runShim({
    stdin: downIn,
    stdout: downOut,
    connect: async () => {
      throw new Error("down");
    },
    retryMs: 20,
    refuseAfterMs: 100,
    sweepMs: 50,
  });
  await new Promise((r) => setTimeout(r, 30));
  downIn.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ping" } }) + "\n");
  await wait(() => downSeen.some((m) => m.id === 5 && m.error), "a queued request to be refused during an outage");
  downIn.end();
  await downShim;

  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
}

// Delivery markup for voice notes: pauses and slow/fast spans, parsed outside the TTS engine.
{
  const { parseSpeechMarkup, stripSpeechMarkup, toSayText } = await import("./src/speech-markup.mjs");
  assert.deepEqual(
    parseSpeechMarkup("Merhaba [pause 700] dünya"),
    [
      { type: "speech", text: "Merhaba", scale: 1 },
      { type: "pause", ms: 700 },
      { type: "speech", text: "dünya", scale: 1 },
    ],
    "an explicit pause splits the speech",
  );
  assert.deepEqual(
    parseSpeechMarkup("tamam... gidiyorum").map((p) => p.type === "pause" && p.ms),
    [false, 450, false],
    "an ellipsis becomes an automatic beat",
  );
  const spans = parseSpeechMarkup("hızlı [slow]çok yavaş[/slow] normal");
  assert.deepEqual(
    spans.map((p) => p.scale),
    [1, 1.35, 1],
    "a slow span stretches only the text inside it",
  );
  assert.equal(parseSpeechMarkup("[pause 9999] a")[0].type, "speech", "a pause with nothing before it is dropped");
  assert.equal(
    parseSpeechMarkup("a [pause 2900] [pause 2900] b").find((p) => p.type === "pause").ms,
    3000,
    "pauses are merged and clamped to three seconds",
  );
  assert.equal(stripSpeechMarkup("bir [pause] iki [fast]üç[/fast]"), "bir iki üç", "stripping leaves only the words");
  assert.equal(toSayText("bir [pause 300] iki"), "bir [[slnc 300]] iki", "say gets its own silence command");
  assert.equal(
    parseSpeechMarkup("düz bir cümle").length,
    1,
    "plain text stays one segment, so it takes the unchanged path",
  );
  assert.deepEqual(
    parseSpeechMarkup("[slow]tamam[/slow]. [pause 400] .").map((p) => p.type),
    ["speech"],
    "a chunk of punctuation alone is dropped rather than handed to Piper, which fails on it",
  );
}

// Cloned voices and the XTTS client. A synthetic voice note has no text marker, so a clone of a real
// person's voice reaching the wrong chat could pass as them: the chat list is enforced at the send,
// there is no fallback to a different voice, and the service is only ever reached with the token.
{
  const { resolveClone } = await import("./src/voices.mjs");
  const { xttsRequest, xttsRender } = await import("./src/xtts-client.mjs");
  const { synthWav } = await import("./src/server.mjs");
  const { createServer } = await import("node:net");
  const dir = process.env.WA_VOICES_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alice.wav"), "RIFF");
  writeFileSync(
    join(dir, "voices.json"),
    JSON.stringify({ alice: { ref: "alice.wav", allowed_jids: ["31600000000@s.whatsapp.net"] } }),
  );
  assert.ok(resolveClone("alice", "31600000000@s.whatsapp.net").ref, "a listed chat may use the voice");
  assert.match(resolveClone("alice", "49170000000@s.whatsapp.net").error, /not allowed/, "an unlisted DM is refused");
  assert.match(resolveClone("alice", "120363000000000001@g.us").error, /not allowed/, "a group is refused");
  assert.match(resolveClone("nobody", "31600000000@s.whatsapp.net").error, /no cloned voice/, "an unknown name");
  // A voice that lists "*" is usable in any chat (the chat itself still has to pass guardSend).
  writeFileSync(
    join(dir, "voices.json"),
    JSON.stringify({ alice: { ref: "alice.wav", allowed_jids: ["31600000000@s.whatsapp.net", "*"] } }),
  );
  assert.ok(resolveClone("alice", "120363000000000001@g.us").ref, "a wildcard voice works in any chat");
  writeFileSync(
    join(dir, "voices.json"),
    JSON.stringify({ alice: { ref: "alice.wav", allowed_jids: ["31600000000@s.whatsapp.net"] } }),
  );
  assert.match(resolveClone("../etc/passwd", "x").error, /not a valid voice name/, "a path is not a voice name");
  // A chat can make a voice its default, but only where the voice is also allowed.
  const { defaultCloneFor } = await import("./src/voices.mjs");
  writeFileSync(
    join(dir, "voices.json"),
    JSON.stringify({
      alice: {
        ref: "alice.wav",
        allowed_jids: ["31600000000@s.whatsapp.net"],
        default_jids: ["31600000000@s.whatsapp.net", "49170000000@s.whatsapp.net"],
      },
    }),
  );
  assert.equal(defaultCloneFor("31600000000@s.whatsapp.net")?.name, "alice", "a listed chat gets its default voice");
  assert.equal(
    defaultCloneFor("49170000000@s.whatsapp.net"),
    null,
    "being a default chat is not enough, the voice must also be allowed there",
  );
  assert.equal(defaultCloneFor("120363000000000001@g.us"), null, "an unlisted chat has no default clone");
  writeFileSync(
    join(dir, "voices.json"),
    JSON.stringify({ escape: { ref: "../../etc/hosts", allowed_jids: ["31600000000@s.whatsapp.net"] } }),
  );
  assert.ok(
    resolveClone("escape", "31600000000@s.whatsapp.net").error,
    "a reference path that leaves the voices directory is refused",
  );

  // The client against a fake service: it sends the token, a refusal rejects, a hang times out.
  const sockPath = process.env.WA_XTTS_SOCK;
  let seen = null;
  let mode = "ok";
  const fake = createServer((c) => {
    let acc = "";
    c.on("data", (d) => {
      acc += d.toString();
      if (!acc.includes("\n")) return;
      seen = JSON.parse(acc);
      if (mode === "ok") c.end(JSON.stringify({ ok: true, seconds: 1 }) + "\n");
      else if (mode === "refuse") c.end(JSON.stringify({ ok: false, error: "bad token" }) + "\n");
      // "hang": never answer
    });
    c.on("error", () => {});
  });
  await new Promise((r) => fake.listen(sockPath, r));
  assert.deepEqual(await xttsRequest({ op: "ping" }), { ok: true, seconds: 1 }, "an answer resolves");
  assert.equal(seen.token, "t".repeat(64), "every request carries the daemon token");
  mode = "refuse";
  await assert.rejects(xttsRequest({ op: "ping" }), /refused: bad token/, "a refusal rejects");
  mode = "hang";
  await assert.rejects(
    xttsRequest({ op: "ping" }, { timeoutMs: 150 }),
    /timed out/,
    "a hung service cannot stall a chat",
  );
  await new Promise((r) => fake.close(r));
  await assert.rejects(
    xttsRender({ text: "x", lang: "tr", outWav: "/tmp/x.wav" }),
    "a service that is down rejects fast",
  );

  // A cloned voice never falls back to another voice when the service is down.
  await assert.rejects(
    synthWav("merhaba", undefined, 1, "tr", join(dir, "out.wav"), { clone: { ref: join(dir, "alice.wav") } }),
    /not falling back to another voice/,
    "a clone with the service down fails instead of speaking in a different voice",
  );
}

// One-off reminders: `once` fires at its moment, retries until acknowledged, then switches off.
{
  const { dueTasks, validateTask, upsertTask, loadSchedule, markRan, ackTask } = await import("./src/schedule.mjs");
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0, 0).getTime();
  const reminder = { id: "rem-test", once: "2026-10-23T18:00", prompt: "remind 120363000000000201@g.us: hali saha" };
  assert.equal(validateTask(reminder), null, "a once task is valid");
  assert.match(validateTask({ ...reminder, at: "10:00" }), /not both/, "not both at and once");
  assert.match(validateTask({ ...reminder, days: [1] }), /days only goes with at/);
  assert.match(validateTask({ ...reminder, once: "2026-02-31T10:00" }), /YYYY-MM-DD/, "a date that does not exist");
  assert.match(validateTask({ ...reminder, once: "23.10.2026 18:00" }), /YYYY-MM-DD/, "the wrong format");
  assert.equal(dueTasks([reminder], at(23, 17, 59)).length, 0, "not before its moment");
  assert.equal(dueTasks([reminder], at(23, 18, 1)).length, 1, "due at its moment");
  assert.equal(dueTasks([reminder], at(24, 18, 1)).length, 0, "and not the next day");
  assert.equal(dueTasks([reminder], at(22, 18, 1)).length, 0, "nor the day before");

  upsertTask(reminder);
  markRan("rem-test", at(23, 18, 1));
  const fired = loadSchedule().find((t) => t.id === "rem-test");
  assert.equal(fired.lastRun, at(23, 18, 0), "lastRun is the reminder's own moment");
  assert.equal(dueTasks([fired], at(23, 18, 30)).length, 1, "it retries while nobody has picked it up");
  ackTask("rem-test");
  const done = loadSchedule().find((t) => t.id === "rem-test");
  assert.equal(done.enabled, false, "an acknowledged reminder is switched off");
  assert.equal(dueTasks([done], at(23, 18, 40)).length, 0, "and never fires again");

  // Turning a reminder into a daily task drops `once`, so it cannot carry both.
  upsertTask({ id: "rem-test", at: "09:00", once: undefined, prompt: "daily now" });
  const daily = loadSchedule().find((t) => t.id === "rem-test");
  assert.equal(daily.once, undefined, "the old once is gone");
  assert.equal(validateTask(daily), null);
}

// Memories: per chat, never across chats, no duplicates, a size limit, forget only in its own chat.
{
  const store = await import("./src/store.mjs");
  const { formatMemories, COMMANDS, contactAllowed, vcardFor } = await import("./src/server.mjs");
  const G = "120363000000000301@g.us";
  const H = "120363000000000302@g.us";
  const a = store.addMemory(G, "Selin", "kahveyi sekersiz icer");
  assert.ok(a.id, "a note is stored");
  assert.equal(store.addMemory(G, "selin", "Kahveyi sekersiz icer").duplicate, true, "the same note twice is one note");
  store.addMemory(G, null, "cumalari hali saha");
  store.addMemory(H, "Selin", "baska sohbetten bir not");
  assert.equal(store.listMemories(G).length, 2, "only this chat's notes");
  assert.equal(store.listMemories(G, "SELİN").length, 1, "about matches with case and diacritics folded");
  assert.ok(
    !store.listMemories(G).some((m) => m.text.includes("baska sohbetten")),
    "another chat's note never shows up",
  );
  assert.equal(store.forgetMemory(H, a.id), false, "an id from another chat deletes nothing");
  assert.equal(store.forgetMemory(G, a.id), true, "forget works in its own chat");
  assert.equal(store.listMemories(G).length, 1);
  assert.match(
    store.addMemory(G, null, "x".repeat(store.MAX_MEMORY_CHARS + 1)).error,
    /under/,
    "long notes are refused",
  );
  assert.match(store.addMemory(G, null, "   ").error, /empty/, "empty notes are refused");
  assert.match(formatMemories(store.listMemories(G)), /^#\d+ cumalari hali saha$/, "list format");
  assert.match(formatMemories([]), /kayitli bir sey yok/);

  assert.ok(COMMANDS.memory.test("/memory") && !COMMANDS.memory.test("/memory sil"), "/memory is anchored");
  assert.equal(COMMANDS.forget.exec("/forget 12")[1], "12");
  assert.ok(
    !COMMANDS.forget.test("/forget 12 (_Claude_)") && !COMMANDS.forget.test("/forget all"),
    "/forget is anchored",
  );

  // Contact cards only for numbers that chat already knows.
  const people = [{ who: "4915100000777@s.whatsapp.net" }, { who: "(you)" }];
  assert.ok(
    contactAllowed(G, "4915100000777", "491700000000:3@s.whatsapp.net", people),
    "someone who wrote in the chat",
  );
  assert.ok(contactAllowed(G, "491700000000", "491700000000:3@s.whatsapp.net", people), "the owner's own number");
  assert.ok(
    contactAllowed("4915100000888@s.whatsapp.net", "4915100000888", "491700000000:3@s.whatsapp.net", []),
    "a DM's own person",
  );
  assert.ok(!contactAllowed(G, "4915100000999", "491700000000:3@s.whatsapp.net", people), "anyone else is refused");
  assert.ok(!vcardFor("A;B\nC", "49151").includes("\nC"), "a name cannot break out of its vCard line");
  assert.match(vcardFor("Selin", "4915100000777"), /waid=4915100000777:\+4915100000777/);
}

// Receipts: their own table, highest status wins, and reads show them on the message.
{
  const store = await import("./src/store.mjs");
  const DM = "4915100000444@s.whatsapp.net";
  const GRP = "120363000000000401@g.us";
  store.appendMessage(DM, { direction: "out", by: "claude", text: "geldi mi", ts: 20, id: "R1" });
  store.recordReceipt(DM, "R1", "", 3, 21);
  assert.equal(store.findMessage(DM, "R1").receipt, "delivered");
  store.recordReceipt(DM, "R1", "", 4, 22);
  store.recordReceipt(DM, "R1", "", 3, 23);
  assert.equal(store.findMessage(DM, "R1").receipt, "read", "a late delivered never overwrites read");
  store.recordReceipt(DM, "R1", "", 1, 24);
  assert.equal(store.receiptsFor(DM, "R1").length, 1, "pending/server-ack statuses are not stored");

  store.appendMessage(GRP, { direction: "out", by: "claude", text: "herkese", ts: 30, id: "R2" });
  store.recordReceipt(GRP, "R2", "4915100000001@s.whatsapp.net", 4, 31);
  store.recordReceipt(GRP, "R2", "4915100000002@s.whatsapp.net", 3, 32);
  const g = store.findMessage(GRP, "R2");
  assert.deepEqual(g.readBy, ["4915100000001@s.whatsapp.net"], "who read it in a group");
  assert.equal(g.deliveredTo, 1, "and how many it only reached");
  assert.equal(store.readRecent(GRP, 50).filter((r) => r.kind).length, 0, "receipts never show up as rows");
}

// A message that failed to decrypt is only reported lost if it does not arrive within the wait.
{
  const { noteArrived, RECOVERY_WAIT_MS } = await import("./src/server.mjs");
  assert.ok(RECOVERY_WAIT_MS >= 10_000, "long enough for the phone to answer a resend request");
  assert.equal(noteArrived("never-pending"), false, "an ordinary message cancels nothing");
}

// handleIncoming end to end, with a fake socket: owner-only commands, the mention-only gate, the wake
// line, incognito, and other people's edits. Nothing here can reach the real state/ files (see the
// WA_*_PATH variables at the top) or a real connection.
{
  const { setSocketForTest } = await import("./src/whatsapp.mjs");
  const { handleIncoming, flushAllWakesForTest, isLive } = await import("./src/server.mjs");
  const store = await import("./src/store.mjs");
  writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP], mention_only_jids: [GROUP] }));
  const sent = [];
  let n = 0;
  setSocketForTest({
    user: { id: "491700000000:5@s.whatsapp.net" },
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: `FAKE${++n}` } };
    },
  });
  let seq = 0;
  const msg = (jid, text, { fromMe = false, participant, pushName = "Selin", extra = {} } = {}) => ({
    key: { remoteJid: jid, id: `IT${++seq}`, fromMe, ...(participant ? { participant } : {}) },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName,
    message: { conversation: text, ...extra },
  });
  const member = "4915100000555@s.whatsapp.net";

  // The owner's command replies, through the guards, and is stored.
  await handleIncoming(msg(DM, "/memory", { fromMe: true }));
  assert.equal(sent.length, 1, "the owner's /memory gets a reply");
  assert.match(sent[0].content.text, /kayitli bir sey yok/);
  assert.ok(store.findMessage(DM, "FAKE1"), "the reply is in the log");

  // Someone else typing a command is just a message: no reply, stored as text.
  await handleIncoming(msg(GROUP, "/memory", { participant: member }));
  assert.equal(sent.length, 1, "a group member cannot run commands");
  assert.equal(store.readRecent(GROUP, 5).at(-1).text, "/memory", "it is stored like any message");

  // Mention-only: an untagged message wakes nothing, a tagged one does, and the wake reaches inbox.log.
  await handleIncoming(msg(GROUP, "selam millet", { participant: member }));
  assert.ok(!isLive(GROUP), "an untagged message in a mention-only group wakes nothing");
  await handleIncoming(msg(GROUP, "@claude bir bakar misin", { participant: member }));
  assert.ok(isLive(GROUP), "a tag wakes the session");
  flushAllWakesForTest();
  const inbox = readFileSync(process.env.WA_INBOX_PATH, "utf8");
  assert.match(
    inbox,
    /\[120363001234567890@g\.us\].*\[tag\] @claude bir bakar misin/,
    "the wake line names the chat and the tag",
  );
  assert.ok(
    !inbox.includes("selam millet ||") && !/\] \(them\) Selin: selam millet/.test(inbox),
    "the untagged one never became its own wake",
  );

  // Incognito: nothing is stored while it is on.
  await handleIncoming(msg(DM, "/incognito on", { fromMe: true }));
  const before = store.messageCount(DM);
  await handleIncoming(msg(DM, "bunu kimse gormesin"));
  assert.equal(store.messageCount(DM), before, "an incognito chat stores nothing");
  await handleIncoming(msg(DM, "/incognito off", { fromMe: true }));

  // Someone else's edit lands as an edit of the original.
  const original = msg(GROUP, "yarin 19:00", { participant: member });
  await handleIncoming(original);
  await handleIncoming({
    key: { remoteJid: GROUP, id: `IT${++seq}`, fromMe: false, participant: member },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      protocolMessage: { type: 14, key: { id: original.key.id }, editedMessage: { conversation: "yarin 20:00" } },
    },
  });
  const edited = store.findMessage(GROUP, original.key.id);
  assert.equal(edited.editedText, "yarin 20:00", "the stored message reads as edited");

  setSocketForTest(null);
  writeFileSync(cfg, JSON.stringify({ allowlist: [DM, GROUP] }));
}

// Runs last: it deliberately exhausts the window, so anything after it would see a full budget.
// Starts from an empty window: earlier sections (the end-to-end one) send through the guard too.
(await import("./src/server.mjs")).resetSendLimitForTest();
let sent = 0;
while (!overSendLimit()) sent++;
assert.equal(sent, 20, "rate limit allows exactly 20 sends per minute, then refuses");

console.log(
  "ok — allowlist, media naming, command regexes, quotes, secret scan, edit/delete ownership guard, sendable-source guard, sqlite store, search folding, stats, threads, polls, message-type coverage, drop detection, scheduling, link enrichment, daemon and shim, and rate limit",
);
