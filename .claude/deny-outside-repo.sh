#!/usr/bin/env bash
# PreToolUse gate: keep file access inside this repo, and keep Bash away from credentials.
#
# A denylist of sensitive paths is always incomplete — it protects what you thought to name.
# For the file tools this inverts that: everything is refused except the repo and the session
# scratchpad, so a path nobody anticipated is refused by default rather than allowed by omission.
#
# Bash cannot be gated that precisely: a shell command is a program, not a path, and deciding
# what it will read means interpreting it. What is enforced here is narrower on purpose, and
# stated plainly so it isn't mistaken for a sandbox: any path that resolves under $HOME but
# outside the repo is refused, and any mention of a known credential location is refused.
# System directories stay readable because binaries live there and secrets do not. A command
# that constructs a path at runtime can still slip through — `sandbox.enabled` is the real
# boundary for that, this is the cheap layer in front of it.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRATCH="/private/tmp/claude-$(id -u)"

# Every decision below is parsed out with jq. Without it, `tool` comes back empty, control falls
# past the Bash branch, `target` is empty too, and the script exits 0 — allow. A gate that silently
# does nothing is worse than no gate, because the deny list in settings.json still reads as
# enforced. Exit 2 instead: a visible error beats a silent bypass.
if ! command -v jq >/dev/null 2>&1; then
  echo "deny-outside-repo: jq is not installed; refusing to run without it." >&2
  exit 2
fi

input="$(cat)"
tool="$(jq -r '.tool_name // ""' <<<"$input")"

deny() {
  jq -n --arg r "$1" --arg why "$2" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Blocked: " + $r + " " + $why)
    }
  }'
  exit 0
}

# Resolves `..` and symlinks against the real filesystem so neither can walk out of a root.
# The file itself need not exist (its parent must), so this covers writes to new paths too.
resolve() {
  local target="$1" dir
  dir="$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)" || return 1
  [[ -z "$dir" ]] && return 1
  printf '%s/%s' "$dir" "$(basename "$target")"
}

inside() { # inside <path> <root>
  [[ "$1" == "$2" || "$1" == "$2"/* ]]
}

if [[ "$tool" == "Bash" ]]; then
  cmd="$(jq -r '.tool_input.command // ""' <<<"$input")"
  [[ -z "$cmd" ]] && exit 0

  # Named credential locations are refused wherever they appear, including forms that never
  # resolve to a path here (`cd ~; cat .ssh/config`, a heredoc, an argument to some other tool).
  #
  # `messages.db` is in here for the same reason `state/messages/` is in settings.json's deny list:
  # wa_recent and wa_search make you name a chat so one chat's content can't be pulled into another,
  # and reading the store directly walks around that. Note the limit honestly — this matches the
  # command *text*, so `sqlite3 state/messages.db` is caught while a script that opens the same file
  # without naming it is not. It stops the casual path, not a determined one; sandbox.enabled is the
  # real boundary for Bash.
  if grep -qE '(\.ssh|\.aws/|\.gnupg|\.netrc|\.git-credentials|\.pypirc|\.npmrc|id_rsa|id_ed25519|id_ecdsa|Keychains|\.credentials\.json|state/auth|messages\.db|state/contacts\.json|state/poll-state\.json|/\.env)' <<<"$cmd"; then
    deny "this command" "references a credential location or the message store. Read it through a tool if you genuinely need it, so the deny rules apply."
  fi

  # Textual expansion first: the resolver sees literal paths, not shell variables.
  expanded="${cmd//\$\{HOME\}/$HOME}"
  expanded="${expanded//\$HOME/$HOME}"
  expanded="${expanded//\~\//$HOME/}"

  while IFS= read -r token; do
    [[ -z "$token" ]] && continue
    real="$(resolve "$token")" || continue
    # Only $HOME is gated. Secrets live under the user's home; /usr, /opt and friends hold the
    # binaries these commands legitimately invoke, and gating those would break normal work.
    if inside "$real" "$HOME" && ! inside "$real" "$REPO" && ! inside "$real" "$SCRATCH"; then
      deny "$real" "is under your home directory but outside this repo."
    fi
  done < <(grep -oE '(/|\./|\.\./)[^[:space:]"'"'"';|&)>]*' <<<"$expanded")

  exit 0
fi

# File tools: repo and scratchpad only.
target="$(jq -r '.tool_input.file_path // .tool_input.path // ""' <<<"$input")"
[[ -z "$target" ]] && exit 0 # no explicit path (e.g. Glob) defaults to cwd, which is the repo

resolved="$(resolve "$target")" || exit 0 # unresolvable parent: let the tool report its own error

if inside "$resolved" "$REPO" || inside "$resolved" "$SCRATCH"; then
  exit 0
fi

deny "$resolved" "is outside this repository and the session scratchpad, the only readable locations."
