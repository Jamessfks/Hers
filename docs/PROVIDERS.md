# Providers

The brief was: research the best voice and video models, and support the top
three of each.

Voice has a clean answer, and it is in the code — three adapters behind one
interface, ranked in [`TTS_PROVIDER_INFO`](../src/core/speech/index.ts). Video
does not have a clean answer. The honest finding is that the realtime
video-avatar category is built for a different product than this one, and the
second half of this document explains what we did instead and what it cost.

---

## Voice

| Provider | Model in use | First audio | Wire format | Direction you can give it | Cost model | Best at |
| --- | --- | --- | --- | --- | --- | --- |
| **Cartesia Sonic** *(default)* | `sonic-3` | ~40–90ms | `pcm_f32le` @ 44.1k over SSE | Voice choice only | Credit pool, drained per character | Being first to make a sound |
| **ElevenLabs** | `eleven_flash_v2_5` | ~150ms | `pcm_44100` s16le, raw chunked HTTP | Numeric `voice_settings` — stability, style, similarity | Monthly character quota per tier | Sounding like a person rather than a narrator |
| **Hume Octave** | Octave (`/v0/tts/stream/json`) | ~250ms | s16le base64 @ 48k over SSE | A natural-language acting note per line | Metered per character | Taking a direction instead of a setting |

The latency figures are the vendors' own, recorded in each adapter as
`typicalFirstByteMs` and used nowhere except the settings copy — nothing in the
turn loop trusts them. The cost models are visible in the error handling:
Cartesia is the only one with a 402 path (`'Cartesia account is out of
credit'`), ElevenLabs is the only one whose 429 means a spent quota rather than
a rate limit.

### Cartesia Sonic — the default

Latency is the axis you *feel*. The 800ms budget in
[ARCHITECTURE.md](ARCHITECTURE.md) allocates ~90ms to time-to-first-audio, and
Cartesia is the only vendor here that fits inside that without the rest of the
budget having to shrink. Their state-space model architecture is the reason:
generation is recurrent rather than a full attention pass over the utterance, so
the first samples come back before the sentence has been planned.

Two secondary wins fall out of that choice, both structural rather than
cosmetic:

- Cartesia is the only vendor of the three that will hand back `pcm_f32le`. The
  renderer plays `Float32Array` directly, so this path does no format conversion
  at all — see `f32leToFloat32` in [`speech/types.ts`](../src/core/speech/types.ts).
- Because Cartesia base64-encodes whole 4-byte frames, no realignment is needed.
  The other two need a `FrameAligner`, because a chunked response splits
  wherever the network feels like it and a 16-bit sample cut in half turns every
  subsequent sample into static.

What it does not have is range. Sonic reads a line well; it does not *act* one.

### ElevenLabs — the expressive one

Their v3 voices carry emotional range nothing else matches: laughter, a catch in
the breath, a line delivered dry. For a companion that is worth more than the
~60ms Cartesia saves, on the turns where it lands.

The adapter ships `eleven_flash_v2_5` rather than v3, because flash is the model
tuned for conversational latency and v3 is not; the expressive models are a
settings change away, at a cost to the budget the user can decide to pay.
`stability` is set to 0.35, deliberately low, so delivery varies line to line —
high stability is what makes a voice sound like an announcer reading the same
paragraph twice.

One vendor quirk is absorbed in the adapter and worth stating plainly:
`pcm_44100` is gated to paid tiers. On a free key the request fails with a 401
or a 422, which is indistinguishable from a bad key. So the adapter retries once
at `pcm_22050`, which every tier can produce, and declares the lower sample rate
to the renderer rather than resampling. A user on a free key gets a slightly
duller voice instead of an error that tells them their working key is broken.

### Hume Octave — the one that takes a note

Octave is the only vendor of the three that accepts a *description* alongside
the text — "quiet and careful, genuinely worried" — instead of exposing a fixed
set of emotion presets or a slider.

That is the right primitive for this specific product. Anna already decides her
own emotional beat: she writes `[concerned]` mid-sentence and the streaming
parser peels it out. Every other vendor makes us translate that decision into a
parameter. Hume lets us pass it through as an instruction. The translation table
lives in `ACTING_NOTES` in [`hume.ts`](../src/core/speech/hume.ts) and is ten
lines long, mapping each expression name to the sentence a director would say.

It is the slowest of the three by a wide margin, and `instant_mode` is on to
claw some of that back. It is the right default for someone who cares more about
delivery than about the first 150ms.

### What we did not pick, and why

**Deepgram Aura-2.** Fast, cheap, and already in the app — `nova-3` is one of
the two transcription options, so the account is usually there. It was still not
worth an adapter, because it competes on the axis Cartesia already wins and
loses on the axis Cartesia already loses. Its voices are tuned for agents and IVR:
clear, even, and flat. A fourth provider that is a slightly slower Cartesia with
less range is a settings-screen row that makes the choice harder without making
it better.

**OpenAI `gpt-realtime`.** The most tempting thing we rejected, and the rejection
is architectural rather than a matter of quality. Speech-to-speech collapses the
model and the voice into one call, which removes the seam Anna's entire body
system hangs off. Anna moves because a *text* stream carries `[lean_in]` and a
parser fires the gesture as the tokens arrive — a model that emits audio
directly gives us nothing to parse, and gesture timing dies with it. It also
welds the brain and the voice to a single vendor, which breaks the promise that
you bring whichever key you already pay for. If the body were a video avatar
this trade would be worth revisiting; with a local rig it is not.

**PlayHT.** Sits between Cartesia and ElevenLabs on latency and between them on
expressiveness, without beating either at what they are for. Third-best on both
axes is the precise definition of a provider you do not ship.

### Hearing

| Provider | Model | Note |
| --- | --- | --- |
| This Mac | `SFSpeechRecognizer` | Default. No key, no account, no network. |
| Deepgram | `nova-3` | Better on strong accents and noisy rooms. |
| OpenAI | `whisper-1` | Better outside English. |

The default is the OS. Every other provider in this document costs money, and
two of them are unavoidable — something has to generate the words and something
has to say them. Hearing is the one capability macOS already does well enough,
for free, without the audio leaving the machine, and charging a third signup for
it is how a microphone toggle stays off forever.

The accuracy gap is real but narrow, and it is the wrong thing to optimise
first: a companion who hears you imperfectly is enormously better than one who
cannot hear you at all. Both paid options stay one dropdown away.

Two things about it are worth knowing before touching that code. It needs no
key, which broke an assumption the main process had baked in: the transcription
path returned early when no key was stored, which for a keyless provider
silently swallowed every utterance. See `currentStt` in
[`index.ts`](../src/main/index.ts).

And it cannot read what the renderer records. `MediaRecorder` on macOS produces
WebM/Opus; CoreAudio, which is what `SFSpeechRecognizer` reads through, has no
Matroska parser at all, so `afconvert` refuses the file no matter which flags it
is handed (`Couldn't open input file ('typ?')`). The renderer therefore decodes
its own recording and re-emits it as 16kHz mono WAV before it crosses IPC — see
[`wav.ts`](../src/core/speech/wav.ts). The paid providers read WebM happily, so
that conversion falls back to the original bytes rather than failing.

Transcription runs in the main process on a finished utterance rather than as a
live socket from the renderer. A streaming socket would save a couple of hundred
milliseconds and would need the API key inside the process that loads
user-supplied character files. The reasoning, and the seam to use if that trade
ever flips, is at the top of [`stt.ts`](../src/core/speech/stt.ts).

---

## Avatar and video

### The finding

Every realtime video-avatar API on the market renders a head and shoulders, and
bills by the minute of stream.

| Backend | Published latency | Framing | Billing | Status here |
| --- | --- | --- | --- | --- |
| HeyGen LiveAvatar | ~1–2s | Head and shoulders | Per streaming minute | Not wired |
| Tavus (Phoenix-4 / CVI) | sub-600ms | Head and shoulders | Per conversation minute | Not wired |
| Anam | ~180ms | Head and shoulders | Per streaming minute | Not wired |
| Simli | Sub-second, face-only stream | Face | Per streaming minute | Not wired |
| Hedra (realtime) | — | Head and shoulders | Per minute | **Withdrawn.** The endpoint answers `410 Gone`; LiveKit's plugin throws |

Anam's ~180ms is genuinely impressive and Tavus's sub-600ms is usable. Neither
number is the problem.

### Why the category is wrong for this product

Three conflicts, in order of how hard they are to design around:

**Framing.** These APIs exist because the demand is video calls, sales agents
and support kiosks, and all of those are a face in a rectangle. Anna is supposed
to stand at the edge of your screen with a body — she sits down, she leans back,
she puts her hands behind her back. A head-and-shoulders crop cannot do any of
that, and no amount of engineering on our side widens someone else's camera.

**Cost that scales with presence, not with conversation.** Voice bills per
character, so an always-on companion who says nothing for six hours costs
nothing for six hours. Video bills per streamed minute, so the *idle* state —
which is most of the time, and is exactly the state where presence is the whole
product — is the most expensive thing in the app. A companion you switch off to
save money is not a companion.

**No control below the utterance.** A video-avatar API takes audio or text and
gives back a face that matches. It does not take "fold your arms at token 14".
Anna's body is driven by inline directives parsed mid-stream; handing the whole
performance to a remote renderer throws away the mechanism described in
[ARCHITECTURE.md](ARCHITECTURE.md) that makes her read as deciding rather than
reacting.

There is also the practical signal in the last row of the table. Hedra is
deprecated in LiveKit's plugin catalogue — the category is young enough that a
backend you build on can be gone inside a release cycle. That is a reason to
keep it behind a seam, not to build on top of it.

### What we did instead

*(Rewritten at v1.0. This section previously described a rigged VRM with the
video backends as an unimplemented seam. Both halves of that changed — see
[adr/0004-photo-avatar.md](adr/0004-photo-avatar.md).)*

The finding above still stands, and it is worth restating because it is what the
current design is built around: **realtime** video avatars are framed wrong and
billed wrong for a companion that idles all day.

So generation moved off the conversation path entirely. Anna's body is one
photograph plus nineteen clips rendered from it **once, at setup**. Latency
stops being a design constraint — a three-minute render is a progress bar — and
the cost is paid once instead of per minute of presence.

That inverts the economics the table above rejects. A full library is about
**$4.75** at Runway's published rate. Under the per-streamed-minute model, the
same money bought roughly an hour of standing still.

#### The video providers

Three are real, two are honest stubs. `VideoProviderId` lives in
[`protocol.ts`](../src/shared/protocol.ts) and the registry is in
[`core/avatar/video-provider.ts`](../src/core/avatar/video-provider.ts).

| Id | Key | Driven by | Price before you spend | Status |
| --- | --- | --- | --- | --- |
| `manual` | none | You, in any tool you like | Nothing is charged here | **Wired** |
| `runway` | `video.runway` | A written prompt. Accepts no audio | **Yes** — 5 credits/s at $0.01, so $0.25 for a 5s clip | **Wired** |
| `hedra` | `video.hedra` | A driving waveform | **No** — it refuses to quote before ingest, and bills by audio duration | **Wired** |
| `luma` | `video.luma` | — | — | Stub: `submit()` throws |
| `kling` | `video.kling` | — | — | Stub: `submit()` throws |

Both wired adapters were written against the vendor's own published OpenAPI
document — `api.hedra.com/v3/openapi.json` and
`docs.dev.runwayml.com/openapi.json` — and then checked against a live account.
The stubs were not, which is exactly why they refuse rather than call a URL
nobody verified.

**They are complementary, not interchangeable.** Eighteen of the nineteen slots
are *silent* gesture loops, which is what Runway does natively. Hedra has no
prompt-only mode at all, so a silent clip needs a fabricated near-silent track —
and it bills for that track's length regardless. Hedra earns its place on the
one thing only it can do: lip-sync a specific line Anna is about to say.

Two things live rendering taught us that no amount of reading would have:

- **Digital silence gets a job refused.** Hedra transcribes driving audio before
  moderating it, and an ASR model hallucinated a policy violation out of a
  buffer of zeros. `silentWav` now emits a −66 dBFS noise floor.
- **Failed jobs are not billed**, at least on Hedra, which makes a cautious
  first render genuinely cheap to attempt.

---

## How to add another provider

Every vendor sits behind one of four interfaces. Adding one is a new file, one
line in a registry, and one member on a union type. Nothing above the interface
changes.

| Job | Interface | File |
| --- | --- | --- |
| Language | `LlmProvider` | [`core/llm/types.ts`](../src/core/llm/types.ts) |
| Voice | `TtsProvider` | [`core/speech/types.ts`](../src/core/speech/types.ts) |
| Hearing | `SttProvider` | [`core/speech/stt.ts`](../src/core/speech/stt.ts) |
| Video | `VideoClipProvider` | [`core/avatar/video-provider.ts`](../src/core/avatar/video-provider.ts) |

**A `VideoClipProvider` is the odd one out**, because it is a job rather than a
request and because it spends money. It must implement `submit` / `poll` /
`download` as three separate calls, so a render can outlive the process that
started it; fill in a `ClipCostModel` including `basis` (`'observed'`,
`'published'` or `'unknown'` — do not claim a price you cannot source); and make
`validateKey()` check the *balance* as well as the credential, returning it in
`note` so the settings screen can show it. Register the key under a `video.*`
`SecretName` and add an entry to `VIDEO_PROVIDER_INFO`. The six things that must
be read off the vendor's docs rather than guessed are listed above `notWired()`
in the same file.

**An `LlmProvider` must normalise:** streaming into an `AsyncIterable<string>`
of raw text deltas, with no other shape — no content blocks, no choice arrays,
no `[DONE]` sentinel leaking upward. It must absorb the vendor's system-prompt
convention, honour `signal` so barge-in actually aborts the request, and turn
mid-stream failures into a thrown `LlmError`. That last one matters more than it
looks: two of the three existing providers can return HTTP 200 and then fail
inside the stream, and a provider that swallows it streams a failure as silence.

**A `TtsProvider` must normalise:** audio into mono `Float32Array` in `[-1, 1]`
plus a declared `sampleRate`. Use `s16leToFloat32` or `f32leToFloat32`, and use
`FrameAligner` unless the vendor guarantees whole frames per chunk. It must
declare a `typicalFirstByteMs`, accept and ignore `emotion` if it has no concept
of one, and implement `listVoices()` so settings can populate itself.

**An `SttProvider` must normalise:** one finished utterance — bytes plus a MIME
type from `MediaRecorder` — into `{ text, confidence }`, reporting `confidence:
1` when the vendor does not supply one. It must accept whatever `pickMimeType()`
in [`microphone.ts`](../src/renderer/audio/microphone.ts) negotiated, which is
`audio/webm;codecs=opus` on every current macOS build.

Then, in all three cases:

1. Add the id to the union in [`protocol.ts`](../src/shared/protocol.ts).
2. Add the factory to the `FACTORIES` record in the matching `index.ts`.
3. Add a `SecretName` in [`secrets.ts`](../src/main/secrets.ts).
4. For a voice provider, add a `TTS_PROVIDER_INFO` entry — a label, a key URL,
   and one honest sentence about what it is *for*. That sentence is the whole
   settings screen.

The unit tests in [`speech/types.test.ts`](../src/core/speech/types.test.ts)
cover the sample-format helpers and the frame aligner, which is where a new
adapter is most likely to be subtly wrong. Being wrong there sounds like static,
not like a bug.
