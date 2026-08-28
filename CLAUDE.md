# Hers

An ambient AI companion that runs entirely on the user's own machine. TypeScript,
Node ≥22.18, no server build step — `node` runs the `.ts` files directly. Only
`src/web` is bundled (Vite).

## Commands

```bash
npm run check           # typecheck + 525 tests, ~20s, no API key, no network. The gate.
npm run typecheck       # ~2s — two tsc projects: root and src/web
npm test                # node --test over src/**/*.test.ts
npm run dev             # rebuild site + restart server on save → http://127.0.0.1:5175
npm run doctor          # opens a real Gemini session; needs GEMINI_API_KEY, costs money
npm run audit           # every success criterion against the real APIs; costs money
npm run audit:bridges   # LiveKit + Telegram; needs a running livekit-server and a human
```

`npm run check` is the only one that is free and hermetic. Run it before you say
you are done. Never run `doctor`, `audit`, or `audit:bridges` unless the user
asks — they spend their API credit.

## Layout

| Path            | What                                                          |
| --------------- | ------------------------------------------------------------- |
| `src/core/`     | The companion: memory, mood, persona, senses, initiative, gallery |
| `src/bridges/`  | LiveKit (phone call) and Telegram                             |
| `src/server/`   | HTTP + WebSocket layer, config, doctor                        |
| `src/web/`      | The site at 127.0.0.1:5175                                    |
| `src/shared/`   | Types both halves need and neither owns                       |
| `scripts/`      | The live audits                                               |
| `hers-profile/` | The user's real companion. Read-only to you.                  |
| `data/`         | Her memory database. Read-only to you.                        |

## The five invariants

These are the product, not preferences. Breaking one silently is the worst
outcome in this repo — say so out loud instead.

1. **Every outbound host lives in `src/shared/destinations.ts` and is named in
   `docs/PRIVACY.md`.** `destinations.test.ts` walks the source for URL literals
   and fails on any host that is not in the list. Adding a fetch means editing
   both files in the same change.
2. **Nothing phones home.** No telemetry, no analytics, no update check, no
   crash reporter, ever — not even opt-in.
3. **No CDN.** Every font, script, and image is served from the machine. A
   `<script src="https://…">` is a regression, not a shortcut.
4. **Her tools are `feel`, `remember`, `recall`, `show`, `look`** — declared in
   `src/core/gemini/tools.ts`. None of them can read a file, run a command, or
   reach the network. Do not add one that can. The list is short on purpose: a
   realtime model with a long tool list pauses before every sentence.
5. **Tests need no API key and touch no network.** Fake the seam, not the
   behaviour. A suite that needs a key is a suite nobody runs.

## Rules of the house

- **Never write to `hers-profile/`, `data/`, or `.env`.** That is a real person's
  companion and their credentials. A hook blocks it; do not work around the hook.
- **Comments go above the code they describe** and explain *why*, not *what*.
  This codebase's comments are load-bearing prose — match the surrounding density,
  which is high in `src/shared/` and `src/core/gemini/` and lighter in `src/web/`.
- **`npm run check` before any claim of done.** Show the output, don't assert it.
- **A changed default, folder, env var, or model name is a breaking change** and
  needs a CHANGELOG entry saying what to do about it.

## Commits

Subject line is a declarative sentence about what is now true — *"The camera light
cannot lie"*, *"Nothing is fetched from a CDN any more"*. Not `feat:`, not
imperative mood, no scope prefix. Body is prose with **bolded lead sentences**,
one paragraph per thing changed, and it explains the reasoning and what was
rejected. Read `git log` before writing one.

## Gotchas

- Node 22.18 is the floor because of `node:sqlite` and type-stripping. The
  machine currently runs v25.
- The WebSocket refuses a connection with no `Origin` header. `HERS_ALLOW_HEADLESS=1`
  is the escape hatch, and it is off for a reason.
- `HERS_DEBUG=1` makes reconnects print why.
- The profile is six markdown files listed in `src/shared/profile-files.ts`.
  There is no `appearance` file, deliberately — the photograph is the answer.
- `hers.log` is created owner-only. It holds absolute paths and the pinned
  Telegram chat id, so keep it that way.
