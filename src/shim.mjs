import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import { DAEMON_SOCK_PATH, DAEMON_TOKEN_PATH } from "./config.mjs";
import { readDaemonToken } from "./daemon-transport.mjs";

// The client half of the daemon/shim split. Claude Code launches this as the MCP server over stdio,
// and it forwards every JSON-RPC line to the daemon (src/daemon.mjs), which owns the WhatsApp
// socket. It holds no WhatsApp state of its own, which is the point: it can be restarted by the
// client at will, and the daemon can be restarted without the client noticing.
//
// That second half is the only non-trivial thing here. A restarted daemon has never seen this
// client's `initialize`, and the client will not send another, so after reconnecting the shim
// replays the client's own initialize and initialized messages (swallowing the daemon's reply to
// the replayed one) and then tells the client the tool list may have changed. Requests that were in
// flight when the daemon went away are answered with an error rather than left hanging forever,
// since no reply to them is ever coming.

// A request that arrives while the daemon has been unreachable this long is refused instead of
// queued, so a tool call fails visibly rather than hanging until the daemon comes back.
const DOWN_REFUSE_AFTER_MS = 10_000;
const REINIT_TIMEOUT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function splitLines(onLine) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    let at;
    while ((at = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// `connect()` resolves to an already-authenticated duplex stream. Injected so the test can drive a
// fake daemon without a real socket path or token.
export function runShim({
  stdin,
  stdout,
  connect,
  log = () => {},
  retryMs = 500,
  refuseAfterMs = DOWN_REFUSE_AFTER_MS,
  sweepMs = 1000,
}) {
  let sock = null;
  let ready = false;
  let ended = false;
  let downSince = null;
  let reinitCount = 0;
  let initLine = null;
  let initDelivered = false;
  let initializedLine = null;
  let replaced = false;
  const queue = []; // { line, id }: id is set only for a request, so it can be refused while waiting
  const inflight = new Set();
  let pendingReinit = null; // { id, resolve }

  const toClient = (obj) => stdout.write(JSON.stringify(obj) + "\n");
  const refuse = (id, text) => toClient({ jsonrpc: "2.0", id, error: { code: -32000, message: text } });

  const sendToDaemon = (line) => {
    if (initLine && line === initLine) initDelivered = true;
    sock.write(line + "\n");
  };

  const onClientLine = (line) => {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      // not ours to judge: the daemon's parser will report it
    }
    const isInit = msg?.method === "initialize";
    const isInitialized = msg?.method === "notifications/initialized";
    if (isInit) initLine = line;
    if (isInitialized) initializedLine = line;
    const isRequest = msg && msg.id !== undefined && typeof msg.method === "string";
    if (!ready && isRequest && !isInit && downSince && Date.now() - downSince > refuseAfterMs) {
      refuse(msg.id, "WhatsApp daemon is not reachable");
      return;
    }
    if (isRequest) inflight.add(msg.id);
    if (ready) sendToDaemon(line);
    else queue.push({ line, id: isRequest && !isInit ? msg.id : undefined });
  };

  const onDaemonLine = (line) => {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      // forwarded untouched below
    }
    if (msg?.wa_daemon_replaced) {
      // A newer client took the daemon's one connection. Reconnecting would only displace that one
      // in turn, so two live sessions would swap it back and forth forever. Stop instead.
      replaced = true;
      return;
    }
    if (pendingReinit && msg && msg.id === pendingReinit.id) {
      pendingReinit.resolve();
      pendingReinit = null;
      return;
    }
    if (msg && msg.id !== undefined && msg.method === undefined) inflight.delete(msg.id);
    stdout.write(line + "\n");
  };

  // Runs once per connection, and returns when that connection ends.
  const serve = async (stream) => {
    sock = stream;
    const closed = new Promise((resolve) => {
      stream.once("close", resolve);
      stream.once("error", resolve);
    });
    // A persistent listener, so an error after the once() handlers below have fired (a write to a
    // destroyed socket) can never be an unhandled event that crashes the shim.
    stream.on("error", () => {});
    stream.on("data", splitLines(onDaemonLine));

    if (initDelivered) {
      const id = `wa-shim-reinit-${++reinitCount}`;
      const reply = new Promise((resolve) => {
        pendingReinit = { id, resolve };
      });
      stream.write(JSON.stringify({ ...JSON.parse(initLine), id }) + "\n");
      const answered = await Promise.race([
        reply,
        closed.then(() => false),
        sleep(REINIT_TIMEOUT_MS).then(() => false),
      ]);
      pendingReinit = null;
      if (answered === false) {
        log("re-initialize failed, dropping the connection");
        stream.destroy();
        await closed;
        return;
      }
      if (initializedLine) stream.write(initializedLine + "\n");
      toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      log("replayed initialize on the new connection");
    }

    ready = true;
    downSince = null;
    while (queue.length) sendToDaemon(queue.shift().line);
    await closed;

    ready = false;
    sock = null;
    // Not "retry it": a send may already have gone out before the daemon went away, and retrying
    // would deliver a second copy. The caller has to look first.
    for (const id of inflight) {
      refuse(
        id,
        "WhatsApp daemon restarted while this request was in flight. It may already have run, check before retrying",
      );
    }
    inflight.clear();
  };

  const loop = (async () => {
    while (!ended) {
      let stream;
      try {
        stream = await connect();
      } catch (err) {
        downSince ??= Date.now();
        log(`daemon not reachable: ${err.message ?? err}`);
        await sleep(retryMs);
        continue;
      }
      await serve(stream);
      if (replaced) {
        log("another client took the daemon connection, exiting");
        ended = true;
      }
      if (!ended) await sleep(retryMs);
    }
  })();

  // A request queued while the daemon is down is refused once the outage has lasted long enough.
  // Checking only when a request arrives would leave one queued early waiting forever.
  const sweep = setInterval(() => {
    if (ready || !downSince || Date.now() - downSince <= refuseAfterMs) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].id === undefined) continue;
      const { id } = queue.splice(i, 1)[0];
      inflight.delete(id);
      refuse(id, "WhatsApp daemon is not reachable");
    }
  }, sweepMs);

  stdin.on("data", splitLines(onClientLine));
  stdin.once("end", () => {
    ended = true;
    sock?.destroy();
  });
  return loop.then(() => {
    clearInterval(sweep);
    return replaced ? "replaced" : "closed";
  });
}

// The CLI: what Claude Code actually launches.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connect = () =>
    new Promise((resolve, reject) => {
      const stream = netConnect(DAEMON_SOCK_PATH);
      stream.once("error", reject);
      stream.once("connect", () => {
        stream.off("error", reject);
        stream.write(JSON.stringify({ wa_daemon_auth: readDaemonToken(DAEMON_TOKEN_PATH) }) + "\n");
        resolve(stream);
      });
    });
  // stderr only: stdout is the JSON-RPC channel and a stray write there corrupts the stream.
  const result = await runShim({
    stdin: process.stdin,
    stdout: process.stdout,
    connect,
    log: (line) => process.stderr.write(`whatsapp-mcp shim: ${line}\n`),
  });
  process.exit(result === "replaced" ? 1 : 0);
}
