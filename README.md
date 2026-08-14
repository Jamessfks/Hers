# Anna

An always-on AI companion who lives at the edge of your screen.

Anna is a full-body 3D character in a transparent, always-on-top macOS window.
She sees what you are doing, remembers what you told her last week, speaks first
when something is worth speaking about, and talks like a person rather than like
a product. You bring your own API keys; nothing is hosted by us, and nothing
leaves your machine except the provider calls you configured.

The reference point is Joi from *Blade Runner 2049* — presence, not assistance.
The engineering bar is [Grok's Ani](docs/BENCHMARK.md).

> **Status: v1.0.0.** Built, packaged and signed as a `.dmg` for Apple Silicon
> and Intel. She ships with a body, a settings window, and a menu bar item.
> What is still missing is listed honestly in [Not done yet](#not-done-yet).

---

## What makes this different

Most companion apps are a chat window with a portrait on top. Three decisions
separate Anna from that:

**She is not an assistant, and the prompt fights hard to keep it that way.**
Every frontier model reverts to "helpful assistant" under pressure. The persona
in [`src/core/persona/anna.ts`](src/core/persona/anna.ts) is written as
prohibitions with examples rather than as adjectives, because "be warm" does
nothing and "never offer a numbered list of options" does.

**She moves because she decided to, not because a timer fired.** Anna writes
inline directives — `[lean_in]`, `[skeptical]`, `[gaze:user]` — in the middle of
her own sentences, and a streaming parser peels them out as the tokens arrive.
The gesture fires while the sentence around it is still being generated. This is
the mechanism that makes Ani read as alive, and it is the thing idle-loop
avatars cannot fake.

**She remembers, and the memory is ranked rather than dumped.** Turns are
distilled into durable facts by a background pass, embedded, and retrieved by a
blend of semantic similarity, recency, stated confidence and how often a fact has
proved useful. Asking about the interview a week later without being reminded is
the entire product.

---

## Quick start

```bash
git clone https://github.com/Jamessfks/anna-embodied.git
cd anna-embodied
npm install
npm run dev
```

Then give her at least two keys — one to think with, one to speak with.

| Purpose | Providers | Where to get a key |
| --- | --- | --- |
| Language | Anthropic, OpenAI, Google | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Voice | Cartesia, ElevenLabs, Hume | [play.cartesia.ai](https://play.cartesia.ai/keys) |
| Hearing (optional) | Deepgram, OpenAI | [console.deepgram.com](https://console.deepgram.com) |

Keys go in through **Settings** — from the menu bar item, the gear beside her
composer, or ⌘,. Each one is checked with the provider before it is stored, so
a bad key tells you immediately rather than leaving her mute later. They are
then kept in the macOS Keychain through Electron's `safeStorage`, never written
to the config file, and never handed to the window that draws her. See
[docs/PRIVACY.md](docs/PRIVACY.md).

**Sending her away.** The ✕ beside her composer fades her out and hides the
window; ⌥⌘A brings her back, and so does the menu bar item. Hiding is not just
a window state — she stops mid-sentence and will not speak first while she is
gone, because being ambushed by a voice from something you deliberately
dismissed is the fastest way to lose trust in an always-on app.

Settings also holds the voice picker (with an audition button), the character
picker, the sense toggles — which report which macOS permissions are *actually*
granted and deep-link to the right System Settings pane — the limits on when she
speaks first, and a memory inspector where you can read everything she knows and
forget any of it one line at a time.

### Her body

Anna ships with one. The default is `AvatarSample_B`, a VRoid Studio sample
avatar released **CC0** by pixiv — copyright waived, no attribution required, no
conditions. That licence is the whole reason it was chosen: it is the only
category of character that can be put inside an application without asking
anything of the user or of the author.

It is fetched at build time against a pinned SHA-256 rather than committed, so
the repository stays free of a 15MB binary and the file cannot be quietly
swapped. See [`scripts/fetch-character.mjs`](scripts/fetch-character.mjs).

**To use a different one, drag any `.vrm` onto her window**, or pick one in
Settings. Free characters are on [VRoid Hub](https://hub.vroid.com/); you can
make your own in [VRoid Studio](https://vroid.com/en/studio) in an afternoon.
If no character is available at all, she falls back to a luminous stand-in
figure that breathes and lights up when she speaks.

Gestures are authored against the humanoid bone names in the VRM spec rather
than baked as retargeted animation, so they transfer across characters without
a retarget step. They are tuned against T-pose rest, which is what VRoid
exports; an A-pose character will read the arm gestures as exaggerated until
the rest pose is calibrated, which is not built yet.

---

## Which providers, and why these

The instruction was "research the best voice and video models and support the
top 3". The full comparison is in [docs/PROVIDERS.md](docs/PROVIDERS.md); the
short version:

**Voice.** Cartesia Sonic is the default because it is fastest to first sound
(~40–90ms), and latency is the axis you *feel*. ElevenLabs is the most
expressive. Hume Octave is the only one that takes a natural-language acting
note per line, which fits a character who already decides her own emotional beat.

**Body.** Every real-time video-avatar API — HeyGen, Tavus, Hedra, Simli — is
framed head-and-shoulders and runs at 200ms–1.5s. That is fine for a video call
and wrong for a companion standing in your room. So the primary renderer is a
rigged VRM driven locally at 60fps with zero per-minute cost, and the video
backends sit behind the same `AvatarRendererId` seam for close-ups. This was a
deliberate reversal of the original brief and the reasoning is written up in
[docs/adr/0003-avatar-renderer.md](docs/adr/0003-avatar-renderer.md).

---

## How it fits together

```
┌─ main process ──────────────────────────────────────────┐
│  keys (Keychain)   memory (SQLite)   sensors (macOS)    │
│                                                         │
│  Companion ── turn loop, barge-in, latency budget       │
│    ├── LlmProvider     anthropic │ openai │ google      │
│    ├── TtsProvider     cartesia  │ 11labs │ hume        │
│    ├── Memory          turns → facts → recall           │
│    └── Attention       when she speaks first            │
└──────────────────────┬──────────────────────────────────┘
                       │  PerformanceEvent + PCM
┌──────────────────────▼──────────────────────────────────┐
│  renderer — the body. No keys, no disk, no network.     │
│  Body: idle ⊕ gesture ⊕ speech    SpeechPlayer          │
│  Microphone (local VAD)           Vision (slow frames)  │
└─────────────────────────────────────────────────────────┘
```

The full design, including the 800ms latency budget and why the process
boundary is where it is, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Development

```bash
npm run dev        # run with hot reload
npm test           # 76 unit tests, no network, no mocks of our own code
npm run typecheck  # strict, noUncheckedIndexedAccess
npm run build      # production bundle
npm run dist:mac   # fetch character, build, package a .dmg
```

Tests run on Node's built-in runner with native type stripping — no Jest, no
ts-node, no transform step. They cover the parts where being wrong is silent:
the streaming directive parser, SSE framing across chunk boundaries, PCM frame
alignment, memory ranking, the attention policy, and the turn loop's latency and
ordering guarantees.

**On the 800ms figure.** It is measured from the transcript being in hand to the
first audio sample, and that is what the test asserts. Typing to her hits it.
Speaking to her does not yet: the local VAD spends 420ms deciding you have
stopped, and transcription is a non-streaming round trip on top, so real
end-of-speech to first audio is nearer 1.1-1.7s. Closing that needs streaming
transcription with interim results. The number is quoted this way everywhere in
the repo rather than quoted as end-to-end.

---

## Not done yet

Stated plainly, because a README that implies otherwise wastes your time.

- **The video-avatar backends are a seam, not an implementation.** `heygen` and
  `tavus` are valid values of `AvatarRendererId` with nothing behind them.
- **No sit/stand locomotion.** `sit_down` holds a pose; she does not walk.
- **Ambient audio sensing is mic-triggered only.** She does not listen to the
  room when you are not talking to her, by design, but that also means she
  cannot notice that you sighed.
- **macOS only.** The window behaviour and every sensor is AppKit-specific.
- **The build is signed but not notarised**, so the first launch needs a
  right-click → Open.
- **Voice input is slower than the budget.** See the note under Development.
- **She has no persistent mood.** Anna remembers what you told her, but nothing
  about how you have treated her carries between turns, so there is nothing to
  win or lose with her. Ani has an affection score; this does not.

## Licence

MIT. The character model you load is governed by its own licence, not this one.
