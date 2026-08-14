# Anna

An always-on AI companion who lives at the edge of your screen.

Anna is a full-body 3D character in a transparent, always-on-top macOS window.
She sees what you are doing, remembers what you told her last week, speaks first
when something is worth speaking about, and talks like a person rather than like
a product. You bring your own API keys; nothing is hosted by us, and nothing
leaves your machine except the provider calls you configured.

The reference point is Joi from *Blade Runner 2049* — presence, not assistance.
The engineering bar is [Grok's Ani](docs/BENCHMARK.md).

> **Status: v0.1, working vertical slice.** The brain, memory, voice, sensors,
> attention policy and body are built and tested end to end. What is not done is
> listed honestly in [Not done yet](#not-done-yet). She ships without a character
> model — see [Giving her a body](#giving-her-a-body).

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
git clone https://github.com/Jamessfks/anna.git
cd anna
npm install
npm run dev
```

Then give her at least two keys — one to think with, one to speak with.

| Purpose | Providers | Where to get a key |
| --- | --- | --- |
| Language | Anthropic, OpenAI, Google | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Voice | Cartesia, ElevenLabs, Hume | [play.cartesia.ai](https://play.cartesia.ai/keys) |
| Hearing (optional) | Deepgram, OpenAI | [console.deepgram.com](https://console.deepgram.com) |

Keys are stored in the macOS Keychain through Electron's `safeStorage`. They are
never written to the config file and never sent to the window that draws her.
See [docs/PRIVACY.md](docs/PRIVACY.md).

### Giving her a body

Anna ships without a character model, because every good VRM belongs to
somebody. Until you give her one she appears as a luminous stand-in figure that
breathes, sways and lights up when she speaks — enough to show the pipeline is
alive, obviously not the finished article.

**Drag any `.vrm` file onto her window.** That is the whole setup. Free models
are on [VRoid Hub](https://hub.vroid.com/); you can also make one in
[VRoid Studio](https://vroid.com/en/studio) in an afternoon.

Every gesture works on any VRM, because the clips are authored against the
humanoid bone names in the VRM spec rather than baked as retargeted animation.

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
npm test           # 57 unit tests, no network, no mocks of our own code
npm run typecheck  # strict, noUncheckedIndexedAccess
npm run build      # production bundle
npm run dist:mac   # signed .dmg
```

Tests run on Node's built-in runner with native type stripping — no Jest, no
ts-node, no transform step. They cover the parts where being wrong is silent:
the streaming directive parser, SSE framing across chunk boundaries, PCM frame
alignment, memory ranking, the attention policy, and the turn loop's latency and
ordering guarantees.

---

## Not done yet

Stated plainly, because a README that implies otherwise wastes your time.

- **No settings UI.** Keys and provider choice go through IPC handlers that
  work, but the window that calls them is not built. Configure by editing
  `~/Library/Application Support/Anna/config.json` for now.
- **The video-avatar backends are a seam, not an implementation.** `heygen` and
  `tavus` are valid values of `AvatarRendererId` with nothing behind them.
- **No sit/stand locomotion.** `sit_down` holds a pose; she does not walk.
- **Ambient audio sensing is mic-triggered only.** She does not listen to the
  room when you are not talking to her, by design, but that also means she
  cannot notice that you sighed.
- **macOS only.** The window behaviour and every sensor is AppKit-specific.

## Licence

MIT. The character model you load is governed by its own licence, not this one.
