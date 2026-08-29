---
description: Constraints on the site and the call page — local assets, secure context
paths:
  - "src/web/**"
  - "call/**"
---

# The site

Served from `127.0.0.1:5175`. Bundled by Vite; it is the only part of the repo
with a build step.

- **Every asset is local.** No CDN link, no Google Fonts, no jsdelivr, no
  unpkg. If a library is needed it becomes a dependency and gets bundled.
- **The host stays `127.0.0.1`.** The microphone, camera, and screen share all
  need a secure context, which `localhost` is without a certificate and anything
  else is not. The page has no password.
- **The senses are not switches.** They come up when she wakes and go down when
  she sleeps, on the same user gesture that unlocks audio. v1 had three toggles
  and two affordances racing for the gesture, and whichever was pressed first
  decided whether she could be heard at all. v2.0 then removed the toggles and
  left the server-side default off, so a whole release shipped unable to hear —
  `conversation.test.ts` now wakes through the real path and asserts the bytes
  arrive.
- **The screen is the one sense that differs by surface.** The desktop app
  grants a remembered source silently through Electron's display-media handler;
  a browser tab cannot, because `getDisplayMedia` prompts on every call. The
  `ready` message carries `desktop` so the page knows which it is. Do not sniff
  the user agent for this.

- **There is one object on the page and it is centred.** The sphere is the
  content, not an element within a layout. Anything else — her name, her mood,
  the Setup button — is a caption or a control and must not push her off the
  axis of the window. The caption is out of flow beneath her for exactly that
  reason.

- **The palette comes from the mark, and the mark is one warm light in a cool
  violet room.** The neutrals are that room: hue 278 at real chroma, sampled
  from `docs/social-preview.jpg`, whose wall measures `oklch(22.8% 0.085 276)`.
  `--glow` is the light in the alcove, `oklch(90% 0.04 50)`, and it is what the
  sphere's highlight and horizon are made of. Her accent stays hers, but its
  hue sweeps 236 to 348 — blue through violet to rose — so that every mood she
  can be in is still a colour from that image. It used to run 154 to 278, and
  the low half of that was a saturated green that read as a different product.

The interface carries thirteen declared colours on a dark violet ground. The
thirteenth is `--glow` and it earned its place: the warm light was the one thing
in the mark the other twelve could not say. Adding a fourteenth needs the same
kind of reason — and watch for the ones you did not declare: Chrome will paint a
focus ring, a range track and a checkbox border in its own greys and blues if
you let it, which is how four arrived without anybody choosing them. Raw
`oklch()` outside `:root` is the other way one arrives.
