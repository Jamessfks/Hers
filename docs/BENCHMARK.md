# The bar

The named bar is xAI's Grok companion, **Ani**.

Ani is the only shipped thing in this category that is actually the same
product: a full-body rigged 3D character with realtime voice, whose animations
are hand-authored clips that the model *selects contextually* rather than
playing on a loop. That last clause is the whole reason she is the benchmark and
not, say, a Live2D VTuber shell or a chat app with a portrait. Idle-loop avatars
are a solved and uninteresting problem. Ani decides when to move.

Being judged against a product built by a frontier lab with a licensed
character, a motion studio and a tuned voice is uncomfortable, which is the
point of picking it. What follows is the list of things being compared, the one
part of it that is actually measured, where Anna plausibly comes out ahead, and
where she loses badly enough that saying otherwise would be dishonest.

---

## What is actually being compared

### 1. Presence when idle

Most of the time nobody is talking. That is when an avatar is revealed as a
puppet — it goes statue-still, or it loops a wave every eight seconds.

Anna's answer is the layering in [`body.ts`](../src/renderer/avatar/body.ts):
idle runs *underneath* everything else, permanently, so breathing, weight shift,
head micro-motion, blinks and eye saccades never stop even mid-gesture. Blinks
are scheduled from a fresh random interval each time, because a metronome blink
is worse than no blink.

**Pass condition:** watch her for two minutes with the sound off and not be able
to identify the loop point. Not currently verified by anything but eyes.

### 2. Gesture timing

Ani's clips are chosen by the model in context. That is the mechanism, and it is
the one thing an idle-loop avatar cannot fake.

Anna writes her own stage directions inline — `[gaze:user][warm] Hey.
[tilt_head] You've been on that same file for three hours.` — and
`PerformanceParser` peels them out of the token stream character by character,
so the gesture fires *while the sentence around it is still being generated*,
not after the reply is complete. The parser is a state machine rather than a
regex over the buffer specifically because tags split across token boundaries
(`"[le"` then `"an_in]"`) and a rescanning parser fires the same gesture twice.

**Pass condition:** the gesture lands on the word it belongs to, not after the
clause. Tested for correctness (14 tests in `performance.test.ts`); the *timing*
against real audio is not measured.

### 3. Time to first audio

The number that decides whether she reads as thinking or as processing. Budget:
**800ms from end-of-speech to first sound.** This is the only criterion on the
list with a number, and it is discussed in its own section below.

### 4. A personality that is not assistant-style

Ani is not helpful. She has a register, she keeps it, and she does not offer to
summarise anything.

Every frontier model reverts to "helpful assistant" under three conditions: long
context, a request that looks like a task, and hedging in the prompt itself. So
[`anna.ts`](../src/core/persona/anna.ts) is written as prohibitions with
examples rather than as adjectives — "no lists", "never say *let me know if*",
"do not summarise what they just said back to them", "two questions in a row is
an interview" — and is backed by four style-example turns that set line length,
directive density and the exact register of the jokes.

**Pass condition:** ask her to organise your week and get "I'm not going to make
you a spreadsheet", not a spreadsheet. Not automatically testable; a model
change can regress it silently.

### 5. Memory continuity

Asking about the interview a week later, unprompted, without being reminded. Not
"recalling the conversation" — bringing it up.

**Pass condition:** quit the app, come back in seven days, and have her raise a
thread you never re-mentioned.

---

## The measurable half

One of those five is asserted in code. From
[`companion.test.ts`](../src/core/orchestrator/companion.test.ts):

```ts
assert.ok(
  firstAudioMs < 800,
  `first audio took ${Math.round(firstAudioMs)}ms, budget is 800ms`,
);
```

The stubs are deliberately pessimistic — 120ms to first token, 12ms per chunk
after that, and a voice that takes 150ms to first byte, which is ElevenLabs
rather than the 90ms default. The surrounding tests assert the three properties
the budget depends on:

| Assertion | What it protects |
| --- | --- |
| First audio inside 800ms | The budget itself |
| Clause ids emitted in ascending order | She does not talk backwards when synthesis overlaps |
| Peak concurrency `> 1` and `<= 2` | Requests overlap, but a long reply does not fire a dozen throwaway synthesis calls |
| Nothing spoken after `bargeIn()` | She stops when you start |
| An aborted turn is not stored | Interrupted half-sentences do not become memories |

**Be clear about what this does and does not prove.** It proves the pipeline
overlaps rather than queues — serialise any stage and the assertion fails. It
does not prove that a real turn on a real network is under 800ms, because there
is no network in the test, no real model, and no real voice. The end-to-end
number has never been instrumented against live providers, and there is no
harness that would catch a regression in the real world. That is the largest
hole in this document.

Nothing else on the list has a number. Presence, gesture timing, register and
continuity are all currently judged by watching, which means they can rot
silently.

---

## Where Anna plausibly wins

Four things, and only four.

**Memory that survives a restart.** Turns, distilled facts, embeddings and a
rolling summary in a local SQLite file, retrieved by a blend of similarity,
recency, confidence and how often a fact has proved useful. Consolidation runs
off the critical path and merges near-duplicates so mentioning your job three
times does not produce three facts that crowd out everything else. A companion
whose continuity is a context window is a companion who forgets you on Tuesday.

**Bring your own key, no hosted anything.** No account, no backend, no
telemetry, and the conversation goes to a vendor you chose and already pay. See
[PRIVACY.md](PRIVACY.md). This is not a feature Ani can copy without becoming a
different company.

**Full body, rendered locally, at zero marginal cost.** She stands, she can sit,
she leans, she gestures with both arms — at display refresh, on the GPU already
in the machine, for as many hours as the app is open. Every realtime
video-avatar API is a head-and-shoulders crop billed per streamed minute, which
makes *idling* the most expensive state in the product; the comparison is in
[PROVIDERS.md](PROVIDERS.md). Because gestures are authored as bone offsets
against the VRM humanoid spec rather than as retargeted clips, they also work on
any character the user loads.

**Restraint.** The attention policy is mostly rules about *not* speaking: one
opener per cooldown window regardless of how many triggers fire, a separate and
much longer per-trigger cooldown, absolute quiet hours, and anything that fires
mid-conversation is dropped. A companion who reacts to everything the sensors
see is not attentive, she is a smoke alarm.

---

## Where Ani still wins

Also four, and these are the ones that matter to a person looking at both.

**Motion quality.** Ani's clips came from a studio. Anna's are keyframed bone
offsets written by hand in [`poses.ts`](../src/renderer/avatar/poses.ts) — 18
gestures, procedurally interpolated. They are legible and they compose correctly
over the idle layer, and they are not motion capture. A trained animator would
identify the difference in about four seconds. This gap does not close with
better engineering; it closes with a motion library we cannot licence.

**A character.** Ani ships as a designed, licensed, art-directed character with
a name and a look. **Anna ships with no model at all** — she is a luminous
stand-in figure until you drag a `.vrm` onto her window. The pipeline is
complete and the product is not, and the first thirty seconds of the experience
is the difference.

**A tuned voice.** Ani's voice was chosen and tuned for that character. Anna's
default `voiceId` is the empty string, so out of the box she cannot speak until
you paste a voice id into the config file — there is no settings UI yet. Even
once configured, it is a stock voice from a general catalogue that was not
designed for her.

**Lip sync.** Ani has visemes. Anna drives the jaw from an RMS amplitude
envelope with a slow drift across three vowel shapes, asymmetrically smoothed so
the mouth opens faster than it closes. That is a considered approximation of a
jaw, not phoneme extraction, and the comment in `body.ts` says so: real visemes
need a forced aligner or phoneme timings, and none of the three voice providers
return them. It reads fine at conversational distance and it will not survive a
close-up.

Plus everything a shipped product has that a v0.1 does not: no settings UI, no
locomotion (`sit_down` holds a pose; she does not walk), macOS only, and no
end-to-end latency instrumentation against live providers.

---

## How we would know

Falsifiable, in rough order of how much each would tell us:

1. Instrument a real turn end to end — VAD close to first sample out of the
   speaker, against live providers, logged. Until that exists the 800ms claim is
   about the architecture, not about the product.
2. Record two minutes of idle and check whether the loop is identifiable.
3. Diff gesture onset against the audio timestamp of the word it belongs to.
4. Run the "organise my week" prompt against every supported model after each
   model upgrade, and read the reply. Assistant drift is a silent regression.
5. Come back after a week away and see whether she raises the thread first.
