import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import { AUTH_DIR, LOG_PATH, ensureDirs, loadConfig } from "./config.mjs";

// Baileys reports a message it could not decrypt or a notification batch it could not parse by
// logging it and moving on. There is no event for it, and the message is simply gone: it never
// reaches messages.upsert, so handleIncoming never runs and nothing is stored. That is invisible
// silent loss — it ate two messages from a contact and was only noticed days later, by a human
// looking at their phone.
//
// These are the substrings that mean "an inbound message was lost". `processing offline
// notification` is the worst of them: offline notifications are the batch delivered after a gap,
// so one parse failure can take several messages at once.
const DROP_SIGNATURES = [
  "failed to decrypt message",
  "processing offline notification",
  "handling notification",
  "Bad MAC",
];

// Set by server.mjs so these can be surfaced as MCP notifications. Module-level because the logger
// is built at import time, long before any caller passes a callback in.
let onDrop = null;
export function setDropNotifier(fn) {
  onDrop = fn;
}

// MCP runs over stdio: stdout is the JSON-RPC channel. Baileys' logger must never touch it.
ensureDirs();
const logFile = pino.destination({ dest: LOG_PATH, mkdir: true });
// A custom write rather than a wrapped logger object: pino hands every record here as one NDJSON
// line, which is a far smaller surface to get wrong than proxying a logger Baileys then relies on.
// The file still receives every line unchanged; this only reads them on the way past.
export const logger = pino(
  { level: "warn" },
  {
    write(line) {
      logFile.write(line);
      if (!onDrop) return;
      try {
        const msg = JSON.parse(line)?.msg ?? "";
        if (DROP_SIGNATURES.some((s) => msg.includes(s))) {
          onDrop(msg);
        }
      } catch {
        // A malformed line is not worth failing a log write over, and must never throw into pino.
      }
    },
  },
);

let sock = null;
// Why this is tracked separately from `sock`: a socket object outlives the connection it
// represents. After a logout the object is still there, still has `.user` on it, and every
// liveness check written as `getSocket()?.user` keeps answering "yes" while sends fail with
// "Connection Closed". Status has to be reported from what the connection last *did*, not from
// whether an object exists.
let lastError = null;

export function getSocket() {
  return sock;
}

// The honest answer to "is this up?" — `live` is false whenever a disconnect hasn't been followed
// by a successful reconnect, and `lastError` says why. Cleared only by a real `connection: open`.
export function connectionState() {
  return { live: Boolean(sock?.user) && !lastError, lastError };
}

// Handlers are async, and a rejected one would otherwise surface as an unhandled rejection that
// takes the whole server down. Every dispatch goes through here.
const safely = (fn, arg, what) => Promise.resolve(fn?.(arg)).catch((err) => logger.error(err, `${what} failed`));

// `onNotice(level, message, data)` is optional and lets the MCP layer forward connection events to
// the client as protocol log notifications. This module deliberately knows nothing about MCP — it
// gets a callback, not a server — so importing it stays free of protocol concerns.
export async function startWhatsApp({ onMessage, onReaction, onPresence, onNotice }) {
  const notice = (level, message, data) => {
    try {
      onNotice?.(level, message, data);
    } catch {
      // A broken notifier must never be the reason a reconnect doesn't happen.
    }
  };
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const thisSock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    // Baileys defaults this to true, which fires sendPresenceUpdate('available') on connect and
    // announces this process as an active online device. WhatsApp then treats the account as
    // "already reading somewhere" and stops pushing notifications to the phone — so simply having
    // this server running silently swallowed the owner's own notifications. This server is a
    // background logger, not a device anyone is sitting at; it must never claim otherwise.
    // Notifications on the phone are the owner's signal that something needs dealing with, and
    // nothing here is worth costing them that.
    markOnlineOnConnect: false,
  });
  sock = thisSock;

  thisSock.ev.on("creds.update", saveCreds);

  thisSock.ev.on("connection.update", (update) => {
    // wa_connect lets a tool call re-run startWhatsApp in a process that already has a live
    // socket (e.g. to reclaim the connection after another process stole it). That old socket
    // gets disconnected as a side effect and fires this same handler — without this check its
    // stale "replaced" event would look identical to a real takeover and kill the process that
    // just successfully reconnected.
    if (getSocket() !== thisSock) return;
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      const wasDown = lastError;
      lastError = null;
      // Only on recovery, not on the first connect: a notification every startup is noise, one
      // saying the socket came back after an outage is the answer to "why did that send fail".
      if (wasDown) notice("info", "WhatsApp connection restored", { after: wasDown });
      // Presence updates for a jid only arrive after subscribing to it (and only if that
      // contact's privacy settings allow sharing last-seen/composing status at all — if they
      // don't, this silently gets nothing, same as WhatsApp's own UI would show no indicator
      // either). Best-effort per allowlisted jid; one failing (e.g. a group jid, which
      // presenceSubscribe doesn't apply to the same way) must not stop the rest.
      for (const jid of loadConfig().allowlist) {
        thisSock.presenceSubscribe(jid).catch(() => {});
      }
      return;
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        // Drop the socket as well as recording why: a logged-out socket that stays installed is
        // what made wa_status report a healthy connection through three failed sends.
        sock = null;
        lastError = "logged out by WhatsApp (401) — run `node src/pair.mjs <number>` to relink, then wa_connect";
        logger.error(lastError);
        notice("error", lastError, { statusCode });
        return;
      }
      lastError = `disconnected (${statusCode ?? "unknown"}) — reconnecting`;
      notice("warning", lastError, { statusCode });
      // WhatsApp allows one live connection per linked device. Reconnecting after another
      // instance took over just kicks it off again, and the two ping-pong forever.
      if (statusCode === DisconnectReason.connectionReplaced) {
        // Idling here would leave a dead process an MCP client could still be talking to,
        // producing a silent "Connection Closed" on every tool call until someone notices.
        // Exiting makes the failure visible immediately instead.
        const message =
          "Another instance took over this WhatsApp session — exiting so a stale process isn't left running.";
        logger.error(message);
        notice("critical", message, { statusCode });
        // A beat before exiting so the notification above actually makes it onto the transport —
        // process.exit() on the same tick drops anything still queued, which would make the one
        // event most worth reporting the one event that never arrives.
        setTimeout(() => process.exit(1), 100);
        return;
      }
      // A short delay before retrying avoids a tight reconnect loop hammering WhatsApp's
      // servers if the connection keeps failing immediately (robotic-looking retries are
      // themselves one of the signals WhatsApp's abuse detection weighs).
      setTimeout(() => {
        // onNotice included: dropping it here would silence connection reporting from the first
        // reconnect onward, exactly when it starts being worth having.
        startWhatsApp({ onMessage, onReaction, onPresence, onNotice }).catch((err) =>
          logger.error(err, "reconnect failed"),
        );
      }, 3000);
    }
  });

  thisSock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" || getSocket() !== thisSock) return;
    for (const msg of messages) safely(onMessage, msg, "onMessage");
  });

  // Reactions never appear in `messages.upsert`, so without this listener they are invisible.
  thisSock.ev.on("messages.reaction", (reactions) => {
    if (getSocket() !== thisSock) return;
    for (const r of reactions) safely(onReaction, r, "onReaction");
  });

  // Composing/recording/paused status for whichever jid(s) presenceSubscribe was called on above.
  // Not persisted anywhere yet (ephemeral wake-timing signal only) -- if this needs a durable
  // trail later, that's a deliberate addition to make then, not a side effect of this listener.
  if (onPresence) {
    thisSock.ev.on("presence.update", (update) => {
      if (getSocket() !== thisSock) return;
      safely(onPresence, update, "onPresence");
    });
  }

  return thisSock;
}
