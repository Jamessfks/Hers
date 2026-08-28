#!/usr/bin/env bash
# Stop — the turn does not end on unverified source.
#
# `npm run check` is typecheck plus 525 tests in about 20 seconds, needs no API
# key and touches no network, which is what makes it usable as a gate. It runs
# only when tracked source actually changed, and it blocks at most once per
# distinct broken state, so a genuinely stuck fix does not cost twenty seconds
# eight times over.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

changed=$(git status --porcelain -- src scripts call 2>/dev/null)
[ -z "$changed" ] && exit 0

cache="$root/.claude/.cache"
mkdir -p "$cache"
state=$( { printf '%s' "$changed"; git diff HEAD -- src scripts call; } | shasum | cut -d' ' -f1)

[ "$(cat "$cache/passed" 2>/dev/null)" = "$state" ] && exit 0

if out=$(npm run --silent check 2>&1); then
  printf '%s' "$state" > "$cache/passed"
  exit 0
fi

# Same broken state as last time: say it again, but let the turn end.
if [ "$(cat "$cache/failed" 2>/dev/null)" = "$state" ]; then
  jq -n '{ systemMessage: "npm run check is still failing on the same state — not blocking again." }'
  exit 0
fi
printf '%s' "$state" > "$cache/failed"

tail=$(printf '%s' "$out" | tail -40)
jq -n --arg o "$tail" '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    decision: { block: true },
    reason: ("`npm run check` fails on the source you changed. Fix it, or say plainly that it is broken and why — do not finish quietly.\n\n" + $o)
  }
}'
exit 0
