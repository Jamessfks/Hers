# Anna

An AI companion who can see your screen, see you, and hear you — in a browser
tab on your Mac or PC, and on your phone when you call her.

She is not an assistant. She has a mood that moves, a memory that carries
between conversations, and she will start talking to you if you go quiet.

```bash
git clone https://github.com/Jamessfks/anna-embodied.git
cd anna-embodied
npm install
cp .env.example .env      # put a Gemini key in it
npm run build && npm start
```

Then open http://127.0.0.1:5175.

Requires Node 22.18 or newer. Works the same on macOS and Windows — there is no
native code, nothing to sign, and no permissions beyond the ones the browser
asks for.

---

## What she does

**Three senses, all of them real.** Her hearing, her sight and her view of your
screen are three switches in the UI. Nothing is on until you turn it on, and
turning one off takes effect immediately.

**She speaks first.** By default the silence between you never runs longer than
three minutes. Not on a metronome — the gap varies, and the reason she picks is
drawn from something true about that minute rather than from a list of
greetings. If she opens twice and you do not answer, she backs off.

**Her mood is two things.** A baseline temperament that drifts over days but
stays tethered to what you wrote in `mood.md`, and a live mood that moves with
the conversation and decays back over about twenty minutes. It is in her voice,
not just her word choice, and it colours the interface.

**She remembers.** Every turn is recorded; a background pass distils them into
durable facts and a rolling summary. Meeting her again on the phone is meeting
the same person, with the same memory, in the same mood.

**She has your face for her.** Upload any photograph and it becomes her. It is
the fixed point every movement is generated from, so she can nod, tilt her head
or laugh and cut straight back to the still without a jump.

**She can send you pictures.** Anything in `anna-profile/gallery/` is hers to
send when it fits the conversation, and she can make new ones.

---

## Setting her up

### The profile folder

Everything about who she is lives in `anna-profile/`, which is written on first
run and is then yours. Seven markdown files, each with a short `key: value`
header the app reads and prose underneath that goes to the model.

| File              | What it decides                                             |
| ----------------- | ----------------------------------------------------------- |
| `personality.md`  | How she thinks, jokes, argues, and cares                     |
| `identity.md`     | Age, gender, ethnicity, where she is from                    |
| `appearance.md`   | Height, hairstyle, hair and eye colour, body type, how she dresses |
| `voice.md`        | Which of the 30 Gemini voices she speaks in                  |
| `mood.md`         | Her baseline temperament and how hard events move her        |
| `relationship.md` | Who you are to her                                           |
| `boundaries.md`   | What she does not play, and what she will not lie about      |

Edit them in a text editor, or in the app under **Profile**. Changes take effect
the next time she wakes — a Live session's system instruction is fixed when the
session opens, and the UI says so rather than pretending otherwise.

The default Anna is 26, Chinese-American, from Oakland; 5'6" and slim with a
blunt chin-length black bob, dark brown eyes and a small scar through her left
eyebrow. Warm, dry, and hard to embarrass. All of that is in the files and none
of it is in the code.

Delete a file and it comes back with its default. Put a nonsense value in one
and it falls back rather than failing to start.

### Her face

Click **Face**, drop in a photograph, and that is her. JPEG, PNG or WebP, at
most 12 MB, between 256 and 4096 pixels on a side. The bytes are checked rather
than the file name.

With a `HEDRA_API_KEY` set you can then render her movements — `idle`, `nod`,
`tilt`, `smile`, `laugh`, `lean in`, `look away`. Each is rendered once from the
photograph, takes a few minutes, and costs money: **a 2-second clip measured at
$0.05.** Nothing is ever rendered automatically; every one is a click, and every
one is checked against `ANNA_HEDRA_BUDGET_USD` first. Start with `idle` — it is
the one she rests in between the others.

Once a movement exists, Anna can choose it herself as she talks. She is only
ever offered the ones that have actually been rendered, so she cannot reach for
a gesture that would move nothing.

Be honest with yourself about what this is: it is **body language, not lip
sync**. Hedra's realtime product is withdrawn and what remains is a job queue
measured in minutes, so nothing can be generated while she is speaking. Swapping
the photograph invalidates every clip, because they all start from the old one.

### Her gallery

Drop `.jpg`, `.png`, `.webp`, `.mp4` or `.webm` files into
`anna-profile/gallery/`. Name them like captions — `laughing-kitchen.jpg`,
`at-the-window-rainy.jpg` — because the name is what she matches against when
deciding whether one fits. A `captions.json` can give longer ones.

She will only send something that actually fits. A wrong picture is worse than
no picture, so when nothing matches she sends nothing.

---

## Calling her from your phone

Two commands and it works from anywhere:

1. Make a bot with [@BotFather](https://t.me/botfather) and put the token in
   `.env` as `TELEGRAM_BOT_TOKEN`.
2. Make a free project at [cloud.livekit.io](https://cloud.livekit.io) and put
   its URL, key and secret in `.env`.
3. Publish `call/` — it is one static file — to GitHub Pages, and point
   `ANNA_CALL_PAGE_URL` at it.

Then message the bot `/call`. She joins a room and sends you a link; open it,
tap **Call**, and she can see you and hear you. Talk normally.

> On iOS, open the link in Safari or Chrome rather than Telegram's own browser —
> the in-app browser does not reliably grant camera access. The bot says so in
> the message.

Message her `/whoami`, then put the number in `TELEGRAM_ALLOWED_CHAT_IDS`. Until
you do, she pins herself to the first chat that speaks to her and ignores
everyone else. **Do not skip this.** A bot token is a bearer credential on a
public endpoint, and her memory is your private life.

### In the chat itself

| You send            | What happens                                              |
| ------------------- | --------------------------------------------------------- |
| Text                | Straight into the live session                             |
| A photo             | She looks at it — the Live API takes images natively       |
| A voice note        | Transcribed first, then heard                              |
| A video note        | Transcribed, with a line about what is visible             |

She replies in text there, and sends pictures and clips when they fit. Voice
belongs on the call: `sendVoice` requires Ogg/Opus, and shipping an audio
encoder to solve a problem `/call` already solves better was not worth it.

Commands: `/call`, `/photo`, `/mood`, `/bye`, `/whoami`, `/help`.

---

## Architecture

```
                    your Mac or PC
   ┌────────────────────────────────────────────────┐
   │  anna server (Node)                            │
   │    ├── the website, on 127.0.0.1:5175          │
   │    ├── profile · memory · mood · gallery       │
   │    ├── GeminiLiveSession  ── wss ──────────────┼──▶ Gemini Live API
   │    ├── LiveKit bridge     ── outbound ─────────┼──▶ LiveKit Cloud ◀── your phone
   │    └── Telegram bot       ── long poll ────────┼──▶ Telegram
   └────────────────────────────────────────────────┘
              ▲ browser: mic · camera · screen
```

**The photograph is the fixed point.** Every clip is generated from it and
prompted to return to it, so the interface cuts between still and clip with no
transition at all — a crossfade would be blurring two identical frames. It is
also why the aspect ratio is taken from the image rather than pinned: a frame
that is not the photograph's own makes the first frame a crop of it.

**One live session type, two transports.** The browser and the phone sit in
front of the same `Companion`, which sits on the same `LiveConversation`. There
is one memory and one mood no matter how you reach her.

**Gemini Live directly, LiveKit as a pipe.** `@livekit/agents` has a Gemini
realtime plugin, and on Node it cannot take video input — that is Python only,
and documented as such. Video is half of what calling her is for, so the bridge
uses the plain LiveKit media SDK and feeds the same session the browser does.
LiveKit is doing the thing it is best at: NAT traversal, jitter and echo
cancellation for a phone on cellular.

**Nothing listens for the internet.** The server binds to localhost. Both ends
of a call dial *out* to LiveKit, and the Telegram bot long-polls, so there is no
port to open and no tunnel to run.

**The two-minute cap is handled, not avoided.** A Gemini session with video is
capped at about two minutes and drops at any time regardless. Anna enables
context window compression, holds the rolling resumption handle, and rebuilds on
`goAway` *before* the socket dies rather than after. Realtime media is dropped
while reconnecting on purpose: stale audio is worse than none, because it
answers a question from a minute ago.

**One picture, not two streams.** When the camera and the screen are both on
they are composited in the browser — your screen, with you in the corner of it.
The Live API takes stills on one video channel with no way to label the source,
and two of them alternating reads as one very confusing source.

---

## Privacy

`docs/PRIVACY.md` is the long version, naming the file that settles each claim.
The short one:

- Everything runs on your machine. Her memory is a SQLite file in `data/` and
  her profile is a folder of text; nothing is uploaded anywhere except to
  Gemini, as part of the conversation you are having.
- No sense is on until you switch it on, and the browser asks its own permission
  on top of that. Turning one off stops the frames at the source.
- Video frames and audio are streamed and never written to disk.
- Text on a screen you share is treated as something she *saw*, never as
  something she was *told*. Instructions that appear in a shared window are a
  webpage talking, not you, and she is told not to follow them.
- The call token travels in the URL fragment, which is never sent to the server
  hosting the call page and never lands in its logs.
- The WebSocket handshake checks `Origin` and refuses by default. WebSockets are
  exempt from the same-origin policy, so without that check any page in any
  browser on your machine could open a socket to her.

---

## Working on it

```bash
npm run dev        # rebuilds the site and restarts the server on save
npm run check      # typecheck + the full test suite
npm run doctor     # opens a real Gemini session and reports what works
```

`npm run doctor` is the one thing the tests cannot do. Every test here fakes the
network deliberately — a reconnect is not reproducible against a real socket,
and a suite that needs an API key is a suite nobody runs — so `doctor` covers the
gap: it opens a real Live session, says one thing, waits for audio, and tells you
the round-trip time.

129 tests, no API key needed. The interesting ones are in
`src/core/gemini/live.test.ts`, which is entirely about the connection ending,
and `src/core/session/companion.test.ts`, where memory, mood, the prompt and the
tools all run for real with only the socket faked.

### Layout

```
src/
  core/
    gemini/      the live session, the tools, the background calls
    profile/     the personalization folder
    mood/        two-layer mood
    memory/      turns, facts, summaries — SQLite, brute-force vector search
    initiative/  the three-minute rule
    gallery/     pictures and clips
    persona/     assembling all of it into one system instruction
    session/     Brain (shared) and Companion (per conversation)
  bridges/
    livekit/     phone calls
    telegram/    the bot
  server/        HTTP, WebSocket, config, doctor
  web/           the website
call/            the phone's call page — one static file, for GitHub Pages
```

---

## Licence

MIT. Anna ships without any pictures of herself: what she looks like is in
`appearance.md`, and the gallery is yours to fill.
