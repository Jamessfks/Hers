#!/usr/bin/env bash
# PreToolUse — refuse to write where the user's own things live.
#
# hers-profile/ is a real person's companion: six markdown files they wrote and a
# photograph of somebody. data/ is her memory. .env holds credentials. All three
# are gitignored, so a bad edit there is not recoverable with `git checkout`,
# which is the whole reason this is a hook and not a line in CLAUDE.md.
set -uo pipefail

payload=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$payload")
root="${CLAUDE_PROJECT_DIR:-$PWD}"

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Anything matching this, relative to the repo root, is off limits. A case
# statement rather than a PCRE grep, because `grep -P` is not everywhere.
is_protected() {
  case "$1" in
    .env.example|*/.env.example) return 1 ;;
    .env|.env.*|*/.env|*/.env.*) return 0 ;;
    hers-profile|hers-profile/*|anna-profile|anna-profile/*) return 0 ;;
    data|data/*|node_modules|node_modules/*|dist|dist/*|release|release/*) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$payload")
    [ -z "$path" ] && exit 0
    case "$path" in /*) rel="${path#"$root"/}" ;; *) rel="$path" ;; esac
    if is_protected "$rel"; then
      deny "$rel is the user's own data, not source: hers-profile/ is their companion, data/ is her memory, .env holds credentials, and all of it is gitignored so an edit here cannot be undone with git. Ask them to change it themselves, or work on a copy under /tmp."
    fi
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // ""' <<<"$payload")
    # Only a mutating verb aimed at a protected path is worth blocking; reading
    # and grepping them is how you find out what is there.
    if printf '%s' "$cmd" | grep -qE '(^|[|;&[:space:]])(rm|mv|cp|tee|truncate|shred|chmod|chown)[[:space:]]' \
       && printf '%s' "$cmd" | grep -qE '(hers-profile|anna-profile|(^|[[:space:]/])data/|\.env([[:space:]]|$))'; then
      deny "That command mutates hers-profile/, data/, or .env — the user's companion, her memory, and their credentials. All three are gitignored and cannot be restored. Ask before touching them."
    fi
    if printf '%s' "$cmd" | grep -qE '>[[:space:]]*\.?/?(hers-profile|anna-profile|data)/|>[[:space:]]*\.env([[:space:]]|$)'; then
      deny "That redirect writes into the user's own data (hers-profile/, data/, or .env). Those are gitignored and unrecoverable."
    fi
    ;;
esac
exit 0
