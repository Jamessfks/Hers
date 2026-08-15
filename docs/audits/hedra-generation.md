# Audit — the Hedra clip-generation path

**Date:** 2026-08-16
**Scope:** submit → poll → download → persist, for `hedra`, and the library
bookkeeping around it.
**Method:** static reading plus tests against an injected `fetch`. **No request
in this audit reached Hedra, and no real key was read.** See
[Testing without spending](#testing-without-spending).

The README's *Not done yet* section made four claims about this path. All four
are **confirmed**, and the audit found a fifth that made the other four hard to
test at all. Two of the five cost the user money.

---

## Findings

### 1. A transient poll error throws away a job that has already been paid for

**Confirmed. Costs money.**

`awaitClip` in `core/avatar/video-provider.ts` calls `provider.poll(job)` inside
its loop with no `try`/`catch`. Any throw — a 429, a 502, a dropped socket, a
laptop that slept — propagates out of `awaitClip`, out of `#finish`, and lands
in the catch that marks the slot **failed**.

The job itself is unaffected: it is still running on Hedra's queue and has
already been billed on ingest. The app has simply stopped watching it.

The sharpest part is that the adapter already knows better. `failure()` in
`hedra-provider.ts` sets `retryable: true` for 429 and every 5xx, deliberately,
with a comment explaining that the service knows which of its failures are worth
repeating. Nothing reads that flag on the poll path. It is computed and dropped.

### 2. A crash between submit and completion re-charges the user

**Confirmed. Costs money.**

`attachJob` exists in `core/avatar/clips.ts`, is exported, is tested, and has
**no non-test call site anywhere in the app**. `resumableJobs` only returns
slots where `entry.status === 'generating' && entry.job` — so a job with no
handle recorded is invisible to it.

`#finish` in `main/avatar/portrait.ts` calls `startGenerating(library, slot)`,
which defaults `job` to `null`, then awaits `run()`. The handle returned by
`submit()` first becomes visible when that whole promise resolves. Between those
two moments the manifest says `generating` with `job: null`.

Quit the app there — or crash, or lose power — and the next build sees a slot
that is not resumable, submits it again, and pays for it again. The comment
above `awaitClip` says a recovered job "is what makes a crash mid-build free
rather than expensive." The recovery path is real; nothing writes the handle it
needs.

### 3. The seam check never runs

**Confirmed. Does not cost money; costs the invariant.**

`core/avatar/seam.ts` does the arithmetic and is covered by its own tests.
Nothing in the app calls it. `renderer/avatar/clip-frames.ts` imports only the
`Frame` *type* from it.

`hologram.ts` opens by saying every clip returns to the source photograph and
that this "is asked for in prompts.ts and *verified* in seam.ts" — and that the
whole cut-with-no-transition design rests on it. The verification does not
happen, so `verified` is never set and a drifted clip is accepted silently. The
measurement is correct; the wiring is missing.

### 4. Swapping the photograph mid-build mixes libraries

**Confirmed. Corrupts state.**

`build()` guards itself with `#busy`. `adopt()` does not consult it, and
reassigns `this.#library` outright. A build in flight holds `library` in a local
and writes through `this.#library!` after the swap, so an in-flight clip can
land in the new photograph's directory, against the new manifest.

### 5. The provider registry cannot be given a mock — so this path was effectively untestable

**Confirmed. New; not in the README.**

`createHedraProvider` accepts an injected `fetch`, and its unit tests use it. But
`VideoProviderOptions` in `video-provider.ts` carries only `apiKey` and
`dropDir`, and the `hedra` factory calls `createHedraProvider({ apiKey })` — the
seam is not threaded through the registry.

Every caller in the app goes through `createVideoClipProvider`, so no test that
exercises the app's real path could substitute a fake transport. That is why
findings 1 and 2 survived: the only tests that could catch them were the ones
the architecture made impossible to write.

---

## Testing without spending

The constraint on this work was that it must not spend a single real credit.
Instruction alone is not a control, so the guard is mechanical:

- `fetch` is now injectable through `createVideoClipProvider`, so tests
  substitute a transport instead of reaching the network.
- `core/avatar/testing/transport.ts` builds those fakes, and refuses any request
  to a host that has not been explicitly allow-listed. A missed injection fails
  the test loudly rather than quietly billing an account.
- No test carries a real key. `hedra_test_key_do_not_use` is the fixture.

---

## Not verified, and why

Stated rather than glossed:

- **Nothing here was run against the live Hedra service.** Every claim about
  request and response *shapes* rests on the adapter's own documentation of the
  spec it was written from, and on its recorded fixtures — not on a live call
  made during this audit.
- **Whether Hedra's live error envelopes still match `failure()`.** The adapter
  says the shapes were checked against a live key when it was written. This
  audit did not re-check them, and could not without spending.
- **Actual per-clip cost.** Hedra bills by the second of driving audio and
  declines to quote before ingest, so there is no per-clip figure to confirm.
  `HEDRA_COST.verified` is `false` for this reason and that remains correct.
