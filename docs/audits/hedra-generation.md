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

## What was fixed

Findings 1, 2, 4 and 5 are fixed, with tests that fail if they come back.

| # | Fix |
|---|---|
| 1 | `awaitClip` catches a failed status check and retries it, reading the `retryable` flag the adapters were already computing. Six consecutive failures against a backoff reaching 30s separate a flaky network from a dead one; a provider that says "final" is still believed on the first try. |
| 2 | `generateClip` reports the handle through a new `onSubmit` and **awaits it** before the first poll. `portrait.ts` uses it to call `attachJob` and save, so a paid job is durable before it is waited on. |
| 4 | `adopt()` refuses while `#busy`, with a message the user can act on. |
| 5 | `VideoProviderOptions` carries `fetch`, threaded to the `hedra` and `runway` factories. |

**Finding 3 (the seam check) is not fixed.** Wiring it needs a video decoder,
which only the renderer has, so it is a round trip — main writes a clip, the
renderer measures it, main records the verdict — rather than a missing call.
That is real work with its own design, not an oversight to patch here, and
pretending otherwise would have meant a fake fix. It remains open in the
README.

## The generation tiers

`core/avatar/generation-policy.ts`. Reuse is not one of the tiers: a clip that
exists on disk is played from disk at every tier, and nothing in the module can
cause a re-render. The tiers only govern what happens when a named motion is
**missing**, which is the only moment money is at stake.

| | low | medium (default) | high |
|---|---|---|---|
| Eligible slots | `idle` only | first 5 of `BUILD_ORDER` | all 19 |
| Max per session | 1 | 3 | 6 |
| Max in the library | 1 | 5 | 19 |
| Cooldown | — | 10 min | 2 min |
| Spend ceiling | $1 | $5 | $20 |
| Mode | on demand | on demand | pre-warm |

Four axes rather than one dial, because four different things go wrong and one
number cannot stop all of them: *which slots* bounds the worst case at all,
*how many* bounds a bad afternoon, *how often* bounds a runaway loop, and *how
much* is the backstop that does not depend on the other three being right.

The one anchoring figure is real: the single clip this project has actually paid
for cost **$0.25**, recorded in a library manifest. Everything else is a choice,
and the ceilings are in dollars rather than clip counts because Hedra bills on
the driving audio and will not quote before ingest — a per-clip count would be a
guess wearing a number's clothes.

`low` is not "a bit less". It is one slot, because `idle` is the only clip whose
absence means nothing on screen moves at all; every other gesture degrades
silently, so a user who wants to spend nothing loses gestures and keeps the
product.

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
