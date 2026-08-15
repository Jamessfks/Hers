# 0003 — A local rigged VRM, with video avatars as a seam

**Status:** superseded by [0004](0004-photo-avatar.md), v1.0. Kept because its
reasoning about *why not realtime video* is still the operative argument — only
its conclusion about what to draw instead was reversed. **This reverses part of the original brief.**

## Context

The brief was to research the best voice *and video* models and support the top
three of each. For voice that produced three adapters. For video it produced a
finding that contradicted the instruction, so the reversal is recorded here
rather than quietly implemented.

Every realtime video-avatar API on the market — HeyGen LiveAvatar (~1–2s), Tavus
Phoenix-4 (sub-600ms), Anam (~180ms), Simli, Hedra — renders a **head and
shoulders** and bills **per streamed minute**. The full comparison is in
[PROVIDERS.md](../PROVIDERS.md). The latency numbers are not the problem; Anam's
is better than anything we could build. Three other things are:

**Framing.** These products exist because the demand is video calls, sales
agents and support kiosks, and all of those are a face in a rectangle. Anna is
specified as a full-body character standing at the edge of the screen — she sits
down, she leans back, she puts her hands behind her back. No amount of
engineering on our side widens someone else's camera.

**Cost that scales with presence rather than conversation.** Voice bills per
character, so a companion who says nothing for six hours costs nothing for six
hours. Video bills per streamed minute, which makes the *idle* state — most of
the time, and precisely where presence is the entire product — the most
expensive thing in the app. A companion you switch off to save money has stopped
being always-on.

**No control below the utterance.** A video-avatar API takes audio or text and
returns a face that matches it. It does not take "fold your arms at token 14".
Anna's body is driven by inline directives parsed mid-stream, which is the
mechanism that makes her read as deciding rather than reacting. Handing the
performance to a remote renderer throws that away.

There is also a churn signal worth weighing: Hedra is deprecated in LiveKit's
plugin catalogue. Backends in this category can disappear inside a release cycle.

## Decision

**The primary renderer is a rigged VRM, drawn locally with three.js.** Gestures
are authored as keyframed bone offsets against the VRM humanoid spec
(`renderer/avatar/poses.ts`, since deleted) rather than as retargeted
motion capture, so every gesture works on any character the user drops in. The
idle layer composites underneath every gesture, permanently.

**Video backends are kept as a seam, not an implementation.**
`AvatarRendererId = 'vrm' | 'heygen' | 'tavus'` in
[`protocol.ts`](../../src/shared/protocol.ts), and `avatar.heygen` /
`avatar.tavus` are valid `SecretName`s in
[`secrets.ts`](../../src/main/secrets.ts). There is nothing behind either, and
the README says so.

So: the brief asked for three video backends and this ships zero, in favour of
one local renderer the brief did not ask for. The reason is that the three
backends would each have delivered a cropped, metered head that could not sit
down — a worse product, delivered literally.

## Consequences

**Good.**

- Full body, at display refresh, on the GPU already in the machine, for zero
  marginal cost. Idling is free, which is what makes always-on viable at all.
- Gestures are portable across every VRM, so the user supplies the character and
  the animation still works.
- Directive-level control of the body, which is the benchmark criterion in
  [BENCHMARK.md](../BENCHMARK.md) that idle-loop avatars cannot fake.
- Rendering works with no network at all.

**Bad.**

- **We now own animation quality**, which is the thing motion studios exist to
  do. Hand-keyframed bone offsets read as legible, not as motion capture, and
  that gap does not close with better engineering.
- **No photoreal option today.** Anyone who wants a realistic face has nothing to
  switch to, despite the config value implying otherwise.
- **The seam is unproven.** An `AvatarRendererId` with nothing behind it is a
  claim, not an abstraction. The first real video implementation will almost
  certainly force changes to it, since a remote renderer consumes audio and text
  rather than `PerformanceEvent`s and would need a different half of the
  protocol.
- **She ships with no character at all**, because every good VRM belongs to
  somebody. A video backend would have come with a face included; the local path
  puts a drag-and-drop step between install and the product working.

## Revisit when

Any one of: a vendor ships full-body framing; billing moves from streamed
minutes to synthesised speech; or a close-up mode becomes a real feature, at
which point a per-minute head is the right tool for the minutes it is on screen
and the VRM stays for the other twenty-three hours.
