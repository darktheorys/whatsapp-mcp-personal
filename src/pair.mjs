import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";

import { AUTH_DIR, ensureDirs } from "./config.mjs";

const phone = process.argv[2];
if (!phone || !/^\d{6,15}$/.test(phone)) {
  console.error("Usage: node src/pair.mjs <countrycode+number, digits only, no +>");
  process.exit(1);
}

ensureDirs();
const logger = pino({ level: "warn" });

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);

  let requested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // WhatsApp signals it's ready to pair by emitting a qr. Asking before that arrives
    // gets the socket terminated mid-handshake, so the request has to wait for it.
    if (qr && !requested && !sock.authState.creds.registered) {
      requested = true;
      const code = await sock.requestPairingCode(phone);
      console.log(`\nPairing code: ${code}\n`);
      console.log(
        "On your phone: WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead.",
      );
      console.log("The code expires in about a minute. Enter it now.\n");
    }

    if (connection === "open") {
      console.log("Linked. Auth state saved to state/auth/ — you can now run `npm start`.");
      process.exit(0);
    }

    if (connection === "close") {
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        console.error("Logged out — delete state/auth/ and pair again.");
        process.exit(1);
      }
      console.log("Connection closed, reconnecting...");
      setTimeout(connect, 3000);
    }
  });
}

connect();
