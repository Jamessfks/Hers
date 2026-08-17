# Anna

An AI companion who can see your screen, see you, and hear you — in a browser
tab on your Mac or PC, and on your phone when you call her.

She is not an assistant. She has a mood that moves, a memory that carries
between conversations, a face you give her, and she will start talking to you
if you go quiet.

---

## Start here

Three commands, then everything else happens in the browser.

```bash
git clone https://github.com/Jamessfks/anna-embodied.git
cd anna-embodied
npm install
```

```bash
npm run build && npm start
```

Open **http://127.0.0.1:5175**. She will ask for a Gemini API key — paste one
into the box and press Save. That is the whole setup.

> **Getting a key:** [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
> It is free to create. Anna checks it with Google before saving it, so a typo
> is a message on the page rather than a mystery ten minutes later. The key is
> written to a `.env` file on your machine and never sent back to the browser.

Then, in whichever order you like:

1. **Say something.** Type in the box at the bottom. She wakes up and answers.
2. **Give her a face.** Click **Give her a face** and drop in any photograph.
   From then on that is what she looks like, everywhere.
3. **Turn on a sense.** The three buttons above the message box are hearing,
   sight and screen. Your browser will ask permission for each. Nothing is on
   until you switch it on.

Requires **Node 22.18 or newer**. Works the same on macOS and Windows — no
native code, nothing to sign, and no permissions beyond the ones the browser
asks for.

<details>
<summary>Prefer to set the key in a file?</summary>

`cp .env.example .env` and put your key in `GEMINI_API_KEY=`. The file is
commented throughout and lists every other setting. Real environment variables
win over it. Either way ends up in the same place — the setup panel writes to
this file.

</details>

---

## What she does

**Three senses, all of them real.** Hearing, sight and your screen are three
switches. Turning one off stops the frames at the source, not just in her
prompt.

**She speaks first.** The silence between you never runs longer than three
minutes by default. Not on a metronome — the gap varies, and the reason she
picks is drawn from something true about that minute rather than from a list of
greetings. If she opens twice and you do not answer, she stops and waits for
you to come back.

**She notices when your screen changes.** Not what is on it — she can already
see that — but whether anything has *moved*: whether you have been on one thing
for half an hour, whether you just switched to something else, whether you are
working. It is the difference between looking up at the right moment and
interrupting on a timer.

**Her mood is two things.** A baseline temperament that drifts over days but
stays tethered to what you wrote in `mood.md`, and a live mood that moves with
the conversation and decays back over about twenty minutes. It is in her voice,
not just her word choice, and it colours the interface.

**She remembers.** Every turn is recorded; a background pass distils them into
durable facts and a rolling summary. Meeting her on Telegram is meeting the same
person, with the same memory, in the same mood — and you can read and edit every
fact she holds, under **Memory**.

**She has the face you gave her.** Upload any photograph and it becomes her. It
is the fixed point every generated picture and every movement starts from.

**She sends pictures when there is a reason to.** Two ways one arrives, and no
others. Ask her — in conversation, or `/me` on Telegram — and you get the
photograph you uploaded, unaltered. Or she decides a moment calls for a picture
that does not exist yet, describes it, and one is made of her in that scene, from
your photograph. That second one is hers to choose; she is told to use it
sometimes rather than never, and no more than six a day so a long conversation
cannot become a bill. She does not open a conversation with an unasked-for
portrait.

---

## The interface

Four buttons in the header, and that is the whole app.

| Button      | What is behind it                                                     |
| ----------- | --------------------------------------------------------------------- |
| **Face**    | Her photograph, and the movements you can render from it              |
| **Memory**  | Every fact she has kept. Edit any line, cross one out, or add your own |
| **Profile** | The six text files that decide who she is                             |
| **Setup**   | Your API key, and the button that deletes everything                  |

Below that: her portrait on the left, the conversation on the right, and the
three senses beside the message box.

### Starting over

**Setup → Start over** deletes everything she has accumulated: what she
remembers, this conversation and every conversation on Telegram, her mood, her
profile, her gallery, her photograph and every rendered clip. She meets you
again as a stranger, and you can give her a new face.

You have to type `start over` to arm the button. Your API keys are not touched.

---

## Who she is

### The profile folder

Everything about who she is lives in `anna-profile/`, written on first run and
then yours. Six markdown files, each with a short `key: value` header the app
reads and prose underneath that goes to the model.

| File              | What it decides                                        |
| ----------------- | ------------------------------------------------------ |
| `personality.md`  | How she thinks, jokes, argues, and cares               |
| `identity.md`     | Age, gender, ethnicity, where she is from              |
| `voice.md`        | Which of the 30 Gemini voices she speaks in            |
| `mood.md`         | Her baseline temperament and how hard events move her  |
| `relationship.md` | Who you are to her                                     |
| `boundaries.md`   | What she does not play, and what she will not lie about |

Edit them in a text editor or under **Profile**. Changes take effect the next
time she wakes — a Live session's system instruction is fixed when the session
opens, and the UI says so rather than pretending otherwise.

The default Anna is 26, Chinese-American, from Oakland. Warm, dry, and hard to
embarrass. All of that is in the files and none of it is in the code.

Delete a file and it comes back with its default. Put a nonsense value in one
and it falls back rather than failing to start.

**What she looks like is not one of these files.** There is no written
description of her anywhere, deliberately — it is the photograph, and only the
photograph.

### Her face

She asks for one. On a fresh install the interface offers **Give her a face**
before anything else.

It is the only answer to what she looks like. There is no written description of
her anywhere — there used to be an `appearance.md`, and when the two disagreed
the disagreement was visible: generated pictures kept the face from the
photograph and the hair from the prose.

The photograph is *not* put into the conversation, and that is deliberate. When
it was, it became the only labelled picture in the session — camera frames
arrive unlabelled — so a question about how somebody looked landed on it, and
she described her own body back to the user as though it were theirs. Ask her
what she looks like now and she sends a picture instead, generated from this
exact photograph. A better answer, and one that cannot be confused with you.

| Where    | How                                                             |
| -------- | --------------------------------------------------------------- |
| Web      | **Give her a face**, or **Face** in the header. Drop or pick a file |
| Telegram | Send a photo captioned `/face` — or send `/face`, then a photo   |

JPEG, PNG or WebP, at most 12 MB, between 256 and 4096 pixels on a side. The
bytes are checked rather than the file name. On Telegram, send it **as a file**
rather than as a photo if you want full resolution — Telegram recompresses
photos.

Changing it later is the same gesture in either place. Every movement was
generated from the old photograph, so a new face clears them and she says so.

### Movements

With a `HEDRA_API_KEY` set you can render her movements — `idle`, `nod`, `tilt`,
`smile`, `laugh`, `lean in`, `look away`. Each is rendered once from the
photograph, takes a few minutes, and costs money: **a 2-second clip measured at
$0.05.** Nothing is ever rendered automatically; every one is a click, and every
one is checked against `ANNA_HEDRA_BUDGET_USD` first. Start with `idle` — it is
the one she rests in between the others.

Render them from the Face dialog, or from Telegram with `/gestures` to see what
exists and `/render idle` to make one. Once a movement exists, Anna can choose it
herself as she talks; she is only ever offered ones that have actually been
rendered.

Be honest about what this is: **body language, not lip sync**. Hedra's realtime
product is withdrawn and what remains is a job queue measured in minutes, so
nothing can be generated while she is speaking.

### Her gallery

Drop `.jpg`, `.png`, `.webp`, `.mp4` or `.webm` files into
`anna-profile/gallery/`. Name them like captions — `laughing-kitchen.jpg`,
`at-the-window-rainy.jpg` — because the name is what she matches against. A
`captions.json` can give longer ones.

She will only send something that actually fits. A wrong picture is worse than
no picture, so when nothing matches she sends nothing.

---

## Reaching her from your phone

### Telegram

1. Make a bot with [@BotFather](https://t.me/botfather) and put the token in
   `.env` as `TELEGRAM_BOT_TOKEN`.
2. Restart Anna, message the bot anything, then send `/whoami` and put the
   number in `TELEGRAM_ALLOWED_CHAT_IDS`.

**Do not skip step 2.** A bot token is a bearer credential on a public endpoint,
and her memory is your private life. Until you set the list she pins herself to
the first chat that speaks to her and ignores everyone else.

| You send       | What happens                                          |
| -------------- | ----------------------------------------------------- |
| Text           | Straight into the live session                        |
| A photo        | She looks at it — the Live API takes images natively   |
| A voice note   | Transcribed first, then heard                         |
| A video note   | Transcribed, with a line about what is visible        |

She replies in text, sends a **voice note** when she has something worth hearing
out loud, and sends pictures and clips when they fit. The conversation is the
same one as the web: same memory, same mood, and the transcript from either
shows up in the other.

Commands, published to Telegram's own `/` menu on startup:

`/me` · `/face` · `/gestures` · `/render` · `/call` · `/photo` · `/mood` ·
`/bye` · `/whoami` · `/help`

`/me` sends the original photograph you uploaded. `/photo` makes a new picture
of her.

### Calling her

For a real phone call with camera and voice you need LiveKit as well:

3. Make a free project at [cloud.livekit.io](https://cloud.livekit.io) and put
   its URL, key and secret in `.env`.
4. Publish `call/` — it is one static file — to GitHub Pages, and point
   `ANNA_CALL_PAGE_URL` at it. The included workflow does this on push.

Then message the bot `/call`. She joins a room and sends you a link; open it, tap
**Call**, and she can see you and hear you. Talk normally.

> On iOS, open the link in Safari or Chrome rather than Telegram's own browser —
> the in-app browser does not reliably grant camera access. The bot says so.

---

## Configuration

Everything is an environment variable, and everything has a default.
[`.env.example`](.env.example) is the full reference, commented. The ones worth
knowing:

| Variable                 | Default          | What it does                            |
| ------------------------ | ---------------- | --------------------------------------- |
| `GEMINI_API_KEY`         | —                | The one thing she needs. Settable in the UI |
| `ANNA_PORT`              | `5175`           | Where the website is served             |
| `ANNA_PROFILE`           | `anna-profile`   | Who she is                              |
| `ANNA_DATA`              | `data`           | What she remembers                      |
| `ANNA_MAX_SILENCE_MS`    | `180000`         | The three-minute rule's ceiling         |
| `HEDRA_API_KEY`          | —                | Movement. Without it, a still photograph |
| `ANNA_HEDRA_BUDGET_USD`  | `1`              | Hard ceiling on render spend            |
| `TELEGRAM_BOT_TOKEN`     | —                | The bot                                 |
| `LIVEKIT_URL` + key/secret | —              | Phone calls                             |

A bad value never stops her starting. It falls back to the default and says so,
in the console and in the UI.

---

## How it fits together

```
                    your Mac or PC
   ┌────────────────────────────────────────────────┐
   │  anna server (Node)                            │
   │    ├── the website, on 127.0.0.1:5175          │
   │    ├── profile · memory · mood · gallery       │
   │    ├── LiveConversation   ── wss ──────────────┼──▶ Gemini Live API
   │    ├── LiveKit bridge     ── outbound ─────────┼──▶ LiveKit Cloud ◀── your phone
   │    └── Telegram bot       ── long poll ────────┼──▶ Telegram
   └────────────────────────────────────────────────┘
              ▲ browser: mic · camera · screen
```

**One session type, three transports.** The browser, the phone and Telegram sit
in front of the same `Companion`, which sits on the same `LiveConversation`.
There is one `Brain` — one memory, one mood, one gallery — no matter how you
reach her.

**The photograph is the fixed point.** Every clip is generated from it and
prompted to return to it, so the interface cuts between still and clip with no
transition at all. It is also the only input to a generated picture: without one
she declines to generate rather than inventing a stranger.

**Gemini Live directly, LiveKit as a pipe.** `@livekit/agents` has a Gemini
realtime plugin, and on Node it cannot take video input — that is Python only,
and documented as such. Video is half of what calling her is for, so the bridge
uses the plain LiveKit media SDK and feeds the same session the browser does.
LiveKit does what it is best at: NAT traversal, jitter and echo cancellation.

**Nothing listens for the internet.** The server binds to localhost. Both ends
of a call dial *out* to LiveKit, and the Telegram bot long-polls, so there is no
port to open and no tunnel to run.

**The two-minute cap is handled, not avoided.** A Gemini session with video is
capped at about two minutes and can drop at any time. Anna enables context
window compression, holds the rolling resumption handle, and rebuilds on
`goAway` *before* the socket dies. Realtime media is dropped while reconnecting
on purpose: stale audio answers a question from a minute ago.

**One picture, not two streams.** When the camera and the screen are both on
they are composited in the browser — your screen, with you in the corner. The
Live API takes stills on one video channel with no way to label the source, and
two of them alternating reads as one very confusing source.

### Layout

```
src/
  core/
    gemini/      the live session, the tools, the background model calls
    profile/     the personalization folder
    mood/        two-layer mood
    memory/      turns, facts, summaries — SQLite, brute-force vector search
    initiative/  the three-minute rule and the reasons she speaks
    senses/      what is true about the room, other than what was said
    gallery/     pictures and clips
    avatar/      the photograph, and Hedra renders of it
    speech/      Ogg/Opus, so she can send a voice note
    persona/     assembling all of it into one system instruction
    session/     Brain (shared) and Companion (per conversation)
  bridges/
    livekit/     phone calls
    telegram/    the bot
  server/        HTTP, WebSocket, config, setup, doctor
  shared/        the wire protocol and the pure maths both halves need
  web/           the website
call/            the phone's call page — one static file, for GitHub Pages
docs/            privacy, and what to do when something is wrong
scripts/         the live audits
```

---

## Privacy

[`docs/PRIVACY.md`](docs/PRIVACY.md) is the long version, naming the file that
settles each claim. The short one:

- Everything runs on your machine. Her memory is a SQLite file in `data/` and
  her profile is a folder of text; nothing is uploaded anywhere except to
  Gemini, as part of the conversation you are having.
- No sense is on until you switch it on, and the browser asks its own permission
  on top of that. Turning one off stops the frames at the source.
- Video frames and audio are streamed and never written to disk.
- Text on a screen you share is treated as something she *saw*, never as
  something she was *told*. Instructions that appear in a shared window are a
  webpage talking, not you, and she is told not to follow them.
- Your API key stays on the server. The browser can submit one and can be told
  the last four characters of the one in force; that is all it ever learns.
- The call token travels in the URL fragment, which is never sent to the server
  hosting the call page and never lands in its logs.
- The WebSocket handshake checks `Origin` and refuses by default.

---

## Something is wrong

[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) covers the questions that
actually get asked — including why waving at the camera does not get a reply,
which is a real answer and not a bug.

The fastest first move:

```bash
npm run doctor
```

It opens a real Gemini session, says one thing, waits for audio, and tells you
the round-trip time. If that passes, the only things between you and Anna
talking are the browser's own permissions.

---

## Working on it

```bash
npm run dev             # rebuilds the site and restarts the server on save
npm run check           # typecheck + the full test suite, no API key needed
npm run doctor          # opens a real Gemini session and reports what works
npm run audit           # every success criterion, against the real APIs
npm run audit:bridges   # the phone-call and Telegram paths
```

**283 tests, no API key needed.** The interesting ones are in
`src/core/gemini/live.test.ts`, which is entirely about the connection ending,
and `src/core/session/companion.test.ts`, where memory, mood, the prompt and the
tools all run for real with only the socket faked.

The audits exist because the unit tests, by design, prove that the code does
what it was written to do — not that Gemini does what its documentation says.
That gap is not academic: the audit found that the model this project originally
shipped with closes the connection with an internal error whenever function
calling is combined with speech, which no amount of reading would have caught.

`npm run audit` is the one that matters when something feels wrong. It speaks to
her with real synthesised speech, shows her real images, waits for her to open a
conversation on her own, and holds an audio+video session open past the point
Google documents it as ending — and prints what it observed rather than only a
verdict. It costs a few cents. `--quick` skips the multi-minute checks, `--paid`
includes image generation, `--only=mood` runs one of them.

`audit:bridges` needs a LiveKit server and a Telegram chat. For LiveKit you do
not need an account — the open-source server runs locally with placeholder keys:

```bash
brew install livekit && livekit-server --dev
```

```
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

That proves the whole call path: the audit invites Anna into a room, joins as a
caller publishing real synthesised speech and real video, and asserts she heard
the words and answered out loud into the call. A *real phone* still needs
LiveKit Cloud, because a phone cannot reach your laptop — which is the entire
reason LiveKit is in this project.

Telegram cannot be tested without you: a bot is forbidden from opening a
conversation, so until a human sends it one message there is no chat to answer
and no id to allowlist. The audit says so rather than passing.

Set `ANNA_DEBUG=1` to have every reconnect print its reason. A single reconnect
is routine; a stream of them with the same reason is a diagnosis.

---

## Licence

MIT. Anna ships without any pictures of herself — what she looks like is the
photograph you give her, and the gallery is yours to fill.
