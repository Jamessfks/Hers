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

The interface carries twelve declared colours. Adding a thirteenth needs a
reason — and watch for the ones you did not declare: Chrome will paint a focus
ring, a range track and a checkbox border in its own greys and blues if you let
it, which is how four arrived without anybody choosing them.
