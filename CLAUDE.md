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

## YouTube / video search and download

There is no MCP server for this and there will not be one (per Burak, 2026-08-16) — don't suggest
connecting one. The working path is `WebSearch` for the video + the local
`.claude/skills/yt-dlp/scripts/*.py` scripts to download/watch it. See README's "YouTube / video
tools" and "Meme Tools" → "When the Gist has no match" sections for the full workflow and pitfalls.

## Architecture

Four files under `src/`, each importable independently and wired together in `server.mjs`:

- **`config.mjs`** — reads/writes `state/config.json` (allowlist + per-chat settings:
  `no_image_jids`, `no_voice_jids`, `mention_only_jids`, `voice_only_jids`, plus global
  `speaking_rate`/`s2t_tier`). `allowedJid(...jids)` is the single gate every inbound/outbound path
  checks — it takes multiple candidate JIDs because WhatsApp addresses the same chat two ways (the
  phone-number JID and a privacy-preserving `@lid` form), and a message can arrive under either.
- **`whatsapp.mjs`** — owns the one Baileys socket (`sock`) and reconnect logic. **`markOnlineOnConnect: false`
  is load-bearing and must stay:** Baileys defaults it to `true`, which announces this process as an
  active online device, and WhatsApp then stops pushing notifications to the owner's phone. Merely
  running the server was enough to swallow them. For the same reason nothing here ever marks
  messages read (`readMessages`/`chatModify({markRead})`) — read state is account-level and syncs to
  the phone, so reading a chat for context would clear the owner's own unread badge. `connectionState()`
  is the authoritative "is this actually usable" check — it tracks `lastError` separately from the
  socket object because a logged-out socket keeps `.user` set and looks alive to a naive check.
  WhatsApp allows exactly one live socket per linked device; if another process takes over
  (`connectionReplaced`), this process exits deliberately rather than idling as a dead MCP server.
  Also subscribes to presence updates (`presenceSubscribe`) for every allowlisted jid on connect and
  forwards `presence.update` events via the `onPresence` callback — `server.mjs`'s
  `handlePresenceUpdate` uses this purely to debounce the wake signal (see "Event-driven wake" in
  the README), not to persist anything.
- **`store.mjs`** — SQLite (`node:sqlite`, no dependency) at `state/messages.db`. One `messages`
  table: a handful of real columns (`jid`, `id`, `ts`, `text`, `archived`) plus the entire original
  entry as `json`, with a few fields (`media_kind`, `to_id`, `reply_to_id`, `view_once`,
  `direction`, `kind`) promoted to indexed `GENERATED ALWAYS AS (json_extract(...))` virtual columns
  so new message shapes never need a migration. Search goes through a second, plain FTS5 table
  (`messages_fts`, `tokenize="trigram"`) holding a *normalised* copy of each message's text —
  `normalizeForSearch` lowercases, strips diacritics via NFD, and maps dotless `ı`, so a query typed
  on an English keyboard finds Turkish text (`seker` → `şeker`). Trigram specifically, because the
  default `unicode61` tokeniser is word-based and would stop matching fragments inside words, which
  the LIKE search it replaced always did. Queries under 3 characters fall back to LIKE, since a
  trigram index has no window that short. The needle is wrapped as an FTS5 *phrase* — a bare MATCH
  argument is a query expression where a stray `*` or `NEAR` is a syntax error or a different
  search. Nothing is ever mutated: an edit or delete is its own row pointing at the original
  via `to_id`, and reads derive `edited`/`deleted` status at query time (`withStatus`) rather than
  rewriting the original row. `state/inbox.log` is a separate plain-text file (not in SQLite) — a
  `Monitor` tails it to wake a Claude session on new messages, and "tail a database" isn't a thing.
- **`server.mjs`** — the MCP server: registers all `wa_*` tools, plus the inbound message/reaction
  handlers (`handleIncoming`, `handleReaction`) passed into `startWhatsApp`. Every tool carries MCP
  `annotations` (`readOnlyHint`/`destructiveHint`/`openWorldHint`) so a client's approval UI can
  tell a read from a send — hints only, never a substitute for the guards below. Operational events
  (whisper/Piper tier fallback, secret-scan refusals, connection loss and takeover) also go out as
  MCP logging notifications via `notify()`, because `state/baileys.log` is denied to Claude Code's
  own Read tool and was therefore invisible to the one reader who could act on it. This is also where all
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
