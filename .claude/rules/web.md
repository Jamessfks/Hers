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
- **Sense indicators are drawn from `MediaStreamTrack.readyState`**, never from a
  WebSocket message. The hardware's own account is the only one allowed to say
  whether the camera is open. A claim from the socket that contradicts it is
  refused in both directions.
- `call/index.html` is a single static file with no build step, published to
  GitHub Pages because a phone cannot reach the user's machine.

The interface carries twelve declared colours. Adding a thirteenth needs a
reason — and watch for the ones you did not declare: Chrome will paint a focus
ring, a range track and a checkbox border in its own greys and blues if you let
it, which is how four arrived without anybody choosing them.
