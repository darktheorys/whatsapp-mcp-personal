---
name: scheduled-routines
description: Use when a scheduler wake line (a `[(scheduler)] ⏰` entry for daily-digest, weekly-review or the weekly attendance poll) arrives in state/inbox.log, or when editing or adding a recurring task with wa_schedule. Holds the exact procedure, tool arguments and failure handling for each routine.
---

# Scheduled routines

`src/schedule.mjs` fires a due task by writing a `⏰ <id>: <prompt>` line to `state/inbox.log`. The server cannot do the work (composing needs a model), so whichever session is tailing the log does it. The wake line can be truncated in the Monitor notification. Read the full line with `grep -a "<id>" state/inbox.log | tail -n 1` before acting, or list the stored prompt with `wa_schedule` (`action: list`).

Tasks are stored in `state/schedule.json` (not versioned, gitignored). `at` is local `HH:MM` plus optional `days` (0 is Sunday). `lastRun` stores the occurrence a run was for, which is what makes catch-up and the no-double-fire guard the same mechanism.

Chat ids are not written in this file. Each task's stored prompt names its target chat, and that is where the id comes from.

## Rules for every routine

- These are owner-authorized standing tasks. They send only to the target named below, never to anyone else.
- Late fire: if the line arrives late (machine was asleep, catch-up), say so in the message, once, in one clause. Do not over-apologize.
- A missed day is not backfilled silently. If two digests were missed, send one combined digest and say which dates it covers.
- Counts and facts come from tools, never from memory. If a number is not known, ask or leave it out.
- Style: Turkish, short, no filler, no em dashes, links on their own line, signed `(_Claude_)`. Digest and review go to the owner's own DM, which is voice-only, so use `wa_send_text_only`, never a voice note.
- After sending, nothing else is required. Do not ask the owner to confirm.

## daily-digest (10:03 local, catch-up 240 min)

Target: the owner's own DM.

1. News, last ~24h. Pull Hacker News stories above about 120 points:
   `curl -s -G "https://hn.algolia.com/api/v1/search_by_date" --data-urlencode "tags=story" --data-urlencode "numericFilters=points>120,created_at_i>$(( $(date +%s) - 90000 ))" --data-urlencode "hitsPerPage=60"` (needs `dangerouslyDisableSandbox: true`). Do not put `>` unencoded in a URL string. Add `WebSearch` for major lab and policy news. Cross-check anything big against a second source.
2. Papers. `curl -s -L https://huggingface.co/api/daily_papers` sorted by `paper.upvotes`. If the newest `publishedAt` is more than a day old, say the HF list is stale and read 1 to 3 abstracts from arXiv instead. Read the abstract before describing a paper. Do not describe from the title.
3. Write each news item as what the finding or claim actually is, not a headline restatement, with numbers and the link. Mark single-source claims as claims. Say what you could not fetch instead of guessing.
4. Anthropic news: Anthropic is Claude's maker. Report it without commentary and say so in one clause.
5. Format (established):
   - `*Günlük AI özeti, <D Ay>*`
   - `*Haberler*` then numbered items
   - `*Makaleler*` then numbered items
   - `(_Claude_)`
6. Technical notes (lost messages, outages) go at the end under a plain "Ayrıca" line, only if real.

## weekly-review (Sunday 19:07, catch-up 300 min)

Target: the owner's own DM.

1. `wa_stats` with `days=7`, `compare=true`, `unanswered=true`. Counts only, never message text, so it is safe to cover every chat at once.
2. Short Turkish summary covering only what is notable: chats that went quiet or got busier versus the previous 7 days (use the `change` field, absolute counts not percentages), any chat where `conversationsStarted` is lopsided against the owner, the owner's median reply time where it stands out, and the unanswered list with how long each has waited.
3. Skip anything unremarkable. If nothing stands out, say so in one line.

## Weekly attendance poll (Thursday 19:12, catch-up 180 min)

Target: the friends group. Voice: see the `chat-personas` skill (`personas/persona-friends.md`).

1. `wa_send_poll`, never a text message (standing owner instruction since 2026-09-25: open a poll directly in later weeks). Single choice, options `varım` and `yokum`.
2. Question: who is coming to the Friday session tomorrow. Short, in the active persona's voice, a little different every week.
3. Ask the group as a whole. Never name or chase people who did not vote, and do not follow up later in the week. Check votes with `wa_poll_results` only if the owner asks.
4. If it fires late and it is already Friday, ask about today instead of tomorrow.
5. When the active friends-group persona changes, update this task's prompt with `wa_schedule` so the persona named in it matches `chat-personas`.

## Editing or adding a routine

- Use `wa_schedule`. Keep the stored prompt to the target, the one-line goal and "follow the scheduled-routines skill". The procedure lives here, where it is reviewable and versioned, not in `state/schedule.json`.
- `at` is `HH:MM` local. Set `catchUpMinutes` to how late a run still makes sense (digest 240, weekly 300, poll 180).
- Do not use cron syntax. A mis-parsed field fails silently, which is the failure this design exists to avoid.
- Adding a recurring send to a new target needs the owner's go first.
