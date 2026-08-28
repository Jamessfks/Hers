---
description: What has to happen before this program can reach a new host
paths:
  - "src/**/*.ts"
  - "docs/PRIVACY.md"
  - "call/**"
---

# Adding a network call

`src/shared/destinations.ts` is the single list of every host this program can
dial. It is not documentation — `destinations.test.ts` walks the source for URL
literals and fails on any host that is not in the list, and a second test fails
if `docs/PRIVACY.md` does not name every entry. The code, what the program says
about itself, and the document cannot drift apart.

So a new outbound request is a three-file change, all in the same commit:

1. The call site.
2. A `Destination` entry: `host`, `what` is sent, `when` it is sent, and which
   switch (`requires`) has to be on first. Angle brackets mean the value comes
   from configuration.
3. A line in `docs/PRIVACY.md` naming the host.

If the hostname appears in a comment, a documentation link, or an anchor a person
may click, it belongs in `MENTIONED_ONLY` instead. Splitting the two lists is
what makes the first one mean something — do not park a real request there to
quiet a failing test.

Every `what`/`when` string must be a sentence of at least eight words. That floor
is enforced by a test. It is not a quality bar; it is the level below which no
real answer fits.

## Never

- A telemetry, analytics, update-check, or crash-reporting endpoint. Not even
  opt-in, not even behind a flag.
- A CDN. Fonts, scripts, and images are served from this machine.
- Widening the allowlist to make a test pass. If a dependency dials somewhere
  unexpected, that is a finding to report, not an entry to add.
