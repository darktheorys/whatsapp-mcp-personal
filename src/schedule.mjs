import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./config.mjs";

// Scheduled work that survives everything a Claude session does not. The session-scoped cron this
// replaces lived in memory, expired after seven days, and only fired while the REPL happened to be
// idle — so a session that woke every thirty minutes to re-arm a Monitor starved it, and the daily
// digest went out an hour late or not at all. This runs inside the server process, which is already
// alive for the WhatsApp socket and does not care whether anyone is driving it.
//
// What the server *cannot* do is the work itself: composing a digest needs a model. So a due task
// writes a line into state/inbox.log, the same file the wake Monitor tails, and whichever session
// is listening picks it up and acts. The schedule is durable; the execution still needs a session.
// If nothing is listening the line stays in the file, which is how a later session can still see it.
const SCHEDULE_FILE = process.env.WA_SCHEDULE_PATH ?? join(STATE_DIR, "schedule.json");

// Deliberately not cron. Five-field cron is a lot of parsing to get wrong for a use case that is
// "every day at 10:03" and "Mondays at 09:00" — and a mis-parsed cron field fails silently, at
// which point this is no better than what it replaced. `at` is "HH:MM" local, `days` is an optional
// list of weekdays (0 = Sunday, matching Date#getDay). Revisit only if a real need appears that
// this shape cannot express.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A task due while the server was down still matters — a digest is wanted at 10:40 if the machine
// was asleep at 10:03. Past this window it is stale enough that firing it is just confusing.
const DEFAULT_CATCH_UP_MINUTES = 120;

export function loadSchedule() {
  if (!existsSync(SCHEDULE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // stderr, never stdout: stdout is the MCP JSON-RPC channel. Silence would make a corrupt file
    // look exactly like an empty schedule, and the digest would just quietly stop happening.
    process.stderr.write(`schedule.json unreadable, no scheduled tasks will run: ${err?.message ?? err}\n`);
    return [];
  }
}

function saveSchedule(tasks) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2), { mode: 0o600 });
}

export function validateTask({ id, at, days, prompt }) {
  if (!id || !/^[a-z0-9-]{1,40}$/i.test(id)) return "id must be 1-40 characters of letters, digits or hyphens";
  if (!HHMM.test(at ?? "")) return `at must be "HH:MM" in 24-hour local time, got ${JSON.stringify(at)}`;
  if (days !== undefined) {
    if (!Array.isArray(days) || days.length === 0) return "days must be a non-empty array when given";
    if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return "days must be integers 0-6 (0 = Sunday)";
  }
  if (!prompt || typeof prompt !== "string") return "prompt is required";
  return null;
}

// The occurrence of `at` on the day `now` falls in, as a timestamp. Local time on purpose: "10:03"
// means 10:03 where the owner is, and a UTC schedule would drift by an hour twice a year.
function occurrenceOn(now, at) {
  const [, h, m] = HHMM.exec(at);
  const d = new Date(now);
  d.setHours(Number(h), Number(m), 0, 0);
  return d.getTime();
}

// Separated from the timer and given `now` explicitly so it can be tested without waiting for a
// clock. Returns the tasks that should fire at this instant.
export function dueTasks(tasks, now = Date.now()) {
  return tasks.filter((t) => {
    if (t.enabled === false) return false;
    if (validateTask(t)) return false; // a malformed task must never fire, and never throw
    const occurrence = occurrenceOn(now, t.at);
    if (now < occurrence) return false;
    // Weekday is checked against the occurrence, not `now`, so a catch-up that crosses midnight
    // is still judged by the day the task was actually scheduled for.
    if (t.days && !t.days.includes(new Date(occurrence).getDay())) return false;
    const window = (t.catchUpMinutes ?? DEFAULT_CATCH_UP_MINUTES) * 60_000;
    if (now - occurrence > window) return false;
    // The guard against firing twice: lastRun is the occurrence it last fired for, so a second
    // check a minute later sees it has already run for this one and skips.
    return !(t.lastRun >= occurrence);
  });
}

export function markRan(id, when = Date.now()) {
  const tasks = loadSchedule();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  // Stored as the occurrence rather than the wall-clock time it actually fired, so a catch-up run
  // at 10:40 still counts as "ran for 10:03" and cannot re-fire at 10:41.
  task.lastRun = occurrenceOn(when, task.at);
  task.lastRanAt = when;
  saveSchedule(tasks);
}

export function upsertTask(task) {
  const problem = validateTask(task);
  if (problem) return { error: problem };
  const tasks = loadSchedule();
  const existing = tasks.findIndex((t) => t.id === task.id);
  // lastRun is preserved across an edit: changing a prompt should not make today's already-sent
  // digest go out a second time.
  const merged = { ...(existing >= 0 ? tasks[existing] : {}), ...task };
  if (existing >= 0) tasks[existing] = merged;
  else tasks.push(merged);
  saveSchedule(tasks);
  return { task: merged };
}

export function removeTask(id) {
  const tasks = loadSchedule();
  const kept = tasks.filter((t) => t.id !== id);
  if (kept.length === tasks.length) return false;
  saveSchedule(kept);
  return true;
}

// ponytail: two server instances both running this would each fire a due task, producing two wake
// lines. Only one instance holds the WhatsApp socket (the other exits on connectionReplaced), so
// the overlap is brief and the cost is a duplicate line rather than a duplicate send — the session
// decides what to actually do. Revisit with a lock file if that stops being true.
export function startScheduler({ onDue, intervalMs = 30_000 }) {
  const tick = () => {
    for (const task of dueTasks(loadSchedule())) {
      markRan(task.id);
      try {
        onDue(task);
      } catch {
        // Already marked as run: a handler that throws must not put the task into a loop where it
        // fires again on every tick for the rest of the catch-up window.
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  // Does not hold the process open by itself — the WhatsApp socket is what keeps this alive, and a
  // stray timer should never be the reason it cannot exit.
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
