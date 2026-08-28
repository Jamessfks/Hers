---
description: Run the audits that talk to the real Gemini, LiveKit, and Telegram APIs. Costs the user money — never run without being asked.
disable-model-invocation: true
argument-hint: "[quick|paid|bridges|--only=name]"
---

# The live audits

`npm test` fakes every network seam on purpose, which leaves a specific gap: the
tests prove the code does what it was written to do, not that Gemini does what it
was read to do. These close it, and they cost real money — a few cents for a full
run, more with `--paid`.

**Do not run any of this unless the user asked in this session.** If they asked
for "the tests", they meant `npm run check`.

## Before you start

- `GEMINI_API_KEY` set (`.env` or environment).
- The audits run against a *copy* of the profile folder, so they cannot damage
  `hers-profile/`. Confirm that is still true in `scripts/audit.ts` before
  trusting it.

## The runs

```bash
npm run audit                # everything except paid image generation
npm run audit -- --quick     # skips the two multi-minute endurance checks
npm run audit -- --paid      # adds image generation
npm run audit -- --only=mood # one check, by substring
```

```bash
brew install livekit && livekit-server --dev   # placeholder keys, printed on start
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  npm run audit:bridges
```

The LiveKit check invites her into a room, joins as a fake caller publishing real
synthesised speech and real video frames, and asserts she *heard the words* and
answered out loud. Telegram cannot be faked: a bot may not open a conversation,
so until a human has messaged it the audit reports what is missing rather than
passing. That is correct behaviour — do not treat it as a failure to work around.

## Reporting

Each check prints what it observed, not only a verdict, because "PASS" with no
evidence is worth about as much as no test at all. Relay the evidence. If a check
fails, quote the observation before you theorise about the cause.
