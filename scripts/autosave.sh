#!/usr/bin/env bash
# Autosave daemon: commits every change in the working tree once per minute.
#
# Rationale: this repository is built by a long-running agent session. Losing an
# hour of work to a crash is unacceptable, and a human is not around to press
# "commit". A WIP commit every 60s gives us a complete, replayable history that
# can be squashed before review.
#
# Usage: scripts/autosave.sh [interval_seconds]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${1:-60}"
cd "$REPO_ROOT" || exit 1

while true; do
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A >/dev/null 2>&1
    files=$(git diff --cached --name-only | wc -l | tr -d ' ')
    if git commit -q -m "wip(autosave): $(date '+%Y-%m-%d %H:%M:%S') — ${files} file(s)" >/dev/null 2>&1; then
      echo "[autosave] $(date '+%H:%M:%S') committed ${files} file(s)"
    fi
  fi
  sleep "$INTERVAL"
done
