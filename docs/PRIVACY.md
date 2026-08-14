# Privacy

Anna watches a person all day. That only works if what she does with it is
boring, bounded, and checkable, so this document states exactly what she can
see, exactly what leaves the machine, and exactly what is kept. Every claim here
has a file next to it.

There is no Anna backend. Nothing is hosted by us, there is no account, and
there is no telemetry — no analytics, no crash reporting, no update ping. The
complete list of hosts the app ever contacts is the vendors you configured:

```
api.anthropic.com                     api.cartesia.ai          api.deepgram.com
api.openai.com                        api.elevenlabs.io
generativelanguage.googleapis.com     api.hume.ai
```

That list is `grep -rho 'https://[a-z.]*' src/` minus the key-signup links that
open in your browser. If you configure only Anthropic and Cartesia, only those
two are ever contacted.

---

## What leaves the machine

| What | When | Goes to | What is kept afterwards |
| --- | --- | --- | --- |
| Your words, typed or transcribed | Every turn | Your language provider | Stored verbatim in `turns` |
| Anna's reply, one clause at a time | Every turn | Your voice provider | Spoken words stored; directives stripped |
| One recorded utterance, as audio | Only after the local VAD hears speech | Your transcription provider | Nothing. The bytes are not written to disk |
| One 512px JPEG | At most every 15s, 45s by default, camera on only | Your language provider's vision model | Nothing. Only the one-clause description survives |
| Sensor lines as prose | Every turn, inside the system prompt | Your language provider | Nothing beyond the turn |
| Fact sentences | On recall and on consolidation | Your embeddings provider — or nowhere, on the lexical fallback | Vector stored in `facts.embedding` |
| A window of transcript | Every 12 turns | Your language provider | Distilled facts and a rolling summary |

The fifth row is the one people miss, so it is worth stating without softening:
**what Anna can see about your screen leaves the machine as text.** It is not
uploaded as pixels and it is not logged anywhere, but the app name, the window
title, how long you have been idle, the camera's one-clause read of you, and
your next calendar entry are written into the system prompt on every turn, in
the `WHAT YOU CAN SEE` section built by
[`anna.ts`](../src/core/persona/anna.ts). If you would not paste your window
titles into a chat with that vendor, turn `senses.screenActivity` off.

---

## API keys

Keys go into the macOS Keychain through Electron's `safeStorage`, and the design
in [`secrets.ts`](../src/main/secrets.ts) is built around one assumption: the
renderer is the least trustworthy process in the app, because it parses
arbitrary glTF that came off the internet.

- **Keys are never written to `config.json`.** A synced dotfile, a support
  screenshot or a shared settings export cannot leak one.
- **Keys never reach the renderer.** The only thing the renderer can ask for is
  `secrets.status()`, which returns `{ present: boolean, hint: '••••abcd' }` per
  key — a boolean and the last four characters. There is no IPC channel that
  returns a key, so a compromised renderer cannot exfiltrate one it was never
  given.
- **No plaintext fallback.** If `safeStorage.isEncryptionAvailable()` is false,
  `set()` throws and tells the user why, rather than quietly writing the key to
  disk in the clear.
- **The vault file is `0600`**, and holds base64 ciphertext that is useless on
  another machine. A ciphertext that fails to decrypt — restored from a backup,
  or from a reinstalled OS — is dropped and the user is asked for the key again,
  instead of hitting an opaque failure.

Where the boundary is thinner than it looks: `sandbox: false` in
`webPreferences`, because an ESM preload is illegal with the Chromium sandbox
on. A renderer compromise is therefore not contained by the sandbox. What it
still cannot do is read a key, because keys are only ever decrypted in main and
are never sent across the bridge.

---

## The camera

Off by default, and the most constrained sensor in the app. From
[`renderer/senses/vision.ts`](../src/renderer/senses/vision.ts):

- `senses.camera` is `false` in `DEFAULT_CONFIG`. Nothing starts the stream
  until you turn it on.
- Sampling is on a slow timer: `cameraIntervalSeconds` defaults to 45, and
  `MIN_INTERVAL_SECONDS = 15` is a hard floor that clamps any smaller value.
  The question being answered is "how are they doing", which does not change
  frame to frame.
- Each frame is downscaled to **512px wide** and encoded as **JPEG at quality
  0.72**. Enough for a model to say "slumped, rubbing their eyes". Not enough to
  read the screen behind you.
- **The frame is used and dropped.** It is base64'd, sent over IPC, posted to
  the vision model, and released. It is never written to disk in the renderer or
  in main, and it is never stored in the database.
- What survives is one lowercase clause, capped at 120 characters by
  `describePerson()` — "slumped forward, rubbing their eyes". That clause goes
  into the situation, and the situation goes into the prompt.
- The prompt itself is a privacy control. It instructs the model not to describe
  the room, clothes, appearance, or anything on screen, and to answer exactly
  `not in frame` when the frame is empty or too dark. `not in frame` is mapped
  to `null` and no description is recorded at all.
- **The green light stays on** for as long as the camera is enabled. Opening and
  closing the device around each frame would make the indicator blink once a
  minute, which is technically the same access with a less honest signal.
- `look()` in main re-checks `settings.senses.camera` before sending anything,
  so a frame in flight when you switch the camera off is dropped rather than
  uploaded.

---

## The microphone

Off by default, and gated locally. Always-on transcription ships every sound in
your room to a vendor; instead
[`microphone.ts`](../src/renderer/audio/microphone.ts) runs a **local
energy-gate VAD** and audio only leaves the machine when someone actually spoke.

- The gate is an RMS level check with hysteresis: it opens above `0.035` and
  closes below `0.018`. Two thresholds rather than one is what stops it
  flickering through the natural gaps inside a sentence.
- An utterance ends after `HANG_MS = 850` of silence.
- Anything shorter than `MIN_UTTERANCE_MS = 320` is discarded and **never sent**
  — a cough, a keyboard, a chair.
- What leaves is one utterance as a single blob, not a continuous stream. The
  renderer has no transcription key; it hands the bytes to main over IPC and
  main makes the call.
- The barge-in signal is a `user-speech` event with `text: ''` and
  `final: false`. It carries no content — it exists purely to cut Anna off
  mid-sentence.
- Audio is never written to disk, and never stored in the database. Only the
  transcript is recorded as a turn.

---

## The screen

Polled every 20 seconds when `senses.screenActivity` is on, which is the one
sensor that defaults to **true**. From
[`main/senses/macos.ts`](../src/main/senses/macos.ts), it is exactly three
readings:

1. **Frontmost application name** — one `osascript` call into System Events.
2. **Front window title** — from the same call, and often withheld by the app
   itself.
3. **Seconds since the last input** — `HIDIdleTime` out of `ioreg`, which is a
   single integer and needs no permission at all.

There is no keylogging, no accessibility-tree walk, no screenshot, no clipboard
access, no browser-history read, and no per-application usage log. Nothing reads
the *content* of any window.

The window title is not nothing, though: titles routinely contain document
names, ticket numbers and URLs, and the title is passed into the prompt verbatim
whenever it differs from the app name. That is the honest cost of Anna knowing
you have been stuck on the same file for three hours.

---

## The calendar

Off by default. `readNextEvent()` runs an AppleScript query with a **four-hour
horizon**, sorts the results, and returns **only the earliest one** — its
summary text and how many minutes until it starts. Nothing else about the event
crosses: no attendees, no location, no notes, no other events. It is polled
every ten minutes, because the trigger that consumes it fires at twelve minutes
out.

---

## Being seen

Anna is excluded from screen capture by default:

```ts
window.setContentProtection(process.env['ANNA_ALLOW_CAPTURE'] !== '1');
```

She will not appear in a screen share, a Zoom window, a QuickTime recording or a
screenshot. A companion turning up in a shared screen during a work call is a
betrayal, not a feature. Set `ANNA_ALLOW_CAPTURE=1` when you actually want her
in a demo or a recording.

Anna never requests Screen Recording permission herself. She reads no pixels
from your display.

---

## What is stored, and where

Everything lives in one directory, `app.getPath('userData')`, which on macOS is:

```
~/Library/Application Support/Anna/
├── config.json    settings. Never contains a key
├── secrets.json   base64 ciphertext, mode 0600, useless off this machine
├── memory.db      SQLite: turns, facts, summaries
├── memory.db-wal  write-ahead log (journal_mode = WAL)
└── memory.db-shm  shared-memory index for the WAL
```

The database schema is in [`memory/store.ts`](../src/core/memory/store.ts) and
holds four tables:

| Table | Contents |
| --- | --- |
| `turns` | Every line either of you said, verbatim, with a timestamp and session id |
| `facts` | Distilled durable sentences about you, plus confidence, recall count, and an embedding vector |
| `summaries` | The rolling narrative summary, appended on each consolidation |
| `meta` | One row: the consolidation watermark |

No audio, no images, and no raw sensor readings are ever stored. Turns hold
Anna's *spoken* words only — the inline `[lean_in]` directives are stripped by
`spokenText()` before anything reaches the database, which is asserted in
[`companion.test.ts`](../src/core/orchestrator/companion.test.ts).

**Deleting everything.** `MemoryStore.wipe()` truncates all four tables in one
statement, and is covered by a test. It is not yet reachable from the UI,
because there is no settings UI yet — see *Not done yet* in the README. Until
there is, forgetting means quitting Anna and deleting `memory.db` along with its
`-wal` and `-shm` siblings. Deleting `secrets.json` removes every stored key.

---

## macOS permissions

| Permission | What it buys | What happens if you deny it |
| --- | --- | --- |
| **Camera** | One clause about your posture, at most every 15s | `Vision.start()` fails, no `camera-frame` events. Anna loses "how they look" entirely, and the `looks-rough` opener can never fire. Everything else is unaffected |
| **Microphone** | Talking to her out loud | `Microphone.start()` fails, no utterances, no voice barge-in. You can still type into the composer and she answers normally |
| **Automation → System Events** | Frontmost app name and front window title | `readFrontmost()` returns `null`, so `readActivity()` returns `null` and *both* the activity and idle-presence events stop. The `stuck` opener dies, and `WHAT YOU CAN SEE` loses its screen lines. She still answers you |
| **Calendars** | The next event within four hours | `readNextEvent()` returns `null`. The `calendar` opener — the highest-priority one — never fires |
| **Screen Recording** | Nothing. Never requested | n/a |
| **Accessibility** | Nothing directly. `HIDIdleTime` comes from `ioreg`, which needs no permission | n/a |

Every reader fails soft, by construction: each one is wrapped in a `try` that
returns `null` or `0`. A denied permission makes Anna less observant, never
broken, and she never nags you about it.

The usage strings shown in those prompts are declared in `build.mac.extendInfo`
in `package.json`: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
`NSCalendarsUsageDescription`, `NSSpeechRecognitionUsageDescription`. There is
no `NSAppleEventsUsageDescription`, which is the string macOS shows when Anna
asks to control System Events — a known gap in the packaged build rather than a
behaviour of the sensor.

---

## Turning things off

Everything above is a flag in `~/Library/Application Support/Anna/config.json`:

```json
{
  "senses": {
    "camera": false,
    "microphone": false,
    "screenActivity": true,
    "calendar": false,
    "cameraIntervalSeconds": 45
  },
  "presence": {
    "proactive": true,
    "minMinutesBetweenOpeners": 25,
    "quietHours": [1, 8]
  }
}
```

Those are the shipped defaults, from
[`config.ts`](../src/main/config.ts). Three of the four sensors are off until
you turn them on. `proactive: false` stops Anna speaking first at all, and she
becomes something you talk to rather than something that talks to you.
