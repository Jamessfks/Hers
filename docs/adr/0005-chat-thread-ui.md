# 0005 — The conversation is the interface, and she is behind it

**Status:** accepted. Amends the presentation half of
[0004](0004-photo-avatar.md); the avatar decision itself is unchanged.

## Context

[0004](0004-photo-avatar.md) settled what Anna's body *is* — one photograph plus
clips generated from it — and, almost incidentally, how it is presented. That
second part was a set of choices made to serve a rigged-figure-in-a-box idea:

- an opaque bezel around a "well", so the panel read as a device on the desk;
- `object-fit: contain` inside the well, so no part of a clip was ever cropped;
- the window resizing itself to the photograph's aspect ratio, so `contain`
  never had to letterbox;
- one line of subtitle that faded out about two and a half seconds after she
  stopped speaking, on the grounds that she is voice-first and a permanent text
  box "would make her a chat app with a mascot."

Each of those is defensible on its own. Together they produced an app with three
problems that only show up in use.

**There was no way to re-read anything.** The subtitle faded. If you looked away
mid-sentence, or she said something you wanted to think about, it was gone —
and typing at her left no record that you had. For something whose entire
premise is that it remembers you, the interface forgot everything instantly.

**The bezel spent the window's best pixels on nothing.** A square photograph in
a tall panel, plus a frame around it and a composer under it, meant a large
share of an always-on-top window was matte grey enclosure and black letterbox.

**The fear behind the subtitle was the wrong fear.** "A chat app with a mascot"
describes a layout where the portrait is a decoration beside the text. It does
not describe one where the figure *is* the surface and the text floats on her.
Avoiding the first by refusing to keep a transcript threw away the feature, not
the failure mode.

## Decision

**The clip fills the entire window, and the conversation floats on top of it as
a stack of instant-messaging bubbles.**

Concretely:

- `object-fit: cover`, not `contain`. Nothing letterboxes or pillarboxes at any
  window size; a clip whose shape does not match the window loses its edges
  instead of gaining black bars.
- The window is a fixed phone-shaped frame — 406x880, an aspect of 0.461 — and
  no longer resizes itself to the photograph. `fitHeight` on the bridge lost its
  only caller.
- The subtitle is replaced by `renderer/chat.ts`: a thread of bubbles, one per
  clause. The speech governor already chunks her at breath points for the TTS
  path, and that chunking is the chat rhythm too, so nothing is re-segmented.
- Chrome is three floating rows over her — a name pill and a gear at the top, a
  composer at the bottom — with no bar surface behind either.
- Every dimension in `styles.css` is a multiple of `--s`, one point of a 393x852
  reference screen. The layout is the same at every window size rather than
  correct at one and approximate elsewhere.

## Consequences

**The window's proportions are now load-bearing.** The avatar gutter, the bubble
column and the composer are calibrated to a tall narrow frame and come apart in
a wide one, which is why `--s` follows the scarcer axis and the content column
is centred rather than stretched.

**The framing of the source photograph matters more.** Under `contain` a subject
anywhere in the frame survived. Under `cover` in a 0.461 window only the middle
~46% of a square source is on screen, so a subject off to one side is cropped
out of their own portrait. The guidance in the README changed to match.

**The thread does not persist.** It is built from live IPC events and dies with
the window. Her memory is unaffected — that is `memory.db` and a separate
concern — but relaunching shows an empty conversation with someone who still
knows you. Fixing it needs a transcript store in main; it is listed in the
README under Not done yet rather than pretended away.

**The in-window dismiss button is gone.** The bar this layout copies has exactly
two controls and a third would be the only thing on screen with no counterpart
in the reference. ⌥⌘A and the menu bar item both still hide her, and both
predate the ✕.

**One thing this cannot fix.** The reference layout shows a figure standing at
full height in a room. Whether Anna reads that way depends entirely on how the
clip was generated, not on any of the above — a tightly framed `idle` clip fills
the window with a face however the CSS is written.
