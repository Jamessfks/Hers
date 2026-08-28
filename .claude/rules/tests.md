---
description: How tests are written here — node:test, no key, no network
paths:
  - "src/**/*.test.ts"
---

# Tests

`node --test` over `src/**/*.test.ts`. No framework, no mocking library — plain
`node:test` and `node:assert`. 525 of them run in about 20 seconds.

**No test may need an API key or reach the network.** Fake the seam — the socket,
the HTTP client — and let everything behind it run for real. `companion.test.ts`
is the model: memory, mood, the prompt, and the tools all execute, and only the
socket is faked. What real APIs actually do is the audits' job, not the suite's.

Test names are sentences that state the claim, lowercase, no `should`:

```
✔ the profile files the code ships are the profile files the list claims
✔ nothing writes outside the roots the document names
✔ a new top-level directory of code cannot appear unnoticed
```

An assertion that a string is non-empty and ends in a full stop is satisfied by
`"x."`. Assert the thing you actually mean.

When you fix a bug, the failing test comes first and you watch it fail before
the fix goes in.
