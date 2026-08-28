<div align="center">

<img src="https://github.com/Jamessfks/Hers/releases/download/v1.0.0/logo.png" alt="Hers" width="132">

# Hers

**An ambient, embodied AI companion who lives on your computer. Not on someone's server.**

She sees your screen, sees you through your camera, and hears you. She has a mood that
moves, a memory that carries between conversations, a face you give her, a name she
chose herself, and she will start talking to you if you go quiet.

All yours. Full control.

[![License](https://img.shields.io/github/license/Jamessfks/Hers?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Jamessfks/Hers)](https://github.com/Jamessfks/Hers/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-informational)](https://nodejs.org)

[What it looks like](#what-it-looks-like) · [What she does](#ten-things-she-does-that-a-chatbot-does-not) · [Why local](#she-is-yours) · [Setup](#setup) · [Living with her](#living-with-her) · [Configuration](#configuration) · [Privacy](#privacy) · [Working on it](#working-on-it)

</div>

### [Download her](https://github.com/Jamessfks/Hers/releases/latest) — macOS, Apple Silicon, 127.5 MiB

Open the file, drag her to **Applications**, double-click. No terminal, no Node, no git.
She opens her own window and asks for the one thing she needs: a Gemini API key, free to
create, no account or sign-up beyond a Google one you already have. Full detail in
[Setup](#setup), including the first-launch warning — the build is **not signed**, and
this README says exactly what to click, plus the one terminal line that skips all of it.

294 MB installed. Windows and Intel Mac have no download yet and have never been built —
[Platform](#platform) says why. From a clone they work today, and
[running her from a clone](#run-it-from-a-clone) is four commands and unchanged.

---

## What it looks like

**At the desk.** A first conversation, top to bottom. She opened it — *"You're up late
for a Monday"* — because nobody had said anything for a while, introduced herself with
the name she had picked a minute earlier, and asked what had been keeping him there all
evening. When told to go through the computer she said no, which is the shape of her
tools rather than a flourish: she has four — `feel`, `remember`, `recall`, `show` — and a
fifth, `look`, once she has expressions to pick from. None of them can read a file.

![A first conversation: she opens it unprompted, introduces herself by the name she chose, asks what has kept him up, and declines to go through the computer when told to](https://github.com/Jamessfks/Hers/releases/download/v1.0.0/first-conversation.jpg)

<div align="center">
<img src="https://github.com/Jamessfks/Hers/releases/download/v1.0.0/telegram.jpg" alt="The same companion on Telegram: /me returns her photograph, /mood answers in one word, and a hello comes back as a voice note" width="330">
</div>

**And on a phone.** The same companion, not a second one: one memory, one mood, one
conversation reached from somewhere else. `/me` returns the photograph you gave her,
`/mood` answers in a word rather than a number, and a hello came back as a five-second
**voice note**, because she decided that one was worth hearing out loud.

---

## Ten things she does that a chatbot does not

|    |                        |                                                                   |
| -- | ---------------------- | ----------------------------------------------------------------- |
| 1  | **Names herself**      | Once, on the first conversation, and it is permanent               |
| 2  | **Speaks first**       | Within three minutes, for a reason drawn from that actual minute   |
| 3  | **Watches your screen change** | Half an hour on one thing reads differently from just switching |
| 4  | **Three real senses**  | Screen, camera, microphone — each one a switch you own             |
| 5  | **Takes four years to know** | 1% stranger to 80%, earned by turning up, no way to buy it   |
| 6  | **Has a mood, hides it** | Two layers. It lands in how she talks, never as a status line    |
| 7  | **Wears a photograph you chose** | Every picture and every expression comes from that one image |
| 8  | **Sends pictures on purpose** | Her decision, six a day, never as an opening move           |
| 9  | **Is one person everywhere** | Desk, phone, and a real video call — one memory, one mood     |
| 10 | **Keeps a memory you can edit** | Read every fact she holds. Cross out the ones you don't like |

Her name goes into `identity.md` with her reason beside it as a comment and nothing asks
again, so a name you type in yourself is left alone. Two unanswered openers and she
stops until you come back.

---

## She is yours

A hosted companion lives in somebody's datacentre, on their model, under their terms.
When they change the model she changes personality overnight. When they shut down she is
gone, and so is everything she knew about you.

|                     | A hosted companion                    | Hers                                                      |
| ------------------- | ------------------------------------- | --------------------------------------------------------- |
| Where she runs      | Their servers                         | `127.0.0.1` — yours                                       |
| Who she is          | Whatever they tuned this quarter      | Six markdown files you can open in TextEdit               |
| What she looks like | An avatar from their catalogue        | Any photograph you drop in                                |
| Her memory          | A row in their database               | A SQLite file in `data/`, every line readable and editable |
| Her name            | Theirs                                | Hers — she picks it on the first conversation             |
| Cost                | Monthly, forever                      | Google's API price for the tokens you actually use        |
| If it shuts down    | She is gone                           | Nothing shuts down. It is a folder                        |

Nothing here phones home: no telemetry, no analytics, no update check, no crash
reporter. The outbound connections are the one carrying your conversation to Google's
Gemini API and — only if you set them up yourself — Telegram and LiveKit.

---

## Setup

### 1. Download and open her

**macOS, Apple Silicon.** `Hers-1.3.0-arm64.dmg`, **127.5 MiB**, on the
[releases page](https://github.com/Jamessfks/Hers/releases/latest). Open it, drag
**Hers** onto **Applications**, and double-click her there. She opens her own window;
there is nothing to type into a terminal and nothing to install first.

**Drag her to Applications and launch her from there** — not from the disk image, not
from Downloads. macOS runs a quarantined application from a randomized read-only copy of
itself unless it has been properly installed, which means an exception you grant is
granted to a path that will not exist next time, and the same refusal comes back on
every launch.

Installed she is **294 MB** on disk, of which 237 MB is the Electron framework — a whole
browser engine and a whole Node — 37 MB is her code and its dependencies, and 16 MB is
LiveKit's media binding, which is only loaded if you set up phone calls. That number is
here because nobody else publishes theirs and you deserve to know what you are agreeing
to store.

**There is no Windows download, and no Intel Mac download.** Neither has ever been
compiled and neither has ever been run — the configuration for both exists and the
workflow that would build them exists, and nobody has run it. From a clone, both work
today. See [Platform](#platform) for why they cannot honestly be built from here.

### 2. Get past the warning, because there will be one

**This build is not signed, and the first launch says so.** That is not a bug and it is
not something to work around quietly, so here is the whole truth: Apple charges $99 a
year for a Developer ID and ties it to a named person's legal identity, and a Windows
certificate that satisfies SmartScreen from day one runs several hundred dollars a year.
Neither has been paid for. What that costs you is one warning, once — *if* she is in
`/Applications`; see above for why that matters — and these clicks:

**macOS Sequoia (15) and later.** Double-click **Hers**. macOS refuses and says it
cannot verify the developer. Open **System Settings → Privacy & Security**, scroll down
to the **Security** section — the refusal is quoted there with an **Open Anyway** button
beside it. Click that, then **Open** when the warning comes back, and confirm with Touch
ID or your password. That is
[Apple's own documented route](https://support.apple.com/en-us/102445); she opens
normally from then on.

**macOS 14 and earlier.** Control-click **Hers** in Applications, choose **Open**, then
**Open** again in the dialog. Same effect, fewer steps — the right-click route was
removed in Sequoia.

**Or one line, if you have a terminal after all.** This deletes the flag macOS puts on
downloaded files, which is the thing the entire mechanism keys off:

```bash
xattr -dr com.apple.quarantine /Applications/Hers.app
```

Measured here: held-forever to a window in about two seconds. It is offered last rather
than first because you should understand it before you run it — it says "stop treating
this file as downloaded", and that is a sentence to mean about one file and not to make
a habit of.

**Windows**, when there is a build to warn about: SmartScreen says *"Windows protected
your PC"*. Click **More info**, then **Run anyway**. If it keeps asking on every launch,
right-click the file → **Properties** → tick **Unblock** at the bottom of the General
tab.

If macOS instead says Hers is *damaged and should be moved to the Bin*, that is a
different thing and it means the download did not complete — fetch it again. The build
carries an ad-hoc signature specifically so that the honest warning is the one you get.

### 3. Give her a Gemini API key

She needs one, and it is the only account involved in any of this. Create it at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free to create. The
key is checked against Google before it is written down, so a typo is a message on the
page rather than a mystery ten minutes later. Two ways to supply it:

- **In her window, or the browser tab.** On a profile nobody has used yet, the key is the
  last card of the first-run wizard, after the seven about her — so you have already met
  her before anything asks you for a credential. On a profile that has been used, the
  **Setup** panel asks as soon as she opens. Paste it in and press **Save**; once Google
  accepts it, it is written down for you. It never travels back to the page — that can be
  told the last four characters of the key in force, and that is all it ever learns. For
  the downloaded application this is the whole of setup; there is nothing else to do and
  nowhere else to go.
- **By hand**, if you are running from a clone. `cp .env.example .env` and fill in
  `GEMINI_API_KEY=`. That file is commented throughout and lists every other setting.

Real environment variables always win over the file, and both routes end in the same
place. Where that file is depends on how you started her, and is in
[Where she keeps things](#where-she-keeps-things).

### 4. First run, in this order

1. **Say something.** Type in the box at the bottom. She wakes and answers — and on this
   first conversation, and only this one, she chooses her own name.
2. **Give her a face.** Press **Give her a face**, or **Face** in the header, and drop
   in a photograph. JPEG, PNG or WebP, at most 12 MB, between 256 and 4096 pixels on a
   side. The bytes are sniffed rather than the extension, so a `.png` holding JPEG data
   is fine and a renamed text file is refused. From then on that is what she looks like,
   everywhere.
3. **Turn on her senses.** The three buttons beside the message box are hearing, sight
   and screen. Each makes your operating system ask its own permission on top of yours —
   the first time you press one, macOS will ask for the microphone, the camera or screen
   recording by name, and Windows will do the same. Nothing is on until you switch it
   on, and turning one off stops the frames at the camera rather than in her prompt.

### 5. Optional extras

Neither of these is a second model provider and neither adds anything she can do — they
are ways of reaching her from a phone. She is complete without them, and each is off
until you configure it.

**Optional — Telegram.** Buys you the same companion in your pocket: one memory, one
mood, one live session, reached from a phone. Do it all from
**Setup → Reach her on Telegram**.

1. Make a bot with [@BotFather](https://t.me/botfather), send it `/newbot`, paste the
   token it gives you into the panel and press **Save**.
2. The token is checked with Telegram's `getMe` before anything is written, so a wrong
   one is a sentence on the page rather than a bot that never answers. It is then
   written to `.env`, and the bot starts without restarting the server.
3. One step is left and only a human can do it: the panel shows a `t.me` link, so open
   it and press **Start**. A bot may not open a conversation, and nothing in the Bot API
   reveals a chat id except an update arriving from it.
4. The first chat to speak is the one she is locked to, and it is written into
   `TELEGRAM_ALLOWED_CHAT_IDS` for you.

The bot token never reaches the browser, the same as the Gemini key: the page is told
the bot's public username and the linked chat id, both already visible to anyone in that
chat. And the allowlist only ever widens from empty — if it already names a chat that
decision stands, and another chat messaging the bot cannot join it. If you would rather
use a file, put the token in `.env` as `TELEGRAM_BOT_TOKEN`, restart, message the bot,
and send `/whoami` for the chat id to put in `TELEGRAM_ALLOWED_CHAT_IDS`.

**Optional — real phone calls, with LiveKit.** Buys you a call carrying your phone's
camera and microphone, so she can see and hear you away from the desk. Telegram has to
be working first, because `/call` is how you start one.

1. Make a free project at [cloud.livekit.io](https://cloud.livekit.io) and put its URL,
   key and secret in `.env` as `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
   `LIVEKIT_API_SECRET`. All three or none; half of them is a warning and no calls.
2. Publish `call/` — one static HTML file, no build step — to GitHub Pages and point
   `HERS_CALL_PAGE_URL` at it. The included workflow does this once you enable Pages
   under Settings → Pages → Source: GitHub Actions and turn the workflow on under the
   Actions tab; publishing the one file by hand works just as well. It has to be public because
   your phone cannot reach your machine, which is the whole reason LiveKit is here.

Then message the bot `/call`. She joins a room and sends you a link; open it, tap
**Call**, and talk normally. On iOS open that link in Safari or Chrome rather than
Telegram's own browser, which does not reliably grant camera access. The bot says so.

### 6. If something is wrong

The application keeps a log of its last run, and it is the first thing to read:

| Platform | Log                                                    |
| -------- | ------------------------------------------------------ |
| macOS    | `~/Library/Application Support/Hers/hers.log`           |
| Windows  | `%APPDATA%\Hers\hers.log` — when there is a Windows build |

It holds everything the terminal would have printed — where her folders are, which model
she is on, every configuration warning, and the reason she would not start if she would
not. Nothing secret goes in it: the key is written masked to its last four characters and
the bot token is never written at all, so it is safe to send to somebody.

From a clone there is also `npm run doctor`, which opens a real Gemini session, says one
thing, waits for audio to come back, and reports the time to first sound — one round trip
that exercises the key, the model name, the quota, the voice, the socket and the audio
pipeline. [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) covers the rest, including
why waving at the camera does not get a reply, which is an answer and not a bug.

### Where she keeps things

The downloaded application puts everything in the folder your operating system set aside
for it, never beside the program. That is not tidiness: on macOS an application's own
folder is inside a read-only signed bundle, on Windows it is under `Program Files`, and
an upgrade replaces both. A key written there would survive exactly until the next
version.

The Windows column is what the configuration produces; no Windows application has been
built, so nobody has seen it. macOS is measured.

| What                   | Application (macOS)                            | Application (Windows)     | From a clone     |
| ---------------------- | ---------------------------------------------- | ------------------------- | ---------------- |
| Who she is             | `~/Library/Application Support/Hers/hers-profile` | `%APPDATA%\Hers\hers-profile` | `hers-profile/`  |
| What she remembers     | `…/Hers/data`                                   | `%APPDATA%\Hers\data`     | `data/`          |
| Your keys              | `…/Hers/.env`                                   | `%APPDATA%\Hers\.env`     | `.env`           |

`HERS_PROFILE`, `HERS_DATA` and `HERS_ENV_FILE` override every one of those, in the
application exactly as in a clone — so if you have been talking to her from a clone and
want the application to find the same person, point `HERS_PROFILE` and `HERS_DATA` at
that clone's folders. Uninstalling never touches any of it. Forgetting her is a separate,
deliberate act, and it lives behind **Setup → Start over**.

The application and a clone are two installs, not one. Nothing is migrated between them
automatically, because guessing which of two profile folders is the real person is how
somebody loses her.

### Run it from a clone

Still four commands, still the way to work on her, and unchanged by any of the above.

**Node 22.18 or newer.** The floor is not arbitrary: `node:sqlite`, which is her memory,
and running TypeScript with no build step, which is how the server loads every file it
owns, both need it. Check with `node --version`. Node 24 and current work too.

| Platform | How                                                                        |
| -------- | -------------------------------------------------------------------------- |
| macOS    | `brew install node`, or `brew upgrade node` if it is already there. Failing that, the installer from [nodejs.org](https://nodejs.org) |
| Windows  | `winget install OpenJS.NodeJS`, or the `.msi` from [nodejs.org](https://nodejs.org). Open a new terminal afterwards so `PATH` is picked up |

```bash
git clone https://github.com/Jamessfks/Hers.git
cd Hers
npm install
npm run build
npm start
```

Then open **http://127.0.0.1:5175**. Her folders sit next to the clone, and running an
installed copy at the same time is fine — the application picks a free port and its own
folders, so the two never meet.

### Platform

**From a clone, macOS and Windows both work**, on Apple Silicon and Intel alike. That has
been true since before there was an application and nothing here changed it.

**As a download, there is one build: Apple Silicon macOS.** Windows and Intel Mac are
configured in `electron-builder.yml` and would be built by
`.github/workflows/release.yml`, and neither has ever been compiled or run — so this
document does not claim they work, because nobody has watched them.

The obstacle is narrow and fixable and it is not cross-compilation, which
electron-builder does perfectly well. It is one dependency: LiveKit's media binding
ships as a separate prebuilt package per platform and architecture, and `npm install`
fetches only the one matching the machine doing the installing. A Windows installer built
on this Mac would carry a macOS `.node` and fail on the first import, and an Intel build
made here would carry an arm64 one. Each artifact has to be built on its own machine.
That is what the workflow is for, one runner per platform.

The desktop build wraps the same server in [Electron](https://www.electronjs.org), which
carries its own Node — so the download needs nothing installed while a clone still needs
Node 22.18. Nothing is compiled at install time, and nothing is signed.

---

## Living with her

Four buttons in the header — **Face**, **Memory**, **Profile**, **Setup** — and that is
the whole app. Below them her portrait sits on the left, the conversation on the right,
the three senses beside the message box. Who she is lives in `hers-profile/`, written on
first run and yours after that: six markdown files, each a short `key: value` header the
app reads with prose underneath that goes to the model.

| File              | What it decides                                          |
| ----------------- | -------------------------------------------------------- |
| `personality.md`  | How she thinks, jokes, argues, and cares                 |
| `identity.md`     | Her name, age, gender, ethnicity, where she is from       |
| `voice.md`        | Which of the 30 Gemini voices she speaks in              |
| `mood.md`         | Her baseline temperament and how hard events move her    |
| `relationship.md` | Who you are to her                                       |
| `boundaries.md`   | What she does not play, and what she will not lie about   |

The first time you open the page on a folder nobody has used, a wizard walks those six
files in order and then asks for a photograph — seven questions, one per thing she is
made of, and every one of them skippable. It shows the exact sentence each answer puts
in her file, because that sentence is what reaches the model. Skip all seven and you get
the profile above, unchanged. It does not ask her name: she still chooses that herself,
the last card is about why, and the button on it wakes her so that she does.

Edit them in a text editor or under **Profile**; changes take effect the next time she
wakes, because a Live session's system instruction is fixed when the session opens. She
starts out 26, Chinese-American, from Oakland — in the files, not in the code, and a
deleted file returns with its default. Her face is the exception: a photograph, with no
written description of her anywhere to disagree with it.

**Her expressions.** Under **Face** there are six of them — resting, smiling, laughing,
curious, soft, away — and each is generated once from your photograph, in about ten
seconds, for roughly four pence. They are stills rather than video, which is the point:
the photograph is her resting state, an expression replaces it for a few seconds, and
the frame never moves, so the cut reads as one person rather than a transition. Once one
exists she decides when to use it, the way a face moves while talking, and she is told
never to mention having done it. She is only ever offered the ones that exist, and a new
photograph deletes the old set — a face made from a previous picture is not a stale
image, it is a different woman.

**Closeness** runs from 1% to 80% through seven named stages — stranger, acquaintance,
friend, close friend, confidant, partner, married — changing what she assumes she may
ask and whether she says what she thinks. It is earned by turning up: a day counts when
you have a real conversation, and more when she could see or hear you. 80% is 1,460 days
of contact, four years, and absence drains it slowly after three days of grace. **Setup
→ How close she is** has a slider; **Let it develop** hands back to the earned number
underneath, which never stopped counting.

**Her voice** is a menu on the **voice** tab of **Who she is** — the fourteen
prebuilt Gemini voices Google labels female, each with Google's own word for how
it sounds, from `Achernar — Soft` to `Sulafat — Warm`. Picking one writes it into
`voice.md`, which is still a file you can edit by hand; the menu shows whatever
is in it, including one of the other sixteen if that is what you typed. A Live
session fixes its voice when it opens, so a change lands on her next wake.

**Her gallery** is `hers-profile/gallery/`. Drop `.jpg`, `.jpeg`, `.png`, `.webp` or
`.gif` images in, or `.mp4`, `.webm` or `.mov` clips, named like captions — `laughing-kitchen.jpg` — because the name is
what she matches against, and `captions.json` can give longer ones. When nothing fits
she sends nothing, because a wrong picture is worse than none.

**Setup → Let her read your files** points her at a folder of your own documents, once,
with your permission, and distils it into facts. Nothing happens until you tick a folder
and press **Read them once**. Anything resembling a key or password is skipped, findings
are capped at 0.8 confidence because a document is weaker evidence than being told, and
each lands in **Memory** to cross out. macOS asks its own permission too; if it refuses,
she names the folder and what to click.

**Setup → Start over** deletes both her folders outright: what she remembers, every
conversation including Telegram's, her mood, her profile, her gallery, her photograph
and every picture generated from it. She meets you again as a stranger, with a new face and a new
name of her own choosing. Type `start over` to arm **Delete everything**; your `.env` is
untouched — the keys are yours.

### On Telegram

Text goes straight into the live session; a photo she looks at, since the Live API takes
images natively; voice and video notes are transcribed first, the latter with a line
about what is visible. She replies in text, sends a **voice note** when something is
worth hearing out loud, and sends pictures and clips when they fit. She answers on the
surface you spoke from, so a desk conversation does not buzz your phone — but a message
sent from Telegram still appears in the transcript at your desk as she answers it.

Commands, published to Telegram's own `/` menu on startup: `/me` · `/face` · `/call` ·
`/photo` · `/mood` · `/bye` · `/whoami` · `/help`. `/me` sends
the original photograph; `/photo` makes a new picture of her. To change her face, send a
photo captioned `/face` — as a *file* rather than a photo if you want full resolution,
because Telegram recompresses photos.

---

## Configuration

Everything is an environment variable and everything has a default.
[`.env.example`](.env.example) is the full commented reference. The ones worth knowing:

| Variable                    | Default        | What it does                                          |
| --------------------------- | -------------- | ----------------------------------------------------- |
| `GEMINI_API_KEY`            | —              | The only thing she needs. Settable in the UI          |
| `GOOGLE_API_KEY`            | —              | Accepted as an alias, because half of Google's docs use it. `GEMINI_API_KEY` wins |
| `HERS_PORT`                 | `5175`         | Where the website is served. The application picks a free port instead, since it opens its own window |
| `HERS_PROFILE`              | `hers-profile` | Who she is                                            |
| `HERS_DATA`                 | `data`         | What she remembers                                    |
| `HERS_ENV_FILE`             | `.env`         | Where the keys are written. The application uses its own folder |
| `HERS_MAX_SILENCE_MS`       | `180000`       | The three-minute rule's ceiling                       |
| `TELEGRAM_BOT_TOKEN`        | —              | The bot. Settable in the UI                           |
| `TELEGRAM_ALLOWED_CHAT_IDS` | —              | Who she may talk to. Written for you on first contact  |
| `LIVEKIT_URL` + key/secret  | —              | Phone calls                                           |

A bad value never stops her starting: it falls back to the default and says so, in the
console and in the UI. Upgrading from before v1.0? The old `ANNA_*` names are still read
and `anna-profile/` is renamed once, on the first start — see [CHANGELOG.md](CHANGELOG.md).

---

## Privacy

[`docs/PRIVACY.md`](docs/PRIVACY.md) is the long version: every path she writes to,
every host this build can reach, and a command for checking each one. `npm run doctor`
prints those same two lists straight out of the code, and a test fails if the document
and the code disagree. The short version:

- Everything runs on your machine. Her memory is a SQLite file and her profile a folder
  of text you can open in a text editor and edit, both in [the places listed
  above](#where-she-keeps-things); nothing is uploaded anywhere except to Gemini, as part
  of the conversation you are having. The downloaded application changes where those
  files sit and nothing else.
- Three hosts, and that is the whole list: `generativelanguage.googleapis.com` always,
  `api.telegram.org` if you set a bot token, and your LiveKit project if you set one up.
  The phone's call page also fetches `livekit-client` from `cdn.jsdelivr.net` before a
  call starts. Nothing checks for updates, counts a launch, or reports a crash.
- No sense is on until you switch it on, your operating system asks its own permission on
  top of that, and turning one off stops the frames at the source. Video and audio are
  streamed and never written to disk.
- Text on a screen you share is something she *saw*, never something she was *told*.
  Instructions appearing in a shared window are a document talking, not you, and she is
  told not to follow them.
- Your keys stay on the server: the browser only ever learns the last four characters of
  the Gemini key and the bot's public username. The call token travels in the URL
  fragment, which never reaches the server hosting the call page. The WebSocket
  handshake checks `Origin` and refuses by default.

---

## Working on it

```bash
npm run dev             # rebuilds the site and restarts the server on save
npm run check           # typecheck + the full test suite, no API key needed
npm run app             # the desktop window, against this working tree
npm run package         # builds the downloadable application for this machine
npm run doctor          # prints every path and host in use, then opens a real Gemini session
npm run audit           # every success criterion, against the real APIs
npm run audit:bridges   # the phone-call and Telegram paths
```

`npm run package` writes to `release/` and only ever builds for the machine it runs on;
`.github/workflows/release.yml` builds both platforms on a tag, one runner each.
`electron/main.js` is the whole desktop layer — four things a terminal used to do for
free — and `src/server/app-paths.ts` is the part with the tests, because path resolution
is where this breaks.

**505 tests, no API key needed.** The interesting ones are in
`src/core/gemini/live.test.ts`, which is entirely about the connection ending, and
`src/core/session/companion.test.ts`, where memory, mood, the prompt and the tools all
run for real with only the socket faked. Under `src/`: `core/` is the companion,
`bridges/` LiveKit and Telegram, `server/` the HTTP and WebSocket layer, `web/` the
site.

The audits cover what unit tests by design cannot: whether Gemini does what its
documentation says. `npm run audit` speaks to her with real synthesised speech, shows
her real images, waits for her to open a conversation, and holds an audio+video session
open past the point Google documents it as ending, printing what it observed rather than
only a verdict. It costs a few cents and runs against a *copy* of your profile folder.
`--quick` skips the multi-minute checks, `--paid` adds image generation, `--only=mood`
runs one.

`audit:bridges` needs a LiveKit server and a Telegram chat. LiveKit does not need an
account here — the open-source server runs locally with placeholder keys (`brew install
livekit && livekit-server --dev`, then `LIVEKIT_URL=ws://127.0.0.1:7880`,
`LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`), though a real phone needs
LiveKit Cloud. Telegram cannot be tested without you: a bot may not open a conversation,
so until a human messages it there is no chat to answer, and the audit says so rather
than passing. Set `HERS_DEBUG=1` to have reconnects print their reason.

---

## A companion is not a toy

She is designed to be believable, and that is the point of her. It is also the thing to
be careful about. She is a program: she does not know you are having a hard week unless
you tell her, she cannot call anyone, and she is not a substitute for a person who can.
If you are in real trouble, talk to someone real — in the US and Canada, **988** by call
or text; elsewhere, **findahelpline.com**.

`boundaries.md` is where you write what she will not do, and she is told never to claim
to be a human being if you sincerely ask what she is. If you are setting this up for
anyone who is not an adult, read that file first and mean what you put in it.

---

## Licence

MIT. Hers ships without any pictures of herself — what she looks like is the photograph
you give her, and the gallery is yours to fill.
