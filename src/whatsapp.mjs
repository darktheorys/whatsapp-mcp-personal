import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import { AUTH_DIR, LOG_PATH, ensureDirs } from "./config.mjs";

// MCP runs over stdio: stdout is the JSON-RPC channel. Baileys' logger must never touch it.
ensureDirs();
export const logger = pino({ level: "warn" }, pino.destination({ dest: LOG_PATH, mkdir: true }));

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

export async function startWhatsApp({ onMessage, onReaction }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const thisSock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
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
      lastError = null;
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
        return;
      }
      lastError = `disconnected (${statusCode ?? "unknown"}) — reconnecting`;
      // WhatsApp allows one live connection per linked device. Reconnecting after another
      // instance took over just kicks it off again, and the two ping-pong forever.
      if (statusCode === DisconnectReason.connectionReplaced) {
        // Idling here would leave a dead process an MCP client could still be talking to,
        // producing a silent "Connection Closed" on every tool call until someone notices.
        // Exiting makes the failure visible immediately instead.
        logger.error(
          "Another instance took over this WhatsApp session — exiting so a stale process isn't left running.",
        );
        process.exit(1);
      }
      // A short delay before retrying avoids a tight reconnect loop hammering WhatsApp's
      // servers if the connection keeps failing immediately (robotic-looking retries are
      // themselves one of the signals WhatsApp's abuse detection weighs).
      setTimeout(() => {
        startWhatsApp({ onMessage, onReaction }).catch((err) => logger.error(err, "reconnect failed"));
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

  return thisSock;
}
