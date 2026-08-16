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

## The bugs found while checking all this

Every one was found by running the thing rather than reading it, and none had a
symptom anyone would have reported as a bug.

| what | why it was invisible |
|---|---|
| `hidden` did not hide a clip element | Half of every gesture replaced by a frozen frame — reads as "the video stalled", not as a CSS specificity bug. |
| A looping idle clip read as "a gesture is in progress" | `setIdle(null)` left `#playing` naming a slot `#idle` no longer did, so every later gesture queued behind a video that never fires `ended`. Silent, permanent. |
| `#next` drained only by `ended` | A clip that failed instead of finishing wedged the queue the same way. There was no `error` listener at all. |
| An unrenderable gesture displaced a renderable one | Both reach the single queue slot; last wins. Cost a real `nod` in a real turn. |
| `#playAfter` could not tell "missing" from "superseded" | Fell back to idle and cancelled the newer directive in doing so — two gestures lost at once. |
| `silence()` neither stopped the clip nor cancelled a load | Barge-in let a gesture land *after* the user started talking. |
| `invalidate()` revoked a URL mid-load | No error fires; the element waits out a 2s timeout and gives up quietly. Raced every gesture during a build. |
| Two directives in one breath drove the same element | `#front` flipped twice and pointed at the hidden video, reintroducing the black-frame flash two elements exist to prevent. |
| `verified` and `lastPlayedAt` never survived a restart | `save` wrote them; `parseEntry` dropped them. Every launch re-measured a whole library and believed nothing had ever been played. |
| `verified: false` was falsy, not a third state | A drifting clip went back on the verification queue on every launch, forever, to be told the same thing about the same bytes. |
| A verdict outlived the file it was about | Eviction and re-render left the flag in place; `reconcile` compares file *names*, and a re-render reuses the name. |
| `lastPlayedAt` outlived it too | A clip that had just been paid for inherited its predecessor's staleness and was the next thing eviction reached for. |
| Two manifest saves onto one temporary path | `${target}.${pid}.tmp` is atomic against other processes and not against itself; the callers do not await. |
| `anna:body:report` had no listener | Every renderer diagnostic since the channel was written went nowhere — in the one process whose window photographs as black. |

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


## The drift cannot be cut around

Every frame of every clip, measured against the source photograph. The sweep is
`harness/seam-sweep.ts`; it costs nothing and needs no key. It seeks and
measures one frame at a time, and each run starts by calling the app's own
`extractClipFrames` and checking the streaming loop reproduces its first and
last frames — reported in the output, and exact for all three clips.

| clip | frames | best mean | at frame | frames that close cleanly |
|---|---|---|---|---|
| nod | 120 | **0.0102** | **0** | **0** |
| tilt_head | 120 | **0.0102** | **0** | **0** |
| idle | 76 | **0.0025** | **0** | 2 (frames 0 and 1) |

**No. There is no cut point.** In all three clips the frame closest to the
source is frame 0, so the only "early cut" available is a clip of zero length.
Widening `bestCutFrame`'s search window cannot help, and the reason is the shape
of the curve rather than the window:

```
nod, meanDelta against the source photograph
0.00s 0.0102   0.75s 0.0275   2.0s 0.0631   3.5s 0.0648
0.25s 0.0120   1.00s 0.0576   2.5s 0.0629   4.5s 0.0646
0.50s 0.0148   1.25s 0.0601   3.0s 0.0642   4.96s 0.0640
```

The clip leaves the source pose in its first second and then *holds there* for
the remaining four, breathing gently around a pose that is not the one it
started from. `tilt_head` is the same shape and `idle` — a phone video, so this
is expected — departs faster and further. The premise `bestCutFrame` was
written against, that the hold is a return to the source, is simply not what
these renders do.

### The measurement was measuring the wrong thing

A control run settles what the numbers mean:

| pair | mean | worst block | changed | closes |
|---|---|---|---|---|
| source → idle first (same size) | 0.0025 | 0.0072 | 0.0000 | **yes** |
| source → nod first | 0.0102 | 0.1715 | 0.0639 | no |
| source → tilt first | 0.0102 | 0.1706 | 0.0641 | no |
| **nod first → tilt first** | **0.0027** | **0.0093** | **0.0000** | **yes** |
| nod last → tilt first | 0.0623 | 0.5960 | 0.5125 | no |
| nod last → nod first | 0.0624 | 0.5962 | 0.5130 | no |

The fourth row is the one that matters. Two *different* Hedra clips' opening
frames are as close to each other as `idle`'s first frame is to the photograph
it was cut from — 0.0027 mean, 0.0093 worst block, not one pixel changed by a
just-noticeable amount. **Every clip really does begin on the same frame.**

Which means rows two and three were not measuring drift at all. They compare a
718x1284 JPEG stretched to 720x1280 against a 720x1280 render: a 0.6% shear,
invisible to the eye and to `meanDelta`, and exactly what `worstBlockDelta` is
built to detect. It scored 0.17 against a 0.09 threshold on frames that had not
moved. Under the full `closesCleanly` test, a Hedra clip's own opening frame
failed — so the check as written could never have passed anything that vendor
returned, whatever the prompt said.

`verify.ts` now measures clip against clip, at the same size, with nothing
resampled: one clip's first frame becomes the reference for every clip rendered
at that size, and the verdict is each clip's last frame against it. Cutting
*into* a clip is genuinely invisible, which is what this design always claimed.
Cutting *out* of one is not.

### So the recommendation

The clips cannot be looped or cut. Three options, in the order they are worth
trying, and none is implemented here because each is a decision rather than a
fix:

1. **Regenerate with a different prompt.** Cheapest to test — one clip, $0.25 —
   and the failure is specific enough to aim at: the model treats "return to the
   starting pose" as a suggestion and holds wherever the gesture left it. Asking
   for the gesture to *complete and reverse* within the clip, rather than for a
   hold at the end, is a different instruction and may land differently.
2. **Cross-fade in `hologram.ts`.** Certain to work and it costs the thing the
   module was built around. A 150ms dissolve hides a 0.06 mean delta completely.
   The argument against it in the header — that dissolving two identical frames
   softens an invisible cut — applies to the *entry*, which is measurably clean,
   and not to the exit, which is measurably not. A fade on exit only would be
   the honest version.
3. **Accept the pop.** It is real and it is visible, and on the idle loop it
   repeats every 3.16 seconds. Not recommended, but it is what ships today.

## The clips were playing and half of them were not on screen

Found by capturing Anna's window during a scripted exchange, which is a thing
that has to be done deliberately: `setContentProtection` makes her invisible to
`screencapture` unless `ANNA_ALLOW_CAPTURE=1`.

`#backdrop > .clip { display: block }` in `styles.css` outranks the browser's
own `[hidden] { display: none }` — (1,1,0) against (0,1,0) — so
`video.hidden = true` set an attribute that did nothing. Both video elements
were always painted, stacked, and the later one in document order won.
`hologram.ts` alternates elements on every clip, so **every other clip was
invisible**, and because the swap correctly pauses the outgoing element what
replaced it was the *other* clip frozen on its last frame for the gesture's full
length.

Measured, before the fix, over 34 captures of a twenty-second exchange:

```
003-011   tilt_head "playing"   9 captures, pixel-identical      frozen
012-020   nod       playing     motion 0.049 … 0.008             animating
021-029   tilt_head "playing"   9 captures, pixel-identical      frozen
```

The frozen images from the two tilt_head plays differ from each other by 0.1045
and each matches the *previous* clip's last frame — conclusive that what was on
screen was the other element, paused. After the fix, 39 of 40 consecutive
captures show motion and none is frozen.

## What the demo actually did, watched end to end

`ANNA_ALLOW_CAPTURE=1 ANNA_DEMO=1 ANNA_DIAG=1` with a three-line script, read
off `diagnostics.jsonl` — which reaches the disk at all only because
`anna:body:report` now has a listener in main; it had none, so every renderer
diagnostic ever written went nowhere.

```
 0.23  clip-played idle       looping     boot
 3.85  clip-played tilt_head              turn 1, "hey"
 8.97  clip-played nod                    turn 2, "i'm exhausted"
14.09  clip-played tilt_head              turn 3, "thanks for listening"
19.20  clip-played idle       looping     and back to the loop
```

Gestures play, and she returns to idle. Two things only showed up by watching:

- On the first run, turn 2 played **nothing**. It emits `[nod]` then `[lean_in]`
  a millisecond later; `nod` had a clip and `lean_in` did not, and the single
  queue slot is last-writer-wins, so the renderable gesture was displaced by an
  unrenderable one. The window is now told which slots exist.
- `notePlayed` was called when main *sent* a gesture. In that same turn it
  recorded `nod` as played when nothing had been. The window reports what
  reached the screen and main uses that instead.

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
- **Whether a better prompt fixes the drift.** Option 1 above is the cheapest
  thing to try and it is the one thing in this document that cannot be
  established without spending: it needs a render. Nothing here was measured
  against a re-prompted clip.
- **Whether a cross-fade looks right.** Option 2 is certain to *hide* the seam;
  whether a dissolving companion reads better than a jumping one is a judgement
  about the product, not a measurement, and it was not made here.
- **Anything above 0.0102.** The floor for a Hedra render against this
  photograph is 0.0102 mean / 0.1715 worst block, and every figure in this
  document about a *generated* clip carries that. Only the clip-to-clip
  comparisons are free of it.
- **The seam thresholds against anything but these three clips.**
  `SEAM_THRESHOLD` and its two companions were tuned on paper and have now been
  checked against exactly one photograph and two vendor renders. A same-size
  frame of the same moment scores 0.0025/0.0072/0.0000 and passes comfortably,
  which is the only evidence that they are not simply too tight.

---

## Open, and stated plainly for whoever picks this up

A critic pass on `renderer/avatar/hologram.ts` finished after work stopped. Its
findings are unfixed, and the first one matters more than the rest because it
means a commit message in this branch is wrong.

**`#urlFor` has no single-flight guard, and `ae5e6eb` does not close the bug it
says it closes.** The cache is read, then awaited, then written, with no
re-check. Two concurrent `#start`s for the same slot both miss, both
`createObjectURL`, and the later write overwrites the earlier — leaving a
multi-megabyte blob in no map and on no element, so `invalidate()`,
`#sweepStale()` and `dispose()` all miss it.

It is reachable on an ordinary path: `main.ts` subscribes with
`onLibrary((view) => void applyLibrary(view))`, which is not serialised, and
while the first idle load is open `#playing` is still null, so a second event's
`setIdle('idle')` starts a second load of the same slot. The critic reproduced
both orderings against the real class. When the second fetch resolves *first*,
the superseded older-library load lands last and installs its URL as the cache
entry — the previous photograph's clip looping over the new face, which is
exactly what `ae5e6eb` claims to have fixed.

Also open, in rough severity order:

- `#swapIn`'s `back.src !== url` fast path treats "src is set" as "src has
  decoded". A superseded start sets `src` and blocks; the winner sees the same
  `src`, skips the wait, and unhides an element that never fired `loadeddata`.
  Reproduced via barge-in during the idle load. Needs a `readyState` check.
- `invalidate()` defers on `slot === #playing`, which is not the predicate its
  own comment describes. `#sweepStale` twelve lines below uses the right one —
  "is any element sourced from this URL". Because `#playing` is nulled *before*
  the replacement start is awaited, an invalidate in that window revokes the URL
  of a clip that is still on screen.
- The `try` added in `0cddc63` covers `loadClip` only. `new Blob(...)` and
  `URL.createObjectURL` sit outside it and `#start` is still `try/finally`, so
  the comment claiming "every other failure in `#start` returns a code" is
  false and the throw door is open one line lower.
- `#urlFor` repopulates `#cache` after `dispose()`.
- Two of the guards these commits are *named* for are untested: mutation testing
  showed the whole suite still passes with the counted-Map `#release` reduced to
  a plain delete, and with the `#loading.has(slot)` guard in `invalidate`
  removed. No test starts the same slot twice concurrently — one that did would
  cover both and would fail on the finding above.
- Several comments describe behaviour the code no longer has; the critic listed
  them by line.

None of this is speculative except where noted: the first two were reproduced
against the real class, not reasoned about.
