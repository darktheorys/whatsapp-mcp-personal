import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function writeAll(all) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(POLLS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Called right after sendMessage for a poll. `secret` is the same Uint8Array passed as
// `messageSecret` when creating it — stored base64, since JSON has no byte-array type.
export function savePoll(jid, messageId, { name, values, selectableCount, secret }) {
  const all = readAll();
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
  const all = readAll();
  if (!all[messageId]) return; // a poll this process didn't create and has no secret for
  all[messageId].tally = tally;
  all[messageId].tallyUpdatedAt = Date.now();
  writeAll(all);
}

export function renderTally(entry) {
  if (!entry.tally || entry.tally.length === 0) {
    return `[poll] ${entry.name} — no votes yet`;
  }
  const lines = entry.tally.map((t) => `${t.name}: ${t.voters.length}`).join(", ");
  return `[poll] ${entry.name} — ${lines}`;
}
