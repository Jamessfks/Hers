# Architecture

## The one constraint everything else follows from

Anna has to answer within about 800 milliseconds of her having your words.

Past roughly a second, a reply stops reading as a person thinking and starts
reading as a machine processing. Every structural decision in this codebase is
downstream of that number, so it is worth showing where it goes:

```
 ~120ms  model time-to-first-token
 ~180ms  enough tokens to make a first clause worth speaking
  ~90ms  Cartesia time-to-first-audio
 ------
 ~390ms  typical, leaving headroom for a bad network
```

That budget is measured **from the transcript being in hand**, which is what the
test asserts. Two things sit in front of it on the voice path and are not
covered by it: ~420ms of silence before the local VAD calls the utterance
finished, and a non-streaming transcription round trip of 300-900ms. Real
end-of-speech to first audio is therefore nearer 1.1-1.7s today; typing to her
hits the 390ms figure. Closing the gap needs streaming transcription with
interim results, described at the top of `core/speech/stt.ts`.

The budget only works because three things overlap rather than queue:

1. **The parser emits a clause before the sentence is finished.** Anna's first
   audio request goes out after roughly twenty tokens, not after the full reply.
2. **Synthesis of clause N+1 starts while clause N is still playing**, capped at
   two ahead so a long reply does not fire a dozen concurrent requests that get
   thrown away the moment she is interrupted.
3. **The body starts moving on the first directive**, not when audio arrives.

Serialise any one of them and the budget is gone. This is enforced by tests in
[`companion.test.ts`](../src/core/orchestrator/companion.test.ts), which assert
the budget, the ordering, and the concurrency cap directly.

## Process boundary

```
┌─ main ──────────────────────────────────────────────────────┐
│                                                             │
│  Secrets ──────── macOS Keychain via safeStorage            │
│  MemoryStore ──── SQLite (node:sqlite, no native addon)     │
│  macOS sensors ── ioreg idle, AppleScript frontmost, ical   │
│                                                             │
│  Companion ─── the turn loop                                │
│    ├── LlmProvider    anthropic │ openai │ google           │
│    ├── TtsProvider    cartesia  │ elevenlabs │ hume         │
│    ├── SttProvider    apple (on-device) │ deepgram │ openai │
│    ├── Memory         turns → facts → ranked recall         │
│    └── Attention      whether she speaks first              │
│                                                             │
└───────────────────────┬─────────────────────────────────────┘
        PerformanceEvent │ PCM          SenseEvent │
┌───────────────────────▼─────────────────────────┴───────────┐
│  renderer — the body                                        │
│                                                             │
│  Body        idle ⊕ gesture ⊕ speech, composited per frame  │
│  SpeechPlayer gapless PCM + amplitude tap for lip sync      │
│  Microphone   local VAD; audio leaves only if you spoke     │
│  Vision       one downscaled frame per 45s, never stored    │
└─────────────────────────────────────────────────────────────┘
```

**Why the line is there.** The renderer decodes media it did not create: a
photograph the user chose, and mp4s that came back from a video vendor. Both go
through Chromium's image and video decoders, which is the largest attack surface
in the app. So it gets no API keys, no filesystem, no `ipcRenderer`, and no
network calls of its own.

The justification changed with the avatar pivot — it used to be "arbitrary glTF
parsed by a large dependency" — but the boundary did not, and should not: the
argument for it is about what the renderer *parses*, and it still parses
untrusted bytes. It receives performance events
and PCM; it sends sense events. Everything in
[`src/shared/protocol.ts`](../src/shared/protocol.ts) is the complete list of
what can cross.

The cost is one IPC hop on transcription. That is the trade, made deliberately:
see the note at the top of [`stt.ts`](../src/core/speech/stt.ts).

## The layers

### `src/core` — provider-agnostic, no Electron, no DOM

Runs under plain `node --test`. This is why the test suite needs no mocking
framework and no headless browser.

| Module | Responsibility |
| --- | --- |
| `persona/anna.ts` | Who Anna is. The product lives here. |
| `persona/performance.ts` | Streaming parser: model tokens → speech + body. |
| `llm/` | Three providers behind one streaming interface. |
| `llm/vision.ts` | One multimodal call: "how does this person look?" |
| `memory/` | Turns, facts, summaries, embeddings, ranked recall. |
| `speech/` | TTS and STT, normalised to Float32 PCM. |
| `senses/attention.ts` | When she speaks first. Mostly rules about *not*. |
| `orchestrator/companion.ts` | The turn loop, barge-in, latency budget. |

### `src/main` — Electron, the OS, and every secret

Window behaviour, Keychain, config, macOS sensors, IPC wiring.

### `src/renderer` — the body

The photograph and the generated clips (`avatar/hologram.ts`), audio playback,
camera and microphone. No 3D, no render loop — a `<video>` decodes itself.

## The three ideas worth knowing

### 1. Inline directives, parsed while streaming

Anna writes her own stage directions:

```
[gaze:user][warm] Hey. [tilt_head] You've been on that same file for three
hours. [lean_in] What's it actually doing to you?
```

`PerformanceParser` is a character-level state machine, not a regex over the
buffer, because tags split across token boundaries (`"[le"` then `"an_in]"`) and
a rescanning parser fires the same gesture twice. Unknown tags are dropped
rather than spoken; a stray `[` in ordinary prose is rescued as text. Both are
tested.

### 2. Every clip begins and ends on the same frame

This is the load-bearing property of the whole avatar, and it replaced a
three-layer animation compositor (`idle ⊕ gesture ⊕ speech`) that only a rig
could have.

A generated clip cannot be blended with another — it has one performance baked
into it. What makes a library of them read as continuous instead is that all
nineteen are anchored to the *same* photograph: each one starts there and is
asked to return there. Any two can then be cut together with no transition at
all — and deliberately none is applied, because dissolving between two frames
that are already identical only softens a cut that was invisible.

`prompts.ts` asks for that property and `seam.ts` measures it. See
[`hologram.ts`](../src/renderer/avatar/hologram.ts) for the playback side, and
the README's *Not done yet* for the fact that the measurement is not yet wired
to the thing that accepts a clip.

### 3. Memory that ranks rather than dumps

Similarity alone retrieves things that are topically close but stale, which is
how a companion ends up asking about a job you left last year. Recall blends
four signals:

```
score = 0.62·similarity + 0.18·recency + 0.12·confidence + 0.08·usage
```

Consolidation runs off the critical path: a background pass distils raw turns
into durable facts and refreshes a rolling summary. It never throws into a
conversation, and a failed pass retries the same window next time.

## Failure behaviour

The rule is that Anna degrades rather than breaks.

| What fails | What happens |
| --- | --- |
| No embedding key | Offline lexical embedder; recall gets worse, not absent |
| Embedding call fails | That recall is unranked; the turn proceeds |
| Consolidation fails | Watermark is not advanced; retried next pass |
| Accessibility denied | She stops knowing what app you are in |
| Camera denied | She stops knowing how you look |
| Model call fails | One human-readable line, and she returns to idle |
| Character fails to load | The stand-in figure, with the reason on screen |

## Testing

323 tests, no network, no mocks of our own code. They concentrate on the places
where being wrong is *silent*:

- **Directive parsing** — a bad parser speaks `[teleports behind you]` out loud.
- **SSE framing** — chunk boundaries fall anywhere; a naive parser drops tokens
  only under load.
- **PCM frame alignment** — a chunk ending on the low byte of a 16-bit sample
  shifts every sample after it, which sounds like static, not like a bug.
- **Memory ranking** — the difference between remembering and reciting.
- **Attention** — that she *stays quiet*, which is most of the job.
- **Turn loop** — latency budget, clause ordering, concurrency cap, barge-in.
