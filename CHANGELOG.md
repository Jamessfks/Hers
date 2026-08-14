# Changelog

## 1.1.0 — 2026-08-14

### The model picker was quietly broken

Switching language provider kept the old provider's model. Going from Anthropic
to OpenAI left `claude-sonnet-5` configured, so every request failed with a
vendor error nobody would trace back to a dropdown they had touched a minute
earlier. Model names also lived in two places — each provider and the settings
window — free to drift apart.

Now there is one catalogue, and `resolveModel` is a pure function that *cannot*
return a model belonging to another vendor. It prefers what you last chose for
that provider, keeps a custom or fine-tuned id if the provider offers it, and
falls back through the catalogue. Planting the corrupt state on disk and
launching now self-heals it.

The picker also fetches your account's **real** model list — `GET /v1/models` on
Anthropic and OpenAI, `models?pageSize` on Google — filtered to models Anna can
actually hold a conversation through, so it no longer opens on `babbage-002`.
Falls back to the built-in list when there is no key or no network, and says
which one you are looking at.

### The key settings are finished

- **Remove** a stored key. The handler existed; nothing called it.
- **Reveal** what you just pasted, to check it before committing.
- **A warning when a key is in the wrong box** — three key fields and three
  vendors with distinct prefixes makes this the most common mistake here, and
  "401 authentication_error" is a poor way to discover it.
- Real clickable links to each provider's key page, opened in your browser.
- `stt.openai` could not be stored at all despite being selectable.

### She reacts to you, not only to herself

`BrainState` reached the renderer and died there on a CSS attribute — it never
touched the avatar. Whether you were typing, talking, or being answered, she ran
the identical idle loop. Every reaction she had was to her own output.

Now listening, thinking and speaking each carry their own posture, gaze
behaviour and backchannel. The numbers come from conversation analysis rather
than taste: people hold their partner's gaze roughly three quarters of the time
while **listening** and under half while **speaking**, so she does too, in held
fixations rather than a constant stare. While listening she nods every ten to
twenty seconds at low intensity, which is what listeners actually do.

### Lip sync stopped being a hinge

The mouth was driven by loudness with a sine drift between three shapes, so it
opened the same way for "ee" as for "oh". It now estimates the vowel from the
audio spectrum — F1 for how open the jaw is, F2 for tongue position, and a top
band for fricatives, which close the mouth to a slit rather than opening it.
Provider-agnostic, no extra latency, one extra FFT read per frame.

### Tests

131, up from 76. The new ones are mock-based: an injected `fetch` exercises each
LLM adapter against recorded vendor payloads including the failure shapes — a
mid-stream error arriving under HTTP 200, OpenAI's non-JSON `[DONE]` sentinel, a
Gemini safety block, a 429, an offline network — none of which a live account
will produce on demand.

### Known limits, updated

- Gesture *choice* is semantic but its *timing* is not: a directive fires when
  it is parsed, while the audio for that clause arrives later. Cartesia's
  `add_timestamps` / `add_phoneme_timestamps` on the same SSE stream would
  anchor both gestures and visemes to the audio clock at no latency cost. That
  is the next thing worth doing.
- Anna's gaze aims at a fixed viewer position, not at where your head actually
  is.

## 1.0.0 — 2026-08-14

First release. Anna is a full-body AI companion in a transparent, always-on-top
macOS window, running on API keys you supply.

### She talks like a person

A persona written as prohibitions with a worked transcript rather than as
adjectives, because "be warm" does nothing to a model and "never offer a
numbered list of options" does. She leads conversations instead of only
reflecting them, can be disappointed in you, and never says "I'd be happy to".

There is one thing she does not play: if you are in real danger she drops the
character entirely.

### She comes with a body

The default is `AvatarSample_B`, a VRoid Studio sample avatar released **CC0**
by pixiv — copyright waived, no attribution, no conditions. Fetched at build
time against a pinned SHA-256 rather than committed, so the repository stays
free of a 15MB binary and the file cannot be quietly swapped. Drag any other
`.vrm` onto her window, or pick one in Settings.

### She moves because she decided to

Anna writes her own stage directions inline — `[lean_in]`, `[skeptical]`,
`[gaze:user]` — and a streaming parser peels them out as the tokens arrive, so a
gesture fires while the sentence around it is still being generated.

- 18 gesture clips, authored against the VRM humanoid spec so they transfer to
  any character you load
- Idle, gesture and speech composited every frame — she keeps breathing while
  she waves, which is what separates a character from a puppet
- Ballistic saccades and real eye contact with the viewer's actual position
- Jaw driven by the audio envelope, smoothed fast-open and slow-close

### She remembers

Turns are distilled into durable facts by a background pass, embedded, and
retrieved by a blend of semantic similarity, recency, stated confidence and
damped usage. Everything she knows is visible in Settings and removable one
line at a time.

### She notices, and mostly says nothing

Screen activity, camera, microphone and calendar, all off unless you turn them
on. The attention policy is mostly rules about staying quiet: one opener per
cooldown, a longer cooldown per trigger, absolute quiet hours, and never while
you are mid-conversation.

### Bring your own keys

| | |
| --- | --- |
| Language | Anthropic, OpenAI, Google |
| Voice | Cartesia Sonic, ElevenLabs, Hume Octave |
| Hearing | Deepgram, OpenAI |

Keys are checked with the provider before they are stored, then kept in the
macOS Keychain. They never reach the window that draws her.

### Settings

A real preferences window: key entry with live validation, a voice picker you
can audition before choosing, a character picker, sense toggles that report
which macOS permissions are *actually* granted and deep-link to the right pane,
presence limits, and a memory inspector.

Plus a menu bar item, because an always-on app needs somewhere to live.

### She can be sent away

The ✕ beside her composer fades her out and hides the window. ⌥⌘A brings her
back, as does the menu bar item. Hiding stops her mid-sentence and suppresses
her speaking first while she is gone: a voice from something you deliberately
dismissed is worse than no companion at all. The global shortcut exists because
macOS silently hides menu bar items when the bar is full, and an app you can
dismiss but not recall is a bug wearing a feature's clothes.

### A menu bar item

Show or hide her, toggle proactivity, camera and microphone, open settings,
quit. An always-on app needs somewhere to live that is not a dock icon.

### Notable fixes during development

Found by a critic pass against the quality bar and by writing the docs:

- **She never made eye contact.** Gaze aimed straight out from her own head,
  which for a figure framed head-to-toe is well above and behind the viewer.
- **Memory had a self-reinforcing loop.** Retrieval refreshed a fact's recency,
  which guaranteed it was retrieved again — the first facts learned would have
  been pinned to the top of every recall for the life of the install.
- **Style examples masqueraded as history.** A fresh install would have opened
  by asking how the interview went. There was no interview.
- **A dropped character did not survive a restart.** The renderer can only make
  a `blob:` URL, and a blob URL dies with the window.
- **`null` could not clear a setting**, so quiet hours could never be switched
  off.
- **The permission probe prompted for calendar access on first launch**, for a
  feature that is off by default.
- **A stray `[` swallowed the rest of a reply**, and `stt.openai` could not be
  stored despite being selectable.
- **She stood in a T-pose.** The standing rest pose was described in a comment
  in `poses.ts` and never actually implemented; when it was, the sign was
  inverted and she raised both arms over her head instead. Caught by looking at
  her, then pinned down with a test.
- **The tray icon vanished when packaged.** `nativeImage.createFromPath` inside
  an `.asar` returns an empty image without throwing or logging, leaving a Tray
  that exists and shows nothing. It is inlined as base64 now.

### Known limits

- macOS only. Window behaviour and every sensor is AppKit-specific.
- On a notched display with a busy menu bar, macOS may hide her menu bar item
  entirely. The window's gear and ⌘, both reach Settings regardless.
- Speaking to her is slower than typing to her: the 800ms budget is measured
  from the transcript being in hand, and voice adds a 420ms VAD hang plus a
  non-streaming transcription round trip on top.
- The `heygen` and `tavus` avatar backends are a seam with nothing behind them.
- She has no persistent mood. She remembers what you told her, but nothing about
  how you have treated her carries between turns.
- No locomotion. `sit_down` holds a pose; she does not walk.
- Unsigned build — macOS will need a right-click → Open on first launch.
