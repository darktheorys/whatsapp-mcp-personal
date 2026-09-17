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
  // Registered so the FTS backfill below can normalise inside SQL instead of pulling every row
  // into JS and writing it back one statement at a time.
  db.function("search_norm", (s) => normalizeForSearch(s));
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
    // "in" | "out". Promoted for the stats queries, which slice almost everything by who spoke —
    // reading it out of the blob per row made every one of them a full json_extract scan.
    direction: "TEXT GENERATED ALWAYS AS (json_extract(json, '$.direction')) VIRTUAL",
    // "reaction" | "edit" | "delete", NULL for an ordinary message. Stats count conversation, and
    // a 👀 is not a turn in one — this is what lets them be excluded without parsing the blob.
    kind: "TEXT GENERATED ALWAYS AS (json_extract(json, '$.kind')) VIRTUAL",
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
    -- Search index over normalised text (see normalizeForSearch). Trigram, not unicode61: the
    -- default tokeniser is word-based, so it cannot match a fragment inside a word — searching
    -- "eke" would stop finding "şeker", which is a regression against the LIKE search this
    -- replaces. Trigram indexes every 3-character window, so substring behaviour is preserved.
    --
    -- A plain FTS5 table rather than an external-content one (content=messages): the indexed text
    -- is not a column of the messages table at all, it is a normalised derivative of it, so there
    -- is nothing for external content to point at. rowid is kept equal to the messages rowid,
    -- which is what makes the join below work.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(norm, tokenize="trigram");
  `);
  // Backfill: every message row with text that has no index row yet. Covers both the one-time
  // migration of a database that predates this table and any gap a crash between the two inserts
  // in appendMessage could open. Guarded by a count comparison so the NOT IN scan doesn't run on
  // every startup — in the normal case the counts match and this costs two counts.
  //
  // Not a violation of the append-only rule: nothing in `messages` is read differently or written
  // back, this only populates a derived index, the same category as the indexes above.
  const { m, f } = db
    .prepare(
      "SELECT (SELECT count(*) FROM messages WHERE text IS NOT NULL) AS m, (SELECT count(*) FROM messages_fts) AS f",
    )
    .get();
  if (m !== f) {
    db.exec(`
      INSERT INTO messages_fts (rowid, norm)
      SELECT rowid, search_norm(text) FROM messages
      WHERE text IS NOT NULL AND rowid NOT IN (SELECT rowid FROM messages_fts)
    `);
  }
  return db;
}

// Folds a string to a form where a query typed on an English keyboard finds Turkish text. Lowercase
// (full Unicode, not SQLite's ASCII-only lower()), then NFD to split accented letters into base +
// combining mark, then drop the marks: ş→s, ğ→g, ü→u, ö→o, ç→c, İ→i all fall out of that single
// step. 'ı' (U+0131, dotless i) is the one that does not — it has no decomposition, so it is mapped
// explicitly. ß is folded to ss because its uppercase form is SS and half the German in these chats
// is typed either way.
//
// Measured, not assumed: FTS5's trigram tokeniser case-folds Turkish correctly on its own
// (şeker↔ŞEKER) but does no diacritic folding at all, so "seker" found nothing without this. The
// LIKE search this replaces had the identical gap.
export function normalizeForSearch(s) {
  if (typeof s !== "string") return s;
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss");
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
  const ts = new Date().toISOString();
  appendFileSync(INBOX_FILE, `[${ts}] [${jid}] ${label}: ${text}`.replace(/\n/g, " ") + "\n", { mode: 0o600 });
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

// Trigram FTS5 needs at least 3 characters to match: the index stores 3-character windows, so a
// shorter needle has no window to look up and the query returns nothing rather than erroring.
// Below this, fall back to the LIKE scan, which has no such floor.
const TRIGRAM_MIN = 3;

// Never a caller-supplied regex: message text comes from whoever is on the other end of the chat,
// and an attacker-controlled regex is a ReDoS footgun.
//
// Both paths search the normalised form (see normalizeForSearch) on both sides, so a query typed
// without a Turkish keyboard still matches — "seker" finds "şeker". The LIKE path used to fold with
// unicode_lower, which handled case but not diacritics.
export function searchMessages(jids, query, limit) {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => "?").join(",");
  const needle = normalizeForSearch(query);

  if (needle.length < TRIGRAM_MIN) {
    const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    return getDb()
      .prepare(
        `SELECT json FROM messages
         WHERE jid IN (${placeholders}) AND search_norm(text) LIKE ? ESCAPE '\\'
         ORDER BY ts LIMIT ?`,
      )
      .all(...jids, pattern, limit)
      .map(parse);
  }

  // Wrapped in double quotes so FTS5 reads the whole thing as one phrase — a bare MATCH argument is
  // a query *expression*, where a stray `*`, `:`, `NEAR` or unbalanced paren is either a syntax
  // error or a different search than the one asked for. Internal quotes are doubled, the escape
  // FTS5's phrase syntax defines. With trigram, a phrase match is a substring match, which is the
  // behaviour wa_search has always had.
  const phrase = `"${needle.replace(/"/g, '""')}"`;
  return getDb()
    .prepare(
      `SELECT m.json FROM messages_fts f
       JOIN messages m ON m.rowid = f.rowid
       WHERE f.norm MATCH ? AND m.jid IN (${placeholders})
       ORDER BY m.ts LIMIT ?`,
    )
    .all(phrase, ...jids, limit)
    .map(parse);
}

// A gap this long between two messages ends one conversation and starts the next. Six hours is
// long enough to sit across a working day or a night's sleep without splitting a single back-and-
// forth in two, and short enough that "who opened this conversation" still means something.
const CONVERSATION_GAP_MS = 6 * 60 * 60 * 1000;
// Response times above this are treated as "never really replied" and left out of the median —
// otherwise one message answered three days later drags the number somewhere that describes no
// actual conversation.
const MAX_RESPONSE_MS = 12 * 60 * 60 * 1000;

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Aggregated in JS rather than SQL. The reply-time and conversation-start figures both need to walk
// the messages in order and remember the previous one, which in SQL is a window-function query that
// is considerably harder to read and to be sure of than the loop below — and at one person's chat
// volume the whole history fits in memory comfortably. Revisit if that stops being true.
//
// Spans archived rows too, same as search: "who do I talk to most" is a question about all of it,
// and the 30-day archive cutoff is a read-path detail, not a statement about relevance.
// `untilMs` exists so the same function can produce the *previous* period as well as the current
// one, which is what makes a weekly report say "you started 2 conversations, down from 7" instead
// of just printing 2. Without an upper bound there is no way to ask for a window that has already
// ended.
export function chatStats(jid, sinceMs = null, untilMs = null) {
  const rows = getDb()
    .prepare(
      `SELECT ts, direction FROM messages
       WHERE jid = ? AND kind IS NULL AND direction IS NOT NULL AND ts >= ? AND ts < ?
       ORDER BY ts, rowid`,
    )
    .all(jid, sinceMs ?? 0, untilMs ?? Number.MAX_SAFE_INTEGER);
  if (rows.length === 0) return { jid, total: 0 };

  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0); // 0 = Sunday, matching Date#getDay
  const replyMs = { in: [], out: [] };
  const starts = { in: 0, out: 0 };
  let inbound = 0;
  let outbound = 0;
  let prev = null;

  for (const row of rows) {
    const when = new Date(row.ts);
    // Local time, deliberately: an activity heatmap is about the hours of someone's day, and UTC
    // buckets would put a late-night chat in Istanbul into the following morning.
    byHour[when.getHours()]++;
    byWeekday[when.getDay()]++;
    if (row.direction === "in") inbound++;
    else outbound++;

    const gap = prev ? row.ts - prev.ts : Infinity;
    if (gap > CONVERSATION_GAP_MS) starts[row.direction === "in" ? "in" : "out"]++;
    // Only a direction change is a reply; consecutive messages from the same side are one turn
    // being typed in several bubbles, and counting the second as a 0-minute reply would make every
    // median meaninglessly fast.
    else if (prev && prev.direction !== row.direction && gap <= MAX_RESPONSE_MS) {
      replyMs[row.direction === "out" ? "out" : "in"].push(gap);
    }
    prev = row;
  }

  const toMinutes = (ms) => (ms === null ? null : Math.round(ms / 60000));
  return {
    jid,
    total: rows.length,
    inbound,
    outbound,
    firstTs: rows[0].ts,
    lastTs: rows[rows.length - 1].ts,
    lastDirection: rows[rows.length - 1].direction,
    // "out" = how long you take to answer them; "in" = how long they take to answer you.
    medianReplyMinutes: { out: toMinutes(median(replyMs.out)), in: toMinutes(median(replyMs.in)) },
    replySamples: { out: replyMs.out.length, in: replyMs.in.length },
    conversationsStarted: { byThem: starts.in, byYou: starts.out },
    byHour,
    byWeekday,
  };
}

// Chats whose last word was theirs, long enough ago that it reads as unanswered rather than as a
// conversation still in progress. Deliberately not a judgement about whether a reply was *needed* —
// plenty of messages rightly end a thread. It surfaces candidates; the reading is the caller's.
export function unansweredChats(jids, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const db = getDb();
  const out = [];
  for (const jid of jids) {
    const last = db
      .prepare(
        `SELECT ts, text, direction FROM messages
         WHERE jid = ? AND kind IS NULL AND direction IS NOT NULL
         ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(jid);
    if (last && last.direction === "in" && last.ts < cutoff) {
      out.push({ jid, lastTs: last.ts, waitingMinutes: Math.round((Date.now() - last.ts) / 60000), text: last.text });
    }
  }
  return out.sort((a, b) => a.lastTs - b.lastTs);
}

// Walks a reply chain in both directions from one message: back through what it was replying to,
// and forward through everything that replied to it (and to those, and so on). The indexes this
// needs — messages_reply_to — have existed since replies were first logged; nothing ever used them
// to reconstruct a conversation, so following a thread meant paging through wa_recent by hand and
// matching quoted text by eye.
//
// Spans archived rows, same as search: a thread that started five weeks ago is exactly the kind
// worth reconstructing, and the 30-day archive flag is a read-path detail rather than a statement
// about relevance.
const MAX_THREAD_NODES = 200;

export function threadOf(jid, messageId) {
  const db = getDb();
  const byId = db.prepare("SELECT json FROM messages WHERE jid = ? AND id = ? LIMIT 1");
  const repliesTo = db.prepare("SELECT json FROM messages WHERE jid = ? AND reply_to_id = ? ORDER BY ts, rowid");

  const start = byId.get(jid, messageId);
  if (!start) return [];

  const collected = new Map();
  const add = (entry) => {
    if (entry?.id && !collected.has(entry.id)) collected.set(entry.id, entry);
  };
  add(parse(start));

  // Backwards: each message names the one it replied to, so this is a straight walk up. Bounded by
  // the node cap and by `seen`, because a malformed chain that points at itself would otherwise
  // spin forever.
  let cursor = parse(start);
  const seen = new Set([messageId]);
  while (cursor?.replyToId && collected.size < MAX_THREAD_NODES && !seen.has(cursor.replyToId)) {
    seen.add(cursor.replyToId);
    const row = byId.get(jid, cursor.replyToId);
    if (!row) break; // the chain leaves the log — a reply to something logged before this server saw it
    cursor = parse(row);
    add(cursor);
  }

  // Forwards: breadth-first, since a message can have several replies and each of those can have
  // its own. This is the half that actually needs the index.
  const queue = [...collected.keys()];
  while (queue.length && collected.size < MAX_THREAD_NODES) {
    const id = queue.shift();
    for (const row of repliesTo.all(jid, id)) {
      const entry = parse(row);
      if (entry.id && !collected.has(entry.id)) {
        add(entry);
        queue.push(entry.id);
      }
    }
  }

  // Chronological, not tree-shaped: these are chat messages, and a flat transcript in time order is
  // how anyone actually reads one back. replyToId is on every entry for whoever wants the shape.
  const ordered = [...collected.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return withStatus(jid, ordered);
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
  const db = getDb();
  const text = entry.text ?? null;
  const info = db
    .prepare("INSERT INTO messages (jid, id, ts, text, archived, json) VALUES (?, ?, ?, ?, 0, ?)")
    .run(jid, entry.id ?? null, entry.ts ?? Date.now(), text, JSON.stringify(row));
  // Second insert rather than a trigger: the normalisation is JS (see normalizeForSearch), and a
  // trigger would have to call back into it through the registered SQL function for every write.
  // Skipped for text-less rows (media with no caption, reactions) so the index holds only things
  // that can actually match a search — and so the backfill's count check stays exact.
  //
  // If this throws, the message row is already committed: the row is the record and must survive,
  // an index gap is recoverable (the backfill in getDb picks it up on next start). Losing the
  // message to protect the index would be exactly backwards.
  if (text !== null) {
    try {
      db.prepare("INSERT INTO messages_fts (rowid, norm) VALUES (?, ?)").run(
        info.lastInsertRowid,
        normalizeForSearch(text),
      );
    } catch (err) {
      process.stderr.write(`search index write failed, message kept: ${err?.message ?? err}\n`);
    }
  }
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
