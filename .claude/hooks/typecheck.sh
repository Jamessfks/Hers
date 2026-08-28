#!/usr/bin/env bash
# PostToolUse — 1.5 seconds of tsc after a TypeScript edit, reported not enforced.
#
# Deliberately non-blocking. Halfway through a two-file change the tree does not
# typecheck and that is not a mistake; the Stop hook is where it has to be green.
set -uo pipefail

payload=$(cat)
path=$(jq -r '.tool_input.file_path // ""' <<<"$payload")
case "$path" in *.ts|*.tsx|*.mts|*.cts) ;; *) exit 0 ;; esac

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
out=$(npm run --silent typecheck 2>&1) && exit 0

jq -n --arg o "$(printf '%s' "$out" | grep -E 'error TS' | head -20)" '{
  systemMessage: ("tsc after the edit:\n" + $o),
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("`npm run typecheck` is failing:\n" + $o + "\n\nExpected mid-change. Make it green before you finish.")
  }
}'
exit 0
