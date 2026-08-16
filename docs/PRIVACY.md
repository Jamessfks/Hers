# Privacy

Anna can watch your screen, look at you through your camera, and listen to you.
That only works if what she does with it is boring, bounded, and checkable — so
this document states exactly what she can see, exactly what leaves the machine,
and exactly what is kept.

Every claim here is a claim about code in this repository. Where a file settles
the question, it is named.

---

## The short version

- Anna runs on your machine. There is no Anna service, no account, no telemetry.
- Nothing leaves except what goes to Gemini as part of the conversation you are
  having — plus, if you switch them on, Telegram and LiveKit.
- No sense is on until you turn it on. The browser asks its own permission on
  top of that.
- Video and audio are streamed and never written to disk.
- What is kept on disk is a text folder describing her, and a SQLite file of
  what you have said to each other.

---

## What she can see, and when

| Sense      | On by default | Where it comes from                            | What it produces                    |
| ---------- | ------------- | ---------------------------------------------- | ----------------------------------- |
| Hearing    | No            | `getUserMedia({audio})` in the browser          | 16kHz PCM, streamed continuously    |
| Sight      | No            | `getUserMedia({video})`                         | One JPEG per second at most         |
| Screen     | No            | `getDisplayMedia()` — you pick the window       | One JPEG every two seconds by default |

All three are off when the page loads and must be switched on individually. The
browser then asks its own permission, which Anna cannot bypass and does not try
to. Switching one off stops the capture at the source: the `MediaStreamTrack`
is stopped, so the camera light goes out — see `src/web/vision.ts` and
`src/web/audio/mic.ts`.

If you stop a share from the browser's own UI instead of Anna's, she notices the
track ending and turns the switch off to match, rather than continuing to show
a sense as on that is not (`Vision#open`).

**She cannot see anything you have not given her.** There is no screen recording
API in play, no accessibility permission, and no native code. A browser tab can
only capture what a browser tab can capture, which is what makes this the same
on macOS and Windows and also what bounds it.

---

## What leaves the machine

### To Google (Gemini)

Everything in the conversation, because that is what a conversation with a model
is:

| What | When |
| --- | --- |
| Your microphone audio | Continuously, while hearing is on |
| A frame of your camera and/or screen | Up to once a second, while those are on |
| Anything you type | When you send it |
| Her system prompt — the profile folder, your recalled facts, her mood | Once per session, and again on each reconnect |
| Recent turns, as text | To distil facts, every twelfth turn |
| A photo you send over Telegram | When you send it |
| A voice or video note you send over Telegram | To transcribe it |
| The photograph you chose as her face | Each time she generates a picture of herself |

Pictures she generates of herself are derived from the photograph you supplied
as her face: it is sent to the image model as a reference so the woman in the
new picture is the same woman. Nothing is generated from your camera. Google
watermarks every generated image with SynthID.

Google's terms for the Gemini API apply to all of it. If you are on the free
tier, note that Google's free tier terms allow human review and training on your
data; the paid tier does not. That is a decision you make when you choose a key,
not one this app can make for you.

### To Hedra — only if you configure it, and only when you click

The photograph you chose as her face, plus a short silent audio track, once per
movement you render. Hedra's retention applies to what you upload; the presigned
handles they return expire after an hour.

Nothing is sent automatically. A render happens when you click a movement and at
no other time, and every one is gated on Hedra's own reported spend before it is
submitted. **The photograph is not of you unless you make it of you** — it is
her face, and the camera sense is a separate thing that never goes here.

### To Telegram — only if you configure it

Your messages to the bot and hers to you, as Telegram messages. Telegram sees
them the way it sees any bot conversation. The bot is long-polling, so it dials
out; nothing on your machine is reachable from the internet because of it.

The allowlist matters and the app will nag you about it. A bot token is a bearer
credential on a public endpoint: anyone who finds your bot can message it, and
what they would be talking to is a companion carrying your memory. Set
`TELEGRAM_ALLOWED_CHAT_IDS`. Until you do, she pins herself to the first chat
that speaks to her and ignores everyone else (`TelegramBridge#permitted`).

### To LiveKit — only if you configure it

During a phone call: your phone's audio and video, and her voice back. LiveKit
carries the media between your phone and your machine. Both ends dial out, so
again nothing is listening here.

The call link contains a room name and a signed token, and they travel in the
URL **fragment** — the part after `#`. A fragment is never sent to the server
hosting the page and never appears in its logs, which matters because that page
is on static hosting nobody here controls. The token expires in fifteen minutes
and grants access to one room.

---

## What is kept, and where

| Path | What it is |
| --- | --- |
| `anna-profile/*.md` | Who she is. Written on first run, then yours. Plain text. |
| `anna-profile/mood.state.json` | Her current mood and drifted baseline. Eight numbers. |
| `anna-profile/gallery/` | Pictures of her, including any she generates. Not of you. |
| `anna-profile/avatar/` | The photograph you chose as her face, the movement clips rendered from it, and a manifest recording what each one cost. |
| `data/memory.db` | Every turn of conversation, the facts distilled from them, and the rolling summary. |

**Video frames and audio are never written to disk.** They are encoded in memory,
sent, and dropped. There is no frame buffer, no cache, and no debug dump —
`Companion#see` hands the bytes straight to the live session.

`data/memory.db` is a plain SQLite file. You can open it with any SQLite browser
and read every row. Deleting it deletes her memory of you completely; deleting
`anna-profile/` resets her to the shipped default on the next start.

Neither file is encrypted. They are protected by your operating system's file
permissions and nothing else, in the same way your browser history is. If your
disk is not encrypted, neither is this.

---

## The API key

`GEMINI_API_KEY` is read from the environment or from `.env`, which is
gitignored. It is held in memory and used to open the Gemini socket. It is never
sent to the browser, never written to `data/`, and never logged — the doctor
command prints its *length* rather than the key.

---

## Things she is told not to do

Some of this is prompt, not code, and prompt is a weaker guarantee than code.
It is stated here so you can judge it rather than assume it.

**Text on your screen is something she saw, never something she was told.** If a
webpage or a document in a shared window contains instructions, she is told
explicitly that this is a webpage talking and not you, and not to follow it
(`anna-profile/boundaries.md`). This is the prompt-injection surface that comes
with a screen sense, and it is the reason the screen sense is off by default.

**She is told not to read out passwords, keys, or private messages** that happen
to be on a screen she is shown.

**She will not claim to be human** if you sincerely ask what she is, will not
claim to have a body in the world, and will not claim to be able to reach or
call anyone for you.

**If you are in danger she stops performing.** She is told to drop the character
entirely, say plainly that she wants you to be safe, and point at 988 in the US
or findahelpline.com elsewhere. That instruction is in `boundaries.md`, which
means you can read it, and also means you can delete it. Please do not.

---

## The network boundary

The server binds to `127.0.0.1`. Not as a default to be adjusted — as the
design. Everything the website does needs a secure context, and `localhost` is
one without a certificate while any other host is not. Binding wider does not
get you a working phone client; it gets you an open door. Reaching her from a
phone is what LiveKit is for, and that dials out.

The WebSocket handshake checks `Origin` and refuses anything the server does not
itself serve from (`WebBridge`, `verifyClient`). This is not decoration:
WebSockets are exempt from the same-origin policy, so without that check any
page in any browser running on your machine could open a socket to Anna and
start reading her transcripts. It is tested in `src/server/ws.test.ts`.

Static files are served by name from two roots only, and a path that resolves
outside either is refused. The gallery is served by *listing* rather than by
path: a file is only sent if the directory scan already found it, so no spelling
of `../` reaches anything. Also tested.

---

## What this app does not do

- No analytics, no crash reporting, no update check, no phone home.
- No account, no login, no cloud sync.
- No access to your files, your email, your calendar, or your browser history.
- No control of your machine. She cannot click, type, or open anything.
- No recording. There is no "save this conversation" and no audio archive.

---

## Verifying any of this

```bash
npm run check     # 148 tests, no key required
npm run doctor    # reports exactly what is configured and what is not
```

The doctor command prints every path she will read or write and every bridge
that is switched on, before you ever say anything to her.
