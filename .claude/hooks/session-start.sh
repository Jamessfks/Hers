#!/usr/bin/env bash
# SessionStart — three lines of orientation, and only the ones that vary.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

lines=""
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) && lines="branch $branch"
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "${dirty:-0}" -gt 0 ] && lines="$lines, $dirty uncommitted file(s)"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null \
  || lines="$lines — WARNING: node $(node --version 2>/dev/null) is below the 22.18 floor; node:sqlite and type-stripping will fail"

[ -z "$lines" ] && exit 0
jq -n --arg l "$lines" '{
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ("Hers: " + $l + ".") }
}'
