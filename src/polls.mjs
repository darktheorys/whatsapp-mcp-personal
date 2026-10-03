import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptPollVote } from "@whiskeysockets/baileys";

import { STATE_DIR } from "./config.mjs";

// Durable state for polls this server created, keyed by the poll message's own id. Baileys can
// send a poll trivially, but reading its votes back is the part that needs planning ahead: a vote
// arrives encrypted, and decrypting it needs the same 32-byte `messageSecret` the poll was created
// with — generated once at send time and never recoverable afterward. Lose the secret and the votes
// on that poll are unreadable forever, so it is written to disk before the send even completes.
//
// A JSON file, not a SQLite table: this is small keyed state read and written as a whole object,
// the same shape as schedule.json/poll-state.json, not a growing log of rows.
const POLLS_FILE = process.env.WA_POLLS_PATH ?? join(STATE_DIR, "polls.json");

// Lenient: used by every *read* path (getPoll, pollCreationMessageFor's caller, the getMessage
// callback Baileys calls mid-decrypt). A corrupt file degrading one read to "not found" is the
// accepted failure mode the comment below describes — a vote fails to decrypt this one time.
function readAll() {
  if (!existsSync(POLLS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(POLLS_FILE, "utf8"));
  } catch (err) {
    // A vote arriving right after a corrupt read would otherwise throw all the way out of the
    // messages.update handler. Losing the ability to tally one poll is recoverable; crashing the
    // handler for every event after it is not.
    process.stderr.write(`polls.json unreadable, poll votes will not be tallied: ${err?.message ?? err}\n`);
    return {};
  }
}

// Strict: used only by every *write* path (savePoll, saveTally). The distinction from readAll above
// is load-bearing, not stylistic. A write is read-modify-write — read the whole file, patch one
// entry, write the whole file back — and readAll's {} fallback on a parse failure is safe for a
// read (one vote fails to decrypt) but catastrophic for a write: the empty object doesn't stay
// empty, it gets one new entry added and is then written back as the *entire* file, permanently
// erasing every other poll's secret that was sitting in the part that failed to parse. A poll's
// secret cannot be regenerated once the poll is out — WhatsApp already has it with the original
// secret baked in — so this is not a bug that degrades gracefully, it is silent, unrecoverable data
// loss of the one thing this module exists to prevent losing. Throwing here instead means a corrupt
// file blocks the one write that would have destroyed it, rather than completing the destruction.
function readAllForWrite() {
  if (!existsSync(POLLS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(POLLS_FILE, "utf8"));
  } catch (err) {
    throw new Error(`refusing to write polls.json over an unparseable file: ${err?.message ?? err}`);
  }
}

function writeAll(all) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(POLLS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Called right after sendMessage for a poll. `secret` is the same Uint8Array passed as
// `messageSecret` when creating it — stored base64, since JSON has no byte-array type.
export function savePoll(jid, messageId, { name, values, selectableCount, secret }) {
  const all = readAllForWrite();
  all[messageId] = {
    jid,
    name,
    values,
    selectableCount: selectableCount ?? 1,
    secretB64: Buffer.from(secret).toString("base64"),
    createdAt: Date.now(),
    tally: null,
    tallyUpdatedAt: null,
  };
  writeAll(all);
}

export function getPoll(messageId) {
  return readAll()[messageId] ?? null;
}

// The shape Baileys' own decryption functions need to re-derive the encryption key: a `message`
// object that looks like the one actually sent, `pollCreationMessage` and all. Reconstructed from
// what was saved rather than kept as a live object, so this survives a restart between the poll
// being sent and a vote arriving on it — which, for a poll left open a few hours, is the normal case.
export function pollCreationMessageFor(entry) {
  return {
    messageContextInfo: { messageSecret: Buffer.from(entry.secretB64, "base64") },
    pollCreationMessage: {
      name: entry.name,
      options: entry.values.map((v) => ({ optionName: v })),
      selectableOptionsCount: entry.selectableCount,
    },
  };
}

// Called every time a vote update arrives for a poll this server knows about. Overwrites the
// previous tally rather than merging: votes are cumulative snapshots by the time Baileys hands them
// over (getAggregateVotesInPollMessage aggregates from the full pollUpdates list each time, not a
// delta), so the newest tally already supersedes the last one saved.
export function saveTally(messageId, tally) {
  const all = readAllForWrite();
  if (!all[messageId]) return; // a poll this process didn't create and has no secret for
  all[messageId].tally = tally;
  all[messageId].tallyUpdatedAt = Date.now();
  writeAll(all);
}

// Baileys 7.0.0-rc14 no longer decrypts poll votes: the pollUpdateMessage branch in
// process-message.js is commented out ("TODO: Remove entirely"), so no messages.update with
// `pollUpdates` is ever emitted and a vote only shows up as a raw pollUpdateMessage in
// messages.upsert. The votes were reaching the socket the whole time and being dropped as plumbing.
// So the decryption is done here, with Baileys' own exported decryptPollVote.
const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");

// The key is derived from the poll creator's and the voter's JIDs, and the phone may have used
// either the phone-number or the @lid form of each, with no flag saying which. So every plausible
// pairing is tried, and a wrong one fails authentication (AES-GCM) rather than decrypting to
// garbage, which is what makes trying them all safe. Returns null when none works.
export function decryptVote(entry, { creationKey, voteKey, vote, meIds }) {
  const pollEncKey = Buffer.from(entry.secretB64, "base64");
  const fromKey = (key) =>
    key?.fromMe
      ? meIds
      : [...new Set([key?.participantAlt, key?.remoteJidAlt, key?.participant, key?.remoteJid].filter(Boolean))];
  // Every poll in polls.json was created by this server, so the creator is always one of our own
  // identities whatever the key says. The key's own forms are tried first, ours after, because a
  // vote's creationKey is not always flagged fromMe from this device's point of view.
  const creators = [...new Set([...fromKey(creationKey), ...meIds])];
  for (const pollCreatorJid of creators) {
    for (const voterJid of fromKey(voteKey)) {
      try {
        const decoded = decryptPollVote(vote, { pollEncKey, pollCreatorJid, pollMsgId: creationKey.id, voterJid });
        // One person must be one voter however the phone addressed them: the same account voting under
        // its phone-number form once and its @lid form later would otherwise be two entries, and a
        // changed answer would count twice.
        return {
          voterJid: meIds.includes(voterJid) ? meIds[0] : voterJid,
          hashes: (decoded.selectedOptions ?? []).map((o) => Buffer.from(o).toString("hex")),
        };
      } catch {
        // wrong identity pairing, try the next
      }
    }
  }
  return null;
}

// One voter's latest vote replaces their earlier one (changing an answer must not count twice, which
// Baileys' own aggregator would do), and an out-of-order older vote never overwrites a newer one.
export function tallyFromVotes(entry) {
  const votes = entry.votes ?? {};
  return entry.values.map((name) => ({
    name,
    voters: Object.entries(votes)
      .filter(([, v]) => v.hashes.includes(sha256Hex(name)))
      .map(([voter]) => voter),
  }));
}

// Returns the new tally, or null when nothing changed: an unknown poll, an older vote arriving late,
// or the same vote redelivered (an offline-notification replay). Null is what keeps a redelivery
// from waking the session again with an answer it has already acted on.
export function saveVote(messageId, voterJid, hashes, ts, aliases = []) {
  const all = readAllForWrite();
  const entry = all[messageId];
  if (!entry) return null;
  entry.votes ??= {};
  // The same account may already be stored under another of its identities (a vote recorded before
  // voters were normalised, keyed by the @lid form). Left alone, one person's changed answer would
  // show as two voters, one per option. Anything older under an alias is the same person's earlier
  // answer and is dropped.
  let merged = false;
  for (const alias of aliases) {
    if (alias !== voterJid && entry.votes[alias] && entry.votes[alias].ts <= ts) {
      delete entry.votes[alias];
      merged = true;
    }
  }
  const prev = entry.votes[voterJid];
  const sameChoice = prev && JSON.stringify(prev.hashes) === JSON.stringify(hashes);
  const stale = prev && prev.ts > ts;
  // An unchanged choice, or an older vote arriving late, is not news and must not wake anyone.
  if (!merged && (stale || sameChoice)) return null;
  if (!stale) entry.votes[voterJid] = { ts, hashes };
  entry.tally = tallyFromVotes(entry);
  entry.tallyUpdatedAt = Date.now();
  writeAll(all);
  return entry.tally;
}

// The one-line form of a vote update for state/inbox.log, which is what wakes a tailing session.
// Only the options that actually hold votes are named, so "evet sil" reads as an answer rather than
// a tally of every option. An empty tally means the voter withdrew their vote.
export function voteWakeLine(entry, tally) {
  const chosen = (tally ?? []).filter((t) => t.voters.length > 0).map((t) => t.name);
  return chosen.length ? `${entry.name} → ${chosen.join(", ")}` : `${entry.name} → vote withdrawn`;
}

export function renderTally(entry) {
  if (!entry.tally || entry.tally.length === 0) {
    return `[poll] ${entry.name} — no votes yet`;
  }
  const lines = entry.tally.map((t) => `${t.name}: ${t.voters.length}`).join(", ");
  return `[poll] ${entry.name} — ${lines}`;
}
