---
description: Run the audits that talk to the real Gemini and Telegram APIs. Costs the user money — never run without being asked.
disable-model-invocation: true
argument-hint: "[quick|bridges|--only=name]"
---

# The live audits

`npm test` fakes every network seam on purpose, which leaves a specific gap: the
tests prove the code does what it was written to do, not that Gemini does what it
was read to do. These close it, and they cost real money — a few cents for a full
run.

**Do not run any of this unless the user asked in this session.** If they asked
for "the tests", they meant `npm run check`.

## Before you start

- `GEMINI_API_KEY` set (`.env` or environment).
- The audits run against a *copy* of the profile folder, so they cannot damage
  `hers-profile/`. Confirm that is still true in `scripts/audit.ts` before
  trusting it.

## The runs

```bash
npm run audit                # every success criterion
npm run audit -- --quick     # skips the two multi-minute endurance checks
npm run audit -- --only=mood # one check, by substring
npm run audit:bridges        # Telegram, and it needs a human — see below
```

Four checks are new in v2.0: that `run`, `open` and `write` actually change the
machine and land in `hers-actions.log`; that she has the right city and a real
forecast; that she is silent inside her own sleep window; and that a genuinely
different camera frame captions differently enough to fire.

`npm run audit:bridges` sends two voice notes — one recorded, one synthesised by
the TTS fallback — so it proves the half of the Telegram promise that ordinary
turns never exercise. Telegram cannot be faked: a bot may not open a
conversation, so until a human has messaged it the audit reports what is missing
rather than passing. That is correct behaviour — do not treat it as a failure to work around.

## Reporting

Each check prints what it observed, not only a verdict, because "PASS" with no
evidence is worth about as much as no test at all. Relay the evidence. If a check
fails, quote the observation before you theorise about the cause.
