# Anna

An always-on AI companion who lives at the edge of your screen.

Anna is a photograph of a person in a small always-on-top macOS panel, animated
by short video clips generated from that one photograph. She sees what you are
doing, remembers what you told her last week, speaks first when something is
worth speaking about, and talks like a person rather than like a product. You
bring your own API keys; nothing is hosted by us, and nothing leaves your
machine except the provider calls you configured.

The reference point is Joi from *Blade Runner 2049* — presence, not assistance.
The engineering bar is [Grok's Ani](docs/BENCHMARK.md).

> **Status: v1.0.0.** Runs from source on Apple Silicon; packages to a `.dmg`
> with `npm run dist:mac`. She ships with a settings window and a menu bar item,
> but **no body until you give her a photograph** — see
> [Her body](#her-body). What is still missing, including several things that
> look finished and are not, is listed honestly in
> [Not done yet](#not-done-yet).

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
inline directives — `[lean_in]`, `[skeptical]`, `[nod]` — in the middle of her
own sentences, and a streaming parser peels them out as the tokens arrive. The
gesture fires while the sentence around it is still being generated. This is the
mechanism that makes Ani read as alive, and it is the thing idle-loop avatars
cannot fake.

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

### See it first, without a key

```bash
npm run demo
```

Scripted replies and the macOS system voice, so the whole product runs end to
end — streaming clauses, gestures on the beat, real audio, real lip sync — with
nothing to sign up for. Add `ANNA_DEMO_SCRIPT="hey|i bombed the interview"` to
play a whole exchange in on its own.

Both stand-ins are real implementations of `LlmProvider` and `TtsProvider`
rather than stubs, which is what makes the demo worth having: the streaming
path, the clause chunking, the audio scheduler and the formant-based lip sync
are all genuinely exercised. It is the development loop too — none of that
needed a paid request to build.

### Then give her real keys

Two at minimum — one to think with, one to speak with.

| Purpose | Providers | Where to get a key |
| --- | --- | --- |
| Language | Anthropic, OpenAI, Google | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Voice | Cartesia, ElevenLabs, Hume | [play.cartesia.ai](https://play.cartesia.ai/keys) |
| Hearing | This Mac — no key needed | Built in, offline, default |

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

Settings also holds the voice picker (with an audition button), the photograph
picker and the video-provider chooser, the sense toggles — which report which macOS permissions are *actually*
granted and deep-link to the right System Settings pane — the limits on when she
speaks first, and a memory inspector where you can read everything she knows and
forget any of it one line at a time.

### Her body

**One photograph is the whole avatar.** There is nothing bundled — she is a
still image until you give her one, and then a progressively animated one.

Drag any JPEG, PNG or WebP onto her window, or use **Settings → Her body →
Choose a photo…**. The file extension is ignored and the bytes are sniffed, so a
JPEG named `.png` works. Two limits, both enforced before anything is spent:
at most **10 MB**, and at least **512px** on the short edge — below that her
face is upscaled by the video model and it shows.

**The shot matters more than the resolution.** Every clip is generated *from*
this frame and is supposed to return *to* it, so:

- her face should be visible and roughly facing the camera;
- whatever is behind her is behind her for as long as she is on screen;
- a frame that includes her hands unlocks the gestures that use them — a
  head-and-shoulders crop cannot wave, point, or put a hand to its chest.

The output shape follows the photograph's own aspect ratio, and the panel
resizes to match it, so a square portrait gives a square panel rather than one
with black bars.

#### The clip library

Nineteen clips: one `idle` loop plus eighteen gestures. They are rendered
**once, ahead of time**, by a video model — not during a conversation, which is
why an offline model measured in minutes is usable here at all.

Until the `idle` clip exists she *is* the photograph, with a very slow CSS
breathing effect so the panel does not read as frozen. That is a normal state,
not a failure. Each clip that lands makes her a little more animated.

**Rendering costs real money**, so the build button renders **one clip and
stops** by default. That is deliberate: the first clip tells you what it
actually costs and whether the result is any good, before you order eighteen
more of the same.

| Provider | Key | What it is | Cost |
| --- | --- | --- | --- |
| **Bring your own clips** | none | Render them yourself in any tool and drop the files in a folder | nothing here |
| **Runway** (`gen4_turbo`) | required | Prompt-driven, no audio. Renders silent gesture clips natively | **$0.25/clip, ~$4.75 for all 19** — published rate |
| **Hedra** (`hedra-character-3`) | required | Audio-driven. The only one that can lip-sync a specific line | billed per second of audio; **will not quote before rendering** |
| Luma, Kling | — | Selectable and **not implemented** — they refuse rather than call an unverified endpoint | — |

---

## Which providers, and why these

The instruction was "research the best voice and video models and support the
top 3". The full comparison is in [docs/PROVIDERS.md](docs/PROVIDERS.md); the
short version:

**Voice.** Cartesia Sonic is the default because it is fastest to first sound
(~40–90ms), and latency is the axis you *feel*. ElevenLabs is the most
expressive. Hume Octave is the only one that takes a natural-language acting
note per line, which fits a character who already decides her own emotional beat.

**Body.** The original answer was a rigged VRM drawn locally, on the grounds
that every *real-time* video-avatar API is a head-and-shoulders crop billed per
streamed minute — which makes idling the most expensive thing a companion does.
That reasoning still holds, and the market settled the rest of it: Hedra's
realtime avatar now answers `410 Gone`.

The answer that replaced it keeps the conclusion and drops the rig. Clips are
generated **offline, once, at setup**, so latency is a progress bar rather than
a design constraint and the cost is paid once instead of per minute — while the
face on screen is a real one rather than a synthetic one. Both decisions are
written up in [docs/adr/0003-avatar-renderer.md](docs/adr/0003-avatar-renderer.md)
(superseded) and [docs/adr/0004-photo-avatar.md](docs/adr/0004-photo-avatar.md).

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
npm run demo       # the whole thing, no API key needed
npm run dev        # run with hot reload
npm test           # 323 unit tests, no network
npm run typecheck  # strict, noUncheckedIndexedAccess
npm run build      # production bundle
npm run dist:mac   # build the Swift helper, bundle, package a .dmg
```

Tests run on Node's built-in runner with native type stripping — no Jest, no
ts-node, no transform step. Provider adapters are tested against recorded vendor
payloads through an injected `fetch`, which is the only way to cover the half
that matters: a mid-stream error arriving under HTTP 200, OpenAI's non-JSON
`[DONE]` sentinel, a Gemini safety block, a 429, an offline network. The rest
cover the parts where being wrong is silent:
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

Stated plainly, because a README that implies otherwise wastes your time. The
first five were found by a code audit *after* the avatar pivot and are the ones
most likely to bite, because the code around them reads as though they work.

- **The seam check never runs.** `seam.ts` measures whether a clip returns to
  the source photograph, and `hologram.ts` claims that invariant is verified.
  Nothing calls it outside its own tests, so `verified` is never set and a
  drifted clip is accepted. The measurement is correct; the wiring is missing.
- **A crash mid-render re-charges you.** The job handle is never written to the
  manifest, so `reconcile` cannot tell "still running" from "lost" and requeues.
  Quitting during a render means paying for that clip twice.
- **One transient poll error discards a paid, still-running job.** A 429 or a
  sleeping laptop propagates up and nulls the handle. Comments in two adapters
  claim the opposite; they are wrong.
- **Swapping the photograph mid-render mixes libraries.** `adopt()` is not
  covered by the build lock, so an in-flight clip lands in the new photograph's
  directory.
- **`stand_up` is generated from the wrong frame.** It is supposed to start from
  the last frame of `sit_down`; the anchor is computed and then dropped, so one
  clip per library is knowingly wrong.
- **No sit/stand locomotion.** `sit_down` holds a pose; she does not walk.
- **Ambient audio sensing is mic-triggered only.** She does not listen to the
  room when you are not talking to her, by design, but that also means she
  cannot notice that you sighed.
- **macOS only.** The window behaviour and every sensor is AppKit-specific.
- **The build is not notarised, and signing is not configured in the repo**, so
  the first launch needs a right-click → Open.
- **Voice input is slower than the budget.** See the note under Development.
- **She has no persistent mood.** Anna remembers what you told her, but nothing
  about how you have treated her carries between turns, so there is nothing to
  win or lose with her. Ani has an affection score; this does not.
- **Gesture timing is not anchored to the audio.** A directive fires when it is
  parsed; the audio for that clause arrives later, so a `[nod]` can drift off
  its own words.
- **A render cannot be cancelled.** There is no abort path once a clip is
  submitted.

## Licence

MIT. The photograph you give her, and any clips generated from it, are yours and
are governed by the terms of whatever produced them — not by this licence.
