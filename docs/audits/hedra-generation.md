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

## Verified live, 2026-08-16

The audit above was done entirely against mocks. With the user's explicit
authorisation and a $1 ceiling, two things were then checked against the real
service.

**The key and the account, for nothing.** `GET /v3/balance` returned `200` and
`{"balance":19.25,"spent":null,"currency":"USD"}`. That confirms three things
the adapter asserts and this audit could not otherwise have checked: the
`Authorization: Key <key>` scheme is still accepted, the endpoint still exists,
and the response still carries a numeric `balance` where `validateKey` looks for
one. This call is not billed, which is why "Check the connection" now exists as
its own button next to the one that renders.

**One real render, end to end.** `build(1)` against the live service, through
the app's own path — provider registry, tier gate, `attachJob`, poll loop,
download, manifest write. It rendered `tilt_head`:

```
before  ready ["idle","nod"]              spent $0.25
        queued 0.9% → running 32.9% → …
after   ready ["idle","nod","tilt_head"]  spent $0.50   failed []
```

4.6 MB on disk. The balance moved $19.25 → $19.00, so **the clip cost $0.25** —
which is the first independent confirmation of the figure `HEDRA_COST` declines
to promise. It remains `verified: false` and that remains correct: one clip at
one duration is a data point, not a price list, and Hedra still bills by the
second of driving audio.

So: **the generation path works against the live service.** Submit, poll,
progress reporting, download and persistence are all real.

## The seam check, once it was wired: the clips drift

Measured against the three real clips in the library, with no API call.
`meanDelta` is 0..1 over RGB; `SEAM_THRESHOLD` is **0.02**.

| clip | first ↔ last | source ↔ first | source ↔ last |
|---|---|---|---|
| idle | 0.128 | **0.0025** | 0.128 |
| nod | 0.062 | **0.0102** | 0.064 |
| tilt_head | 0.063 | **0.0102** | 0.065 |

The middle column is the one that settles the question that was open. It
compares the source photograph, scaled to the clip's frame, against the clip's
own first frame — and it is 0.0025 to 0.0102, comfortably inside the threshold.
So the comparison is sound: the scaling is not distorting anything, and the
verdicts are not an artefact of measuring the wrong thing. (The aspect ratios
are 0.5592 for the source and 0.5625 for a Hedra render, a 0.6% difference,
which is why the scaling costs so little.)

Which means the first column is a real finding. **None of the three clips
returns to where it started**, by 3x to 6x the threshold. For `idle` that is
expected and not a defect: it is a phone video supplied by the user, not
something generated from the source frame, so it was never going to close. For
`nod` and `tilt_head` it is a genuine property of what Hedra returned — they
begin on the source pose and end somewhere else.

That matters because `hologram.ts` cuts between clips with no cross-fade,
on the stated grounds that both ends are the same frame. They are not. The
visible consequence is a pop at every gesture entry and exit, and on the idle
loop it repeats every few seconds.

Not yet established: whether `bestCutFrame` can rescue them. It searches the
hold from 55% of the clip onward and found nothing that closed, but a clip that
drifts monotonically would need a cut point *earlier* than that window starts.
Worth trying before concluding the clips are unusable, and it costs nothing.

## Not verified, and why

Stated rather than glossed:

- **The failure branches were never reached live.** Auth rejection, 402, 429, a
  malformed envelope and a dead socket are all covered against mocks, and the one
  live render *succeeded* — so the real service never exercised `failure()`.
  Confirming those envelopes would mean deliberately provoking errors on a funded
  account, which is a separate piece of work with its own budget.
- **The retry added for finding 1 has not fired against the real service.** It is
  proven against mocks in both directions. Nothing in the live run was flaky
  enough to trigger it, which is the good outcome and not evidence.
- **A per-clip price.** One clip at one duration came to $0.25 and that is a data
  point, not a rate card — Hedra bills by the second of driving audio and still
  declines to quote before ingest, so `HEDRA_COST.verified` stays `false`.
- **The seam of the clips that were rendered.** Finding 3 is still open, so
  nothing measured whether `tilt_head` returns to the source frame. It plays;
  whether it loops cleanly is unverified.
