// Entry point for the long-running WhatsApp server, started by launchd (scripts/install-daemon.sh)
// rather than by Claude Code. Claude Code launches src/shim.mjs instead, which forwards to this.
//
// All it does is pick the socket transport before server.mjs loads, because server.mjs decides
// between stdio and the socket at import time. The server, its guards and its scheduler are exactly
// the ones the stdio mode runs, so nothing about what a tool call is allowed to do changes.
process.env.WA_TRANSPORT = "socket";

const { ensureDirs } = await import("./config.mjs");
ensureDirs();
await import("./server.mjs");

// launchd stops the job with SIGTERM. Exiting promptly (rather than finishing a WhatsApp handshake
// that is about to be thrown away) keeps `launchctl kickstart -k` a quick operation.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
