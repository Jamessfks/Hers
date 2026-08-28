---
description: Prove the privacy claims still hold — every outbound host is declared, documented, and nothing phones home. Use before a release, after touching anything that fetches, or when asked to check what the program can reach.
argument-hint: "[optional: a path to focus on]"
allowed-tools: Bash(npm test:*), Bash(npm run typecheck:*), Bash(grep:*), Bash(rg:*), Read, Glob
---

# Privacy gate

Three claims hold this project up. Check them in this order and report evidence,
not verdicts.

## 1. The list matches the code

```bash
npm test 2>&1 | grep -iA2 "destination\|privacy\|host"
```

`destinations.test.ts` walks the source for URL literals and fails on any host
not in `src/shared/destinations.ts`. A second test fails if `docs/PRIVACY.md`
does not name every entry. If both pass, the three artefacts agree.

## 2. Nothing new reaches out

Search the diff — not the whole tree — for outbound calls that arrived since the
last release:

```bash
git diff --unified=0 $(git describe --tags --abbrev=0)..HEAD -- 'src/**' 'call/**' \
  | grep -nE '^\+.*(https?://|wss?://|fetch\(|new WebSocket|require\(.http|net\.connect)'
```

Every hit must correspond to a `DESTINATIONS` entry. A hit in a comment or a
documentation link belongs in `MENTIONED_ONLY` — confirm which it is by reading
the line, not by guessing from the file it is in.

## 3. Nothing phones home

```bash
grep -rniE 'telemetry|analytics|sentry|posthog|mixpanel|amplitude|bugsnag|crashlytics|update.?check|phone.?home' src scripts call --include='*.ts' --include='*.html' --include='*.css'
```

Expect hits only in prose that promises the absence. Anything that is a call site
is a finding, and it is the most serious kind this repo has.

## 4. No CDN

```bash
grep -rnE '(src|href)=["'\'']https?://' src/web call --include='*.html' --include='*.ts'
```

Any external asset reference in a served page is a regression. Fonts, scripts,
and images come from the machine.

## Report

For each of the four, print the command you ran and what it returned. Then one
line: **held** or **broken**, and for broken, the exact file and line. Do not
widen the allowlist to make a check pass — if a dependency dials somewhere
unexpected, that is the finding.
