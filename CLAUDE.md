# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal, self-contained MCP server (stdio transport) that lets a Claude Code session read and
send WhatsApp messages on one real number, via Baileys (an unofficial WhatsApp Web protocol
client). Everything — code, auth keys, message logs, config — lives under this repo; nothing is
read from or written to any other project or `~`.

## Commands

```bash
pnpm install                      # installs deps; postinstall runs scripts/setup-voice.sh (macOS-only, no-op-safe)
node src/pair.mjs <digits>        # one-time device pairing (country code + number, no +); run directly, not via MCP
pnpm start                        # node src/server.mjs — normally launched by Claude Code as an MCP server, not run directly
pnpm test                         # node test_allowlist.mjs — the entire test suite, one file, run top to bottom
pnpm format / pnpm format:check   # oxfmt over src/, scripts/, test_allowlist.mjs
pnpm lint                         # oxlint over the same paths
bash scripts/setup-voice.sh [tier]  # re-run voice setup directly; pass low/mid/high to fetch one whisper model
```

There is no per-test filtering — `test_allowlist.mjs` is a single sequential script (allowlist
matching, command regexes, secret scanning, sendable-path checks, SQLite store round-trips, rate
limiting). Add new assertions to it rather than creating a second test file. It sets
`WA_CONFIG_PATH`/`WA_DB_PATH`/`WA_NO_CONNECT` env vars *before* importing `src/config.mjs` /
`src/server.mjs`, since those modules resolve paths and open a WhatsApp socket at import time —
new test code that needs a fresh config/db must follow the same import-order pattern.

Register the server with Claude Code from whichever project should be able to drive WhatsApp:

```bash
claude mcp add whatsapp-personal -- node /absolute/path/to/whatsapp-mcp-personal/src/server.mjs
```

**After editing any file under `src/`, an `/mcp` reconnect is required** — the server process only
loads code at startup, so changes don't take effect until Claude Code reconnects.

## Architecture

Four files under `src/`, each importable independently and wired together in `server.mjs`:

- **`config.mjs`** — reads/writes `state/config.json` (allowlist + per-chat settings:
  `no_image_jids`, `no_voice_jids`, `mention_only_jids`, `voice_only_jids`, plus global
  `speaking_rate`/`s2t_tier`). `allowedJid(...jids)` is the single gate every inbound/outbound path
  checks — it takes multiple candidate JIDs because WhatsApp addresses the same chat two ways (the
  phone-number JID and a privacy-preserving `@lid` form), and a message can arrive under either.
- **`whatsapp.mjs`** — owns the one Baileys socket (`sock`) and reconnect logic. `connectionState()`
  is the authoritative "is this actually usable" check — it tracks `lastError` separately from the
  socket object because a logged-out socket keeps `.user` set and looks alive to a naive check.
  WhatsApp allows exactly one live socket per linked device; if another process takes over
  (`connectionReplaced`), this process exits deliberately rather than idling as a dead MCP server.
- **`store.mjs`** — SQLite (`node:sqlite`, no dependency) at `state/messages.db`. One `messages`
  table: a handful of real columns (`jid`, `id`, `ts`, `text`, `archived`) plus the entire original
  entry as `json`, with a few fields (`media_kind`, `to_id`, `reply_to_id`, `view_once`) promoted to
  indexed `GENERATED ALWAYS AS (json_extract(...))` virtual columns so new message shapes never need
  a migration. Nothing is ever mutated: an edit or delete is its own row pointing at the original
  via `to_id`, and reads derive `edited`/`deleted` status at query time (`withStatus`) rather than
  rewriting the original row. `state/inbox.log` is a separate plain-text file (not in SQLite) — a
  `Monitor` tails it to wake a Claude session on new messages, and "tail a database" isn't a thing.
- **`server.mjs`** — the MCP server: registers all `wa_*` tools, plus the inbound message/reaction
  handlers (`handleIncoming`, `handleReaction`) passed into `startWhatsApp`. This is also where all
  the send-side guardrails live (see Security below) and where in-chat slash commands
  (`/wakelevel`, `/speaking`, `/speaking-speed`, `/s2t-tier`, `/read-image`, `/read-audio`) are
  parsed and applied.

`pair.mjs` is a separate, one-time entry point run directly in a terminal (never through Claude
Code) — it's the only file allowed to use `console.log`.

### Critical: stdout is the MCP protocol channel

MCP over stdio uses stdout for JSON-RPC. **Never add `console.log` (or anything else writing to
stdout) in `server.mjs`, `store.mjs`, `config.mjs`, or `whatsapp.mjs`** — it corrupts the protocol
stream. Use `process.stderr.write` or the `state/baileys.log` pino logger instead.

### Security model (multiple independent layers, not one gate)

- **`allowedJid`** (config.mjs) gates *who* can be read from or written to — the allowlist in
  `state/config.json`.
- **`guardSend(to, text)`** (server.mjs) is the shared preamble every `wa_*` send tool calls, in a
  deliberate order: allowlist check → `scanOutbound` secret scan → connection liveness → rate limit
  (checked last because it *consumes* budget, and an earlier refusal must not spend a slot).
- **`scanOutbound`** refuses sends matching private-key/AWS/GitHub/Slack/API-key/JWT shapes, or
  containing exact substrings from `state/auth/creds.json` — this holds regardless of *why* the
  model assembled the text, including if it was talked into it by untrusted chat content.
- **`resolveSendable(path)`** confines outbound file sends (`wa_send_image`, `wa_send_audio`) to
  `state/memes/` and the session scratchpad — never `state/media/`, which holds what other chats
  sent *in*; allowing it as a source would make cross-chat forwarding a single tool call. Paths are
  resolved with `realpathSync` first so a symlink can't escape the check.
- **`guardOwnMessage(jid, messageId)`** restricts `wa_edit`/`wa_delete` to messages this server
  itself sent (tagged `by: "claude"` at send time) — `key.fromMe` alone isn't enough, since the
  owner's own phone-typed messages are `fromMe` too.
- **In-chat slash commands are gated on `key.fromMe`** — only the owner's own device can flip
  per-chat settings; a message from anyone else in a group must never match `COMMANDS.*` (all
  regexes are anchored `^...$`, exported from `server.mjs` and imported by the test rather than
  duplicated, so a loosened anchor breaks the test instead of silently passing).
- **`overSendLimit()`** caps sends (including reactions) at 20/min as an anti-flood/anti-ban
  backstop.
- `.claude/settings.json` denies reading `state/messages.db`/`-wal`/`-shm`, `state/auth/**`, and
  other state files directly, and `.claude/deny-outside-repo.sh` (a `PreToolUse` hook) confines
  Claude Code's own file/Bash tools to this repo plus the session scratchpad. These are convenience
  layers on top of the guards above, not the primary boundary.

When touching any send path, media path, or in-chat command parsing, preserve these layers —
`test_allowlist.mjs` has explicit regression cases for most of them (e.g. `guardSend` must call
`scanOutbound` itself, not rely on callers already having checked it).

### Dependency policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 43200` (30 days) so no newly-published package
version (including transitive deps) installs until it's had time to be caught if compromised.
`@whiskeysockets/baileys` is explicitly excluded from that wait, since it tracks a WhatsApp
protocol that changes without notice and an old pinned version there just means "stops working."
Add new exceptions to `minimumReleaseAgeExclude` rather than lowering the global number.
