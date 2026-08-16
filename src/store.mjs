import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { STATE_DIR } from "./config.mjs";

const POLL_STATE_FILE = join(STATE_DIR, "poll-state.json");
const ARCHIVE_AGE_DAYS = 30;
const INBOX_FILE = join(STATE_DIR, "inbox.log");
const CONTACTS_FILE = join(STATE_DIR, "contacts.json");
// Overridable so tests get a throwaway database instead of the real message history.
const DB_PATH = process.env.WA_DB_PATH ?? join(STATE_DIR, "messages.db");

// Columns for what is actually queried — chat, id, time, text, archived — and the whole original
// entry in `json` for everything else. Message shapes vary a lot (media, reactions, edits, quotes,
// replies), and a column per field would mean a migration every time a new kind of message is
// logged. This way the schema only has to know what the queries need.
let db;
function getDb() {
  if (db) return db;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // `timeout` is the busy timeout, and the default is 0 — a second writer throws "database is
  // locked" immediately rather than waiting. Two instances of this server routinely run at once
  // (see "Multiple sessions" in the README), and a collision inside appendMessage is swallowed by
  // safely(), so the message would be lost with only a log line. Five seconds is far longer than
  // any write here takes.
  db = new DatabaseSync(DB_PATH, { timeout: 5000 });
  // WAL so a read (wa_recent) never blocks on a concurrent write (an arriving message), which the
  // append-only files got for free and a rollback-journal database would not.
  db.exec("PRAGMA journal_mode = WAL");
  // SQLite's built-in lower() is ASCII-only: lower('ŞEKER') is 'Şeker', so a search for 'şeker'
  // silently missed it — in chats that are entirely Turkish. JS toLowerCase is full Unicode, so
  // the comparison is done with the same function on both sides.
  db.function("unicode_lower", (s) => (typeof s === "string" ? s.toLowerCase() : s));
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      rowid    INTEGER PRIMARY KEY,
      jid      TEXT NOT NULL,
      id       TEXT,
      ts       INTEGER NOT NULL,
      text     TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      json     TEXT NOT NULL,
      -- Derived from the blob rather than written separately, so appendMessage stays a plain
      -- insert and these can never drift out of step with the entry they describe. VIRTUAL means
      -- they cost nothing on disk; the indexes below are what make them worth having.
      -- media_kind: "image" | "voice" | "document" | "sticker", NULL for plain text.
      media_kind  TEXT GENERATED ALWAYS AS (json_extract(json, '$.media.kind')) VIRTUAL,
      -- to_id: the message a reaction/edit/delete is attached to.
      to_id       TEXT GENERATED ALWAYS AS (json_extract(json, '$.to')) VIRTUAL,
      -- reply_to_id: the message this one is a reply to. NULL on every row logged before this
      -- column existed — those kept the quoted text but not the id it came from.
      reply_to_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.replyToId')) VIRTUAL,
      -- view_once: 1 on a message the sender sent as view-once. Kept queryable on purpose — these
      -- are the rows worth being able to find later, since storing them at all goes against what
      -- the sender asked for. NULL on everything else.
      view_once   INTEGER GENERATED ALWAYS AS (json_extract(json, '$.viewOnce')) VIRTUAL
    );
    -- Every read is scoped to one chat and ordered by time; archived is in the index because the
    -- active/archive split used to be two separate files and is now a predicate.
    CREATE INDEX IF NOT EXISTS messages_jid_ts ON messages (jid, archived, ts);
    CREATE INDEX IF NOT EXISTS messages_jid_id ON messages (jid, id);
    -- One row per in-chat command that actually fired (/wakelevel, /verbosity, /incognito, etc.)
    -- -- an audit trail of *that a setting was changed*, not the message content, so it survives
    -- regardless of incognito: the whole point of logging a toggle is knowing it happened. detail
    -- is the matched argument ("mention-only", "on", "low"), not the raw message text.
    CREATE TABLE IF NOT EXISTS command_log (
      rowid   INTEGER PRIMARY KEY,
      ts      INTEGER NOT NULL,
      jid     TEXT NOT NULL,
      command TEXT NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS command_log_jid_ts ON command_log (jid, ts);
  `);
  // A database created before these columns existed keeps its old shape — CREATE TABLE IF NOT
  // EXISTS is a no-op on it, indexes on missing columns then fail. Adding them here is cheap and
  // safe: generated columns derive from rows that are already stored, so nothing is backfilled.
  // ponytail: add-column-if-absent rather than a versioned migration table. One table, three
  // columns; revisit if this ever needs ordered, irreversible steps.
  const generated = {
    media_kind: "TEXT GENERATED ALWAYS AS (json_extract(json, '$.media.kind')) VIRTUAL",
    to_id: "TEXT GENERATED ALWAYS AS (json_extract(json, '$.to')) VIRTUAL",
    reply_to_id: "TEXT GENERATED ALWAYS AS (json_extract(json, '$.replyToId')) VIRTUAL",
    view_once: "INTEGER GENERATED ALWAYS AS (json_extract(json, '$.viewOnce')) VIRTUAL",
  };
  for (const [name, definition] of Object.entries(generated)) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
    } catch (err) {
      // Already there (a fresh database gets them from CREATE TABLE above) — the only expected
      // failure. Anything else is a real schema problem and must not be swallowed.
      if (!/duplicate column name/.test(String(err?.message))) throw err;
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_to_id ON messages (jid, to_id) WHERE to_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (jid, reply_to_id) WHERE reply_to_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_media ON messages (jid, media_kind) WHERE media_kind IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_view_once ON messages (jid, ts) WHERE view_once IS NOT NULL;
  `);
  return db;
}

// The links the generated columns exist for: what is attached to a message (reactions, edits,
// deletes) and what replied to it. Both scoped to one chat, same rule as everything else here.
export function findRelated(jid, messageId) {
  return getDb()
    .prepare("SELECT json FROM messages WHERE jid = ? AND (to_id = ? OR reply_to_id = ?) ORDER BY ts")
    .all(jid, messageId, messageId)
    .map(parse);
}

// ponytail: no findMedia() helper yet — media_kind is indexed and ready, but nothing asks for
// "every voice note in this chat" today. Add the query when a tool needs it, not before.

// Records that an in-chat command fired -- called from every command branch in server.mjs,
// unconditionally, before any incognito early-return. This must never be gated by incognito: the
// one thing worth recording about a chat with incognito on is that incognito was toggled at all.
export function logCommand(jid, command, detail) {
  getDb()
    .prepare("INSERT INTO command_log (ts, jid, command, detail) VALUES (?, ?, ?, ?)")
    .run(Date.now(), jid, command, detail ?? null);
}

// No tool wraps this yet -- added alongside logCommand so the audit trail is queryable the moment
// it's asked for, not a second follow-up change. `jid` optional: omit for every chat's commands.
//
// Ordered by rowid, not ts: several commands logged within the same millisecond (any scripted
// burst, or just two fast toggles) tie on ts, and ORDER BY ts DESC then has no defined order among
// ties -- reversing that back to "chronological" scrambled it. rowid is monotonically increasing
// on insert with node:sqlite's INTEGER PRIMARY KEY, so it can never tie.
export function readCommandLog(jid, limit = 50) {
  const db = getDb();
  const rows = jid
    ? db
        .prepare("SELECT ts, jid, command, detail FROM command_log WHERE jid = ? ORDER BY rowid DESC LIMIT ?")
        .all(jid, limit)
    : db.prepare("SELECT ts, jid, command, detail FROM command_log ORDER BY rowid DESC LIMIT ?").all(limit);
  return rows.reverse();
}

// One line per inbound message, tailed by a Monitor to wake the Claude session on arrival. This
// stays a plain file on purpose: `tail -f` is the wake mechanism, and nothing tails a database.
export function logInbox(jid, label, text) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // jid up front and unambiguous: the same person's name shows up in both their own DM and any
  // group they're in, so name alone can't tell you which chat to reply in.
  appendFileSync(INBOX_FILE, `[${jid}] ${label}: ${text}`.replace(/\n/g, " ") + "\n", { mode: 0o600 });
}

function getContacts() {
  if (!existsSync(CONTACTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONTACTS_FILE, "utf8"));
  } catch (err) {
    // stderr, not logger: importing the pino instance from whatsapp.mjs would pull Baileys into
    // the store. Silence here loses every contact name with no signal at all.
    process.stderr.write(`contacts.json unreadable, names unavailable: ${err?.message ?? err}\n`);
    return {};
  }
}

// Names come only from pushName on messages already logged for allowlisted chats — never a
// direct read of WhatsApp's full contact/address book, which would expose far more than needed.
export function updateContact(jid, name) {
  if (!name) return;
  const contacts = getContacts();
  if (contacts[jid] === name) return;
  contacts[jid] = name;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), { mode: 0o600 });
}

// Re-filters by the caller's jid list even though getContacts() already only holds jids we've
// logged messages for — a second gate here means a stale/broadened contacts.json still can't
// leak a name for a chat that isn't currently allowlisted.
export function readContacts(jids) {
  const contacts = getContacts();
  return Object.fromEntries(jids.filter((j) => contacts[j]).map((j) => [j, contacts[j]]));
}

const parse = (row) => JSON.parse(row.json);

// Nothing is ever mutated or removed here — an edit and a delete are their own rows, pointing at
// the message they act on. That keeps the full history, but it means a plain read shows the
// original text of a message that has since been edited or deleted, with nothing saying so.
// These flags are derived at read time from those later rows rather than written onto the
// original, so the stored entry stays exactly as it arrived and the flags can never go stale.
//
//   edited:    true, plus editedText / editedAt from the most recent edit
//   deleted:   true, plus deletedAt
//
// ponytail: one extra query per read, over ids already in hand and an index built for it. Fold it
// into the main query if a read ever gets big enough for the round trip to matter.
function withStatus(jid, entries) {
  const ids = entries.map((e) => e.id).filter(Boolean);
  if (ids.length === 0) return entries;
  const placeholders = ids.map(() => "?").join(",");
  const acts = getDb()
    .prepare(
      `SELECT to_id, json_extract(json,'$.kind') AS kind, text, ts FROM messages
       WHERE jid = ? AND to_id IN (${placeholders}) AND json_extract(json,'$.kind') IN ('edit','delete')
       ORDER BY ts`,
    )
    .all(jid, ...ids);
  if (acts.length === 0) return entries;
  const byId = new Map();
  for (const a of acts) {
    const status = byId.get(a.to_id) ?? {};
    // Ordered by ts, so a later edit overwrites an earlier one and the last text wins.
    if (a.kind === "edit") Object.assign(status, { edited: true, editedText: a.text, editedAt: a.ts });
    else Object.assign(status, { deleted: true, deletedAt: a.ts });
    byId.set(a.to_id, status);
  }
  return entries.map((e) => (byId.has(e.id) ? { ...e, ...byId.get(e.id) } : e));
}

// LIKE with an escaped pattern rather than a caller-supplied regex: message text comes from
// whoever is on the other end of the chat, and an attacker-controlled regex is a ReDoS footgun.
// Case-folding uses the registered unicode_lower on both sides — SQLite's own lower() would leave
// Ş/İ/Ğ untouched and silently miss half the words in these chats.
export function searchMessages(jids, query, limit) {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => "?").join(",");
  const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
  return getDb()
    .prepare(
      `SELECT json FROM messages
       WHERE jid IN (${placeholders}) AND unicode_lower(text) LIKE ? ESCAPE '\\'
       ORDER BY ts LIMIT ?`,
    )
    .all(...jids, pattern, limit)
    .map(parse);
}

export function findMessage(jid, id) {
  const row = getDb().prepare("SELECT json FROM messages WHERE jid = ? AND id = ? AND archived = 0").get(jid, id);
  return row ? withStatus(jid, [parse(row)])[0] : null;
}

function getPollState() {
  if (!existsSync(POLL_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(POLL_STATE_FILE, "utf8"));
  } catch (err) {
    // Silence here makes readNewMessages fall back to readRecent and re-deliver already-read
    // messages, which reads as a WhatsApp problem rather than a corrupt local file.
    process.stderr.write(`poll-state.json unreadable, polls will re-deliver: ${err?.message ?? err}\n`);
    return {};
  }
}

function savePollState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function updatePollState(jid, lastMessageId) {
  const state = getPollState();
  state[jid] = lastMessageId;
  savePollState(state);
}

export function appendMessage(jid, entry) {
  const row = { jid, ...entry };
  getDb()
    .prepare("INSERT INTO messages (jid, id, ts, text, archived, json) VALUES (?, ?, ?, ?, 0, ?)")
    .run(jid, entry.id ?? null, entry.ts ?? Date.now(), entry.text ?? null, JSON.stringify(row));
}

export function readRecent(jid, limit) {
  // Ordered by ts, not insertion order: a sender-LID lookup can stall one message behind another,
  // so arrival order is not guaranteed to match send order. rowid breaks ties so two messages in
  // the same millisecond keep a stable order instead of swapping between calls.
  const rows = getDb()
    .prepare("SELECT json FROM messages WHERE jid = ? AND archived = 0 ORDER BY ts DESC, rowid DESC LIMIT ?")
    .all(jid, limit)
    .map(parse)
    .reverse();
  return withStatus(jid, rows);
}

export function messageCount(jid) {
  return getDb().prepare("SELECT count(*) AS n FROM messages WHERE jid = ? AND archived = 0").get(jid).n;
}

// Archiving is now a flag, not a file move: the rows stay put and drop out of every active query.
// wa_search still reads them because it deliberately spans both.
export function archiveOldMessages(jid, ageMinutes = ARCHIVE_AGE_DAYS * 24 * 60) {
  const cutoff = Date.now() - ageMinutes * 60 * 1000;
  getDb().prepare("UPDATE messages SET archived = 1 WHERE jid = ? AND archived = 0 AND ts < ?").run(jid, cutoff);
}

export function readNewMessages(jid, limit) {
  const lastId = getPollState()[jid];
  if (!lastId) return readRecent(jid, limit);
  // The marker's own rowid is the cursor: "everything logged after that message", which stays
  // correct even when two messages share a timestamp.
  const marker = getDb()
    .prepare("SELECT rowid FROM messages WHERE jid = ? AND id = ? AND archived = 0")
    .get(jid, lastId);
  if (!marker) return readRecent(jid, limit);
  const rows = getDb()
    .prepare("SELECT json FROM messages WHERE jid = ? AND archived = 0 AND rowid > ? ORDER BY ts, rowid LIMIT ?")
    .all(jid, marker.rowid, limit)
    .map(parse);
  return withStatus(jid, rows);
}
