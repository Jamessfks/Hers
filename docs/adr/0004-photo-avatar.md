# 0004 — One photograph, animated by pre-rendered clips

**Status:** accepted, v1.0. Supersedes [0003](0003-avatar-renderer.md).
Its presentation half — the bezel, `object-fit: contain`, and the panel sizing
itself to the photograph — is amended by
[0005](0005-chat-thread-ui.md). The avatar decision below still stands.

## Context

[0003](0003-avatar-renderer.md) chose a rigged VRM drawn locally with three.js,
and rejected the video-avatar APIs. Two of its three premises have since been
settled by the market rather than by us:

- **Hedra's realtime avatar is gone.** `POST /public/livekit/v1/session` answers
  `410 Gone` — "The Hedra realtime avatar service is no longer available" — and
  LiveKit's plugin for it is now a single line that throws.
- **The per-minute streaming category is still priced for a kiosk**, which is
  0003's argument and remains correct: a companion left open all day spends most
  of its life idling, and idling is the most expensive state in that model.

What did not survive contact was the VRM half. A rigged character is *always*
animatable and *never* photoreal. Against the benchmark — a companion you glance
at rather than direct — a synthetic face doing anything loses to a real face
doing one of nineteen things.

## Decision

**Anna's body is one photograph, plus short video clips generated from it
offline, once, at setup.**

The photograph is chosen by the user. Nothing is bundled. A clip library is
nineteen slots: `idle` plus the eighteen gestures in `GESTURE_NAMES`. Playback
is an `<img>` and two `<video>` elements in `renderer/avatar/hologram.ts`.

The load-bearing property is that **every clip begins and ends on the source
photograph**. That is what lets any two clips be cut together with no transition
at all — no crossfade, which would only soften a cut that is already invisible.
`prompts.ts` asks for it and `seam.ts` is written to measure it.

## Why this is viable where realtime was not

Generation is **not on the conversation path**. Nothing renders while she is
talking, so a model that takes three minutes is fine — latency is a progress bar.
That single fact is what 0003 could not assume about a streaming avatar, and it
is what makes the cost structure invert: paid once at setup rather than per
minute of presence.

A full nineteen-clip library is about **$4.75** on Runway's published rate.
Under 0003's rejected option, the same money bought roughly an hour of idling.

## Consequences

**Good**

- A real face, at the cost of a rig that never looked real.
- The renderer bundle went from ~1MB to ~25KB; three.js, `@pixiv/three-vrm` and
  a bundled 15MB CC0 character are all gone.
- No render loop. A video element decodes itself, so the panel costs nothing
  when she is still — which matters for something left open all day.
- The panel sizes itself to the photograph instead of letterboxing it.

**Bad, and accepted**

- **She has no body until the user provides one and pays to animate it.** A VRM
  shipped with the app; this does not. The first run is a still photograph.
- **The gesture vocabulary is bounded by the photograph's crop.** A
  head-and-shoulders shot cannot wave — the hands are not in frame, and a model
  asked to invent them will not return to the source pose.
- **A gesture cannot be blended or scaled.** `intensity` on a `PerformanceEvent`
  is dropped: a generated clip has one performance baked into it.
- **Every clip is a paid, non-deterministic artefact.** This puts cost handling,
  idempotency, resumability and seam verification into what used to be a pure
  rendering concern. Most of the defects listed in the README's *Not done yet*
  live in exactly that new surface.

## Alternatives rejected

- **Keep the VRM alongside the clips.** The honest hybrid, and the user chose
  against it explicitly — a synthetic body undercuts the reason to have a real
  face at all.
- **Render per utterance.** Closest to "the video model generates gestures from
  the LLM's text", and unusable: two to six minutes per line.
- **Hedra for the whole library.** It is audio-driven, so a silent gesture clip
  needs a fabricated silent track, it bills for that track's duration, and it
  will not quote a price beforehand. It is kept for the one thing only it can
  do — lip-syncing a specific line.
