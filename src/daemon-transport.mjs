import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// The daemon half of the daemon/shim split. The MCP server used to be a child of Claude Code over
// stdio, which tied the one WhatsApp socket to the client's lifetime: every `/mcp` reconnect killed
// the process, dropped the socket, and opened a window where Baileys (which only delivers to a live
// socket) loses messages. Here the server runs on its own under launchd and speaks the same
// newline-delimited JSON-RPC over a unix socket instead, so a client reconnect only replaces the
// connection, not the process holding WhatsApp.
//
// Deliberately the SDK's own StdioServerTransport pointed at the socket rather than a new
// transport: the framing, buffering and size limits are the part that is easy to get subtly wrong,
// and it already takes arbitrary streams.

const AUTH_MAX_BYTES = 4096;
const AUTH_TIMEOUT_MS = 5000;

// Hashed first so the comparison is fixed-length, which timingSafeEqual requires, and so a wrong
// token's length is not observable either.
function tokensMatch(given, expected) {
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Created once by the daemon and read by the shim. The socket is already mode 0600 inside a 0700
// directory, so this is a second layer, not the only one: it exists so that "any process running as
// this user can open the socket" does not also mean "can send WhatsApp messages". The token file is
// denied to Claude Code's own tools in .claude/settings.json for the same reason credentials are.
export function loadOrCreateDaemonToken(path) {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    // An empty or truncated file (a write that died halfway) must not become the token: an empty
    // token would be matched by an empty auth string. Regenerate instead.
    if (existing.length >= 32) {
      chmodSync(path, 0o600);
      return existing;
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function readDaemonToken(path) {
  return readFileSync(path, "utf8").trim();
}

// A daemon that starts while another is already listening must refuse, not delete the other's
// socket file out from under it. A stale file (previous daemon killed hard) refuses connections, and
// that is the only case where it is safe to remove.
function socketIsLive(path) {
  return new Promise((resolve) => {
    const probe = netConnect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

// One client at a time, mirroring the old stdio behaviour where a second session took over: a new
// authenticated connection closes the previous one. `server` is the McpServer, which can only be
// connected to a single transport, so the previous one has to be closed first.
export async function serveOnSocket(server, { path, token, log = () => {} }) {
  if (existsSync(path)) {
    if (await socketIsLive(path)) throw new Error(`another daemon is already listening on ${path}`);
    unlinkSync(path);
  }

  let active = null;
  // Connections are handled one after another so two arriving together cannot both reach connect().
  let chain = Promise.resolve();

  // Each connection closes its transport at most once. StdioServerTransport.close() has no guard and
  // runs onclose every time, and the Protocol's onclose clears `_transport` on the *server*, so a
  // second close of an old connection's transport (its socket's "close" event arriving after it was
  // already replaced) would detach the NEW client and abort its in-flight requests.
  const closeConnection = async (conn) => {
    if (conn.closed) return;
    conn.closed = true;
    await conn.transport.close().catch(() => {});
    conn.socket.destroy();
  };

  const attach = async (socket, rest) => {
    if (active) {
      const previous = active;
      active = null;
      // Said before it is closed, so the displaced shim knows it lost the connection to a newer
      // client and stops, instead of reconnecting and displacing that one in turn, forever.
      previous.socket.write(JSON.stringify({ wa_daemon_replaced: true }) + "\n");
      await closeConnection(previous);
    }
    const input = new PassThrough();
    const transport = new StdioServerTransport(input, socket);
    const mine = { socket, transport, closed: false };
    active = mine;
    const drop = () => {
      if (active === mine) active = null;
      void closeConnection(mine);
    };
    socket.once("close", drop);
    socket.once("error", drop);
    socket.pipe(input);
    if (rest.length) input.write(rest);
    await server.connect(transport);
    log("client connected");
  };

  const listener = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      log("auth timeout, closing");
      socket.destroy();
    }, AUTH_TIMEOUT_MS);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > AUTH_MAX_BYTES) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      let given;
      try {
        given = JSON.parse(buffered.subarray(0, newline).toString("utf8")).wa_daemon_auth;
      } catch {
        // falls through to the refusal below
      }
      if (typeof given !== "string" || !tokensMatch(given, token)) {
        log("refused a connection with a bad token");
        socket.destroy();
        return;
      }
      const rest = buffered.subarray(newline + 1);
      chain = chain.then(() => attach(socket, rest)).catch((err) => log(`attach failed: ${err}`));
    };
    socket.on("data", onData);
    socket.once("error", () => clearTimeout(timer));
    socket.once("close", () => clearTimeout(timer));
  });

  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(path, () => {
      listener.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  log(`listening on ${path}`);

  return {
    async close() {
      listener.close();
      if (active) {
        // The connection has to be destroyed, not just the transport closed: closing the listener
        // leaves an established socket open, and a client that is never told the daemon is gone
        // never reconnects.
        const current = active;
        active = null;
        await closeConnection(current);
      }
      if (existsSync(path)) unlinkSync(path);
    },
  };
}
