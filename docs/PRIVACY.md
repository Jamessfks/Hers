# Privacy

**Covers Hers v1.4.0.** This page describes the code in this repository at that
version and nothing else. A test fails if that version stops matching
`package.json`, so a stale copy of this document cannot ship quietly alongside a
newer program.

She can watch your screen, look at you through your camera, and listen to you.
That only works if what she does with it is boring, bounded, and checkable — so
this document states exactly what she can see, exactly what leaves the machine,
and exactly what is kept.

## How to read this

Nothing here asks to be believed. Every claim is either a path you can open, a
hostname you can watch for, or a file in this repository, and each one is
written so that a reader with a terminal can prove it wrong in about a minute.
The claims that cannot be checked that way are all in one section, *Things she
is told not to do*, because they are instructions in a prompt rather than
properties of code. They are grouped there and labelled rather than mixed in.

Two things follow from that, and they are the reason this document is shaped the
way it is.

The first is that **`npm run doctor` prints the same two lists this document
does**: every absolute path she writes to, and every host this build can reach.
It reads them out of the code, not out of prose, so if the program and this page
ever disagree the program is the one telling the truth. Run it before you run
anything else.

The second is that the host list is held in `src/shared/destinations.ts` and
enforced by `src/shared/destinations.test.ts`. That test walks the source for
URL literals and fails on any hostname that is not accounted for, and it fails
again if this document does not name every host the program can dial. So `npm
test` is a check on this page, not only on the code. It is not a complete
guarantee — the section on the Gemini SDK below says where it stops — but it
means the usual way these documents go stale cannot happen quietly.

---

## The short version

Hers runs on your machine. There is no Hers service, no account, no telemetry,
no licence check, and no update check. Nothing leaves except what goes to Gemini
as part of the conversation you are having, plus Telegram and LiveKit if you
switch them on. No sense is on until you turn it on. Video and audio are
streamed and never written to disk. What is kept is a folder of plain text
describing her, and a SQLite file of what the two of you have said.

None of that is unusual to claim. The rest of this page is the part that makes
it checkable.

---

## Where everything she knows about you lives

Two folders. Where they are depends on how you started her, and there are
exactly two answers.

**From a clone**, they are **next to wherever you started her from**, because
the defaults are the relative paths `hers-profile` and `data`, resolved against
the working directory at startup (`src/server/config.ts`).

**From the downloaded application**, they are in the folder the operating system
sets aside for it — `~/Library/Application Support/Hers` on macOS,
`%APPDATA%\Hers` on Windows — because an application cannot write next to its
own executable: the bundle is read-only on macOS and lives under `Program Files`
on Windows. The keys file moves with them, which is what `HERS_ENV_FILE` is for.

`HERS_PROFILE`, `HERS_DATA` and `HERS_ENV_FILE` override either answer. Nothing
else on this page changes between the two: same files, same contents, same
machine, nothing sent anywhere it would not otherwise go.

If you cloned into `~/hers` and run `npm start` from there:

| | macOS and Linux | Windows |
| --- | --- | --- |
| Who she is | `~/hers/hers-profile/` | `C:\Users\you\hers\hers-profile\` |
| What she remembers | `~/hers/data/memory.db` | `C:\Users\you\hers\data\memory.db` |
| Your API keys | `~/hers/.env` | `C:\Users\you\hers\.env` |

If you cloned somewhere else, they are somewhere else, and you should not have
to work it out from a document. Both `npm run doctor` and `npm start` print all
three resolved to absolute paths — the banner line for the third reads `keys
/your/path/.env`, or `.env (not written yet)` before you have saved a key.
`HERS_PROFILE` and `HERS_DATA` move the first two.

That sentence was false in the first version of this page, which is worth
recording rather than quietly correcting. The banner named the profile folder
and the database and never mentioned `.env` at all, and `.env` is the one people
actually go looking for. The claim is now held up by
`src/server/banner.test.ts`, which reads what the banner returns and asserts all
three paths are there and absolute.

### The profile folder, file by file

Every path below comes from `src/shared/writers.ts`, which a test holds against
the code that writes them. It is not a tree somebody typed out and hoped stayed
true — the previous version of it had already lost two entries.

```
hers-profile/
  personality.md                      how she behaves
  identity.md                         her name, age, where she is from
  voice.md                            which of the thirty voices, and how she speaks
  mood.md                             her baseline temperament and how far it drifts
  relationship.md                     what she is to you
  boundaries.md                       what she will not do, incl. the safety instruction
  README.md                           written on first run, explaining the above
  mood.state.json                     eight numbers and a timestamp: her mood on four
                                      axes and the baseline it drifts back to. Only
                                      exists once something has moved her.
  intimacy.state.json                 how close she is, and the days behind it
  knowledge.json                      only if you use Setup → Let her read your files
  avatar/source.jpg                   the photograph you gave her as her face
  avatar/face-<expression>-<id>.jpg   one per generated expression
  avatar/manifest.json                their sizes, hashes and when they arrived
  gallery/README.md                   written on first run, explaining the folder
  gallery/<her description>.jpg       pictures of her, including any she generated.
                                      Never of you.
  gallery/captions.json               only if you write one. Read, never written.
```

`gallery/captions.json` is the one file in that tree the program will read and
never create. It is not in `writers.ts` for exactly that reason, and it is
mentioned here because a file you may put there is still a file you should know
is being read.

**Open any of those `.md` files in TextEdit or Notepad and change a line.** She
reads them back — on the next reconnect for a live conversation, immediately for
the next one — and she is different. That is what the folder is for. There is no
export step, no encryption, no proprietary container, and nothing derived from
her that lives anywhere else: these files are the character, not a copy of it.

The six markdown files are also editable from the website under **Profile**,
which writes the same files back. The editor is a convenience. The files are the
thing.

### The memory database

`data/memory.db` is a plain SQLite file with four tables — `turns`, `facts`,
`summaries`, `meta` — written by `node:sqlite` from Node's standard library
(`src/core/memory/store.ts`). No extension, no custom page format, no
obfuscation. Open it with `sqlite3`, with [DB Browser for
SQLite](https://sqlitebrowser.org), or with anything else that reads SQLite:

```bash
sqlite3 data/memory.db '.tables'
sqlite3 -header -box data/memory.db \
  "SELECT speaker, datetime(at/1000,'unixepoch','localtime') AS said, text
   FROM turns ORDER BY id DESC LIMIT 20;"
```

`turns` is every line either of you has said. `facts` is what she decided was
worth keeping, one short sentence each, with a confidence and an embedding.
`summaries` is the rolling précis. `meta` is bookkeeping. Every fact is also
listed, editable and deletable in the website under **Memory**, which is the same
rows through a different window.

Two things about that file that are easy to get wrong, so they are stated here.

**There are three files, not one.** SQLite is opened in WAL mode, so
`memory.db-wal` and `memory.db-shm` sit beside it and the newest turns may be in
the `-wal` until it is checkpointed. Deleting only `memory.db` is therefore not
the clean break it looks like. Delete the whole `data/` folder, or use **Setup →
Start over**, which removes both directories outright.

**The embeddings are vectors, not text.** The `embedding` column is a BLOB of
raw 32-bit floats — 768 of them per fact with a Gemini key, 512 with the offline
fallback — and the `embedder` column next to it names which. It is not a second,
hidden copy of your conversation: the sentence it was computed from is right
there in the `text` column of the same row. But it is not human-readable either,
and calling a `BLOB` column plain text would be exactly the kind of claim this
page exists to avoid.

### Nothing here is encrypted, and that is a decision

Neither folder is encrypted. They are protected by your operating system's file
permissions and nothing else, in the same way your browser history is.

This is a trade, not an oversight, and it is worth being plain about which way
it goes. An encrypted store would protect the files from someone who has your
disk but not your passphrase. It would also mean you could not open her
character in a text editor, could not read her memory in `sqlite3`, could not
diff the folder, back it up meaningfully, or check any claim on this page — and
the person you would be trusting instead is whoever wrote the encryption.

Hers takes the other side of that trade: everything readable by you, and disk
encryption left to the thing that does it properly. If your disk is not
encrypted, neither is this. Turn on FileVault on macOS or BitLocker on Windows;
they handle the threat that file-level encryption in an app only half handles,
and they do it without making her illegible to you.

`.env` is the one exception to "readable", in the other direction: it is written
with mode `0600`, owner-only, because it holds keys rather than character
(`src/server/env-file.ts`).

---

## What is held only in memory, and never written

**Video frames and microphone audio are never written to disk.** They are
encoded, sent, and dropped: there is no frame buffer, no cache, no debug dump
and no "save this conversation". `Companion#see` hands the bytes straight to the
live session.

That is checkable rather than merely asserted, and it is checked the same way
the host list is. Exactly eleven modules touch the filesystem — ten under `src/`
and one in `electron/`, which is worth saying because the first version of this
table scanned `src/**/*.ts` only, and therefore could not see the plain
JavaScript entry point that writes the log:

| Module | Writes | Under |
| --- | --- | --- |
| `core/profile/profile.ts` | the six character files, `README.md`, `gallery/README.md` | profile |
| `core/mood/mood.ts` | `mood.state.json` | profile |
| `core/intimacy/intimacy.ts` | `intimacy.state.json` | profile |
| `core/avatar/studio.ts` | `avatar/source.jpg`, `avatar/face-<expression>-<id>.jpg`, `avatar/manifest.json` | profile |
| `core/gallery/gallery.ts` | `gallery/<her description>.jpg` | profile |
| `core/knowledge/scan.ts` | `knowledge.json` | profile |
| `core/memory/store.ts` | `memory.db`, `memory.db-wal`, `memory.db-shm` | data |
| `core/session/brain.ts` | creates `data/`; deletes both folders on Start over | data |
| `server/env-file.ts` | `.env` | where you started her |
| `server/config.ts` | renames `anna-profile/` to `hers-profile/`, once | where you started her |
| `electron/main.js` | `hers.log` | the application's own folder |

### `hers.log`, and what is in it

Only the downloaded application writes it; running her from a clone does not. It
holds everything the last run printed, and it is rewritten from empty on every
launch, because a window that never appeared cannot tell you why it did not and
this is where it says so instead. Both the README and the troubleshooting page
tell you to read it, so this page has to tell you what you would be reading.

It contains the absolute paths in use, which include your account name; the
pinned Telegram chat id if you use that bridge; and every configuration warning.
It contains no key. The Gemini key is printed only as its last four characters,
the doctor prints its length rather than the key itself, and the bot token is
never printed at all — that is enforced by the same tests as the rest of this
page. It is safe to send to somebody helping you, and if that ever stops being
true, this paragraph is the thing that was wrong.

Find them yourself. This is the exact pattern `src/shared/writers.test.ts`
scans with, quoted from the same constant the test uses, so the answer you get
is the answer the test gets:

```bash
grep -rlE "(writeFile|appendFile|createWriteStream|renameSync|rename|mkdir)[[:space:]]*\(|node:sqlite" \
  --include="*.ts" --exclude="*.test.ts" --exclude="writers.ts" src/
```

Ten paths back, and the table above has ten rows. The test fails if the scan
finds a module the list does not name, fails if the list names a module that has
stopped writing, and fails if this page does not mention every path in it.
`writers.ts` is excluded from the scan because it contains the pattern and would
otherwise match itself; a separate test asserts that file imports no filesystem
module, so the exemption cannot become a hiding place.

The last two rows are why the pattern matches more than `writeFile`.
`brain.ts` creates a directory and deletes two, and `config.ts` moves a folder
during an upgrade — neither writes a byte of content, and a scan that only
looked for content writes would have reported neither.

Nothing on that list takes a camera frame, a screen frame, or a buffer of PCM.

Also held only in memory, for the life of the process: your Gemini key, your
Telegram bot token, the LiveKit tokens minted for a call, the resumption handle
that lets a dropped Gemini session continue, and the 32×18 greyscale thumbnail
the browser uses to tell "still reading" from "switched to something else"
(`src/shared/screen-change.ts`). That last one never leaves the browser tab at
all; what leaves is one of three words — still, working, switched — and a number
of seconds.

---

## Every host this program can contact

Grouped by hostname, which is the unit a network monitor shows you. `npm run
doctor` prints this same list with your configured hosts substituted in.

### `generativelanguage.googleapis.com` — needs a Gemini key

Everything she is told and everything she says goes here, because that is what a
conversation with a model is.

| What is sent | What triggers it |
| --- | --- |
| Microphone audio, camera and screen frames, anything you type, her system prompt, her tool calls — over one WebSocket | Continuously while a conversation is open, and again on each reconnect. This is the only connection that ever carries realtime media. |
| Recent turns as text | Every twelfth turn, to distil them into facts |
| A Telegram voice or video note | When you send one, to transcribe it |
| Excerpts of documents from folders you ticked | Once, when you press **Read them once**. Anything resembling a key or password is skipped before it is opened. |
| A shortlist of names, and her personality | Once, on a first-ever conversation, when she has never been named |
| The photograph you gave her, plus a text prompt | Each time she generates a picture of herself, and once per expression you ask for |
| One short sentence per fact | When a fact is written down, and when she looks one up — this is the embedding call |
| A key and nothing else | When you submit a key in **Setup**. A metadata request listing one model name; the only request ever made with a key that has not been confirmed. |

The live conversation is a WebSocket to
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
opened by `@google/genai`. Your key travels as a query parameter on that URL,
inside TLS — the SDK's choice, not this project's, and worth knowing because it
means the key is in the request line rather than a header.

Pictures she generates of herself are derived from the photograph you supplied:
it is sent to the image model as a reference so the woman in the new picture is
the same woman. Nothing is generated from your camera. Google watermarks every
generated image with SynthID.

Google's terms for the Gemini API apply to all of it, and the difference between
the two tiers is the single largest privacy decision in using Hers — larger than
anything on this page, because it is the difference between your conversations
staying between you and a model and your conversations being read by people.

What the [Gemini API Additional Terms of
Service](https://ai.google.dev/gemini-api/terms) actually say, read rather than
characterised:

On the **unpaid** tier, Google uses submitted content and generated responses to
provide, improve and develop its products, and human reviewers may read,
annotate and process API input and output — disconnected from your Google
account, API key and Cloud project first. Google's own instruction in that
paragraph is *"Do not submit sensitive, confidential, or personal information to
the Unpaid Services."* A companion is nothing but personal information, so take
that sentence literally: on a free key, this is not a private application.

On the **paid** tier, prompts and responses are not used to improve products and
are handled under Google's data-processor addendum. They are still logged for a
limited period, solely for enforcing the Prohibited Use Policy.

**Neither tier is given a retention period in those terms.** I went looking for a
number to cite and there is not one — "a limited period of time" is as specific
as the paid-tier text gets, and the unpaid section names no window at all. The
only durations in the whole document are thirty days for Grounding with Google
Search and thirty (with up to ninety for display optimisation) for Grounding with
Google Maps. Hers enables no grounding tool of any kind, so neither applies here;
her `recall` searches the local SQLite file and her `look` changes her own
expression, and nothing in this program performs a web search. If a retention
number matters to you, it is a question for Google, and this page will not invent
one on their behalf.

One carve-out worth knowing because it flips the whole calculation: if you are in
the European Economic Area, Switzerland or the United Kingdom, Google's terms
apply the *paid* data handling to all services, including the unpaid quota.

Choosing the tier is a decision you make when you choose a key, and it is not one
this app can make for you. It can tell you which key is in force — Setup shows
the last four characters — and it cannot tell whether that key is billed.

### `api.telegram.org` — only with `TELEGRAM_BOT_TOKEN` set

| What is sent | What triggers it |
| --- | --- |
| `getUpdates`, a long poll asking for new messages | Continuously while the server runs, in fifty-second polls |
| `getMe`, `setMyCommands` | Once at startup, and when you submit a token in Setup |
| `sendMessage`, `sendPhoto`, `sendVoice` | When she replies |
| `getFile`, then a download from the same host | When you send the bot a photograph, a voice note or a video note |

The bot is long-polling, so it dials out; nothing on your machine becomes
reachable from the internet because of it. Telegram sees the conversation the
way it sees any bot conversation.

The allowlist matters and the app will nag you about it. A bot token is a bearer
credential on a public endpoint: anyone who finds your bot can message it, and
what they would be talking to is a companion carrying your memory. Set
`TELEGRAM_ALLOWED_CHAT_IDS`. Until you do, she pins herself to the first chat
that speaks to her and ignores everyone else (`TelegramBridge#permitted`).

### Whatever host is in `LIVEKIT_URL` — only with all three LiveKit variables set

During a phone call: your phone's audio and video, and her voice back. Both ends
dial out, so nothing here is listening. WebRTC will also reach LiveKit's media
servers directly, and those addresses are handed out by LiveKit at connect time
rather than written anywhere in this repository — so the honest form of this
claim is "LiveKit's infrastructure", not a single hostname.

Minting the tokens for a call is local arithmetic. `AccessToken.toJwt()` signs
with the secret you configured and makes no request.

### `cdn.jsdelivr.net` — no longer reached, and worth saying why

Until v1.4.0 the call page imported `livekit-client` from jsDelivr as an ES
module, so opening a call link made **your phone** fetch that file before the
call started. It is gone: the library is a devDependency, the build copies it in
beside the page, and nothing is fetched at run time.

It is written up here rather than quietly deleted because of *how* it was found,
which is the useful part. A network monitor on the machine Hers runs on would
never have shown it — the phone made the request, not this machine — so the
"unplug your network and watch" check this page invites you to run would have
come back clean while a third party was serving executable JavaScript into the
call path. It was version-pinned, which pins the name and not the bytes;
subresource integrity does not apply to a bare `import` specifier.

An audit of the code found it, not a monitor. That is the argument for the test
this page is enforced by, and against trusting any single method.

The host serving the call page itself — whatever `HERS_CALL_PAGE_URL` points at,
usually GitHub Pages — still sees a request for two static files, from your
phone, with no fragment on them. That is the whole reason the token is in the
fragment: the hosting is not ours and the token is a credential.

### What is never contacted

No analytics, no crash reporting, no update check, no licence server, no
telemetry, no package registry at runtime, no font CDN, no error tracker. The
website served at `127.0.0.1:5175` loads no third-party script and no remote
font; every request it makes is to itself. There are two `<a href>` links on the
setup page, to `aistudio.google.com/apikey` and `t.me/botfather`, and they reach
nothing unless you click them.

### The limit of this list, stated plainly

`@google/genai` is a large dependency, and it contains code paths that reach
`aiplatform.googleapis.com`, `vertexai.googleapis.com` and
`raw.githubusercontent.com`. None of them is reachable from here: the first two
are Vertex AI mode, which requires constructing the client with `vertexai: true`,
and nothing in this repository does; the third downloads a tokenizer model for
local token counting, which nothing here uses.

That is an argument from having read the SDK, not a guarantee enforced by a
test, and it is the weakest claim on this page. It is written down as a weak
claim rather than folded into the strong ones. A network monitor settles it in
thirty seconds without taking anyone's word for it, and the next section says
how.

---

## What she can see, and when

| Sense | On by default | Where it comes from | What it produces |
| --- | --- | --- | --- |
| Hearing | No | `getUserMedia({audio})` in the browser | 16kHz PCM, streamed continuously |
| Sight | No | `getUserMedia({video})` | One JPEG per second at most |
| Screen | No | `getDisplayMedia()` — you pick the window | One JPEG every two seconds by default |

All three are off when the page loads and must be switched on individually. The
browser then asks its own permission, which the app cannot bypass and does not
try to. Switching one off stops the capture at the source: the `MediaStreamTrack`
is stopped, so the camera light goes out — see `src/web/vision.ts` and
`src/web/audio/mic.ts`.

If you stop a share from the browser's own UI instead of the app's, she notices
the track ending and turns the switch off to match, rather than continuing to
show a sense as on that is not (`Vision#open`).

If both the camera and the screen are on, she is sent **one** composited picture
— your screen with you inset in a corner — because the Live API takes stills on
one channel with no way to label the source.

**She cannot see anything you have not given her.** There is no screen-recording
API in play, no accessibility permission, no Full Disk Access request, and no
native code. A browser tab can only capture what a browser tab can capture,
which is what makes this the same on macOS and Windows and also what bounds it.

The one thing that reaches outside the browser is deliberate, off by default,
and leaves a record: **Setup → Let her read your files** walks the folders you
tick, once, when you press **Read them once**. `hers-profile/knowledge.json` is
written before the scan starts and holds the absolute paths you approved and
when. Files whose names look like credentials — `.env`, `.pem`, `id_rsa`,
anything containing `password` or `credential` — are skipped before they are
opened (`looksLikeSecret` in `src/core/knowledge/scan.ts`). The excerpts go to
the distiller and the facts are kept; the raw text is not written anywhere.

---

## Verify this yourself

Every command below was run against this repository before it was written down.
None needs an API key. One of them will spend a fraction of a cent if it finds
one, and that is called out where it happens.

**Ask the program where its files are and who it can talk to.** This is the one
to run first, and the two sections it prints are built from the code rather than
copied from here:

```bash
npm run doctor
```

Its last step, if you have a key, opens a real Gemini session to prove the key
works. That is the fraction of a cent. Everything above that step is offline, so
with no key it stops before it and still prints both lists:

```bash
GEMINI_API_KEY= npm run doctor
```

**Read her character.** Plain text, on your disk, yours to change:

```bash
cat hers-profile/identity.md
ls -la hers-profile hers-profile/avatar hers-profile/gallery
```

**Read her memory of you.** Everything, in the order it was said:

```bash
sqlite3 data/memory.db '.tables'
sqlite3 -header -box data/memory.db \
  "SELECT speaker, datetime(at/1000,'unixepoch','localtime') AS said, text
   FROM turns ORDER BY id DESC LIMIT 20;"
sqlite3 -header -box data/memory.db \
  "SELECT kind, confidence, text FROM facts ORDER BY last_seen_at DESC;"
```

**Check the host list against the source yourself.** This is the grep the test
automates, and it should print nothing this document has not already named:

```bash
grep -rhoE "(https?|wss?)://[A-Za-z0-9._~%-]+" \
  --include="*.ts" --include="*.html" --exclude="*.test.ts" \
  src/ scripts/ call/ | sort -u
```

Nine lines, at the time of writing, and every one is accounted for above. Three
are hosts the program dials: `generativelanguage.googleapis.com`,
`api.telegram.org`. Two are this machine: `localhost` and
`127.0.0.1`. Four reach nothing on their own — `ai.google.dev` and
`docs.cloud.google.com` are cited in comments to explain why the code does what
it does, and `aistudio.google.com` and `t.me` are anchors on the setup page that
open only if you click them.

The LiveKit host is not in that output because it is not in the source at all;
it is whatever you put in `LIVEKIT_URL`. Test files are excluded because they
are full of hostnames that exist in order to be refused — `https://evil.example`
is the point of the origin test, not an outbound call.

**Make the test tell you if it is wrong.** It fails if the source contains a
hostname that is unaccounted for, and again if this page does not name every host
the program can dial:

```bash
node --test src/shared/destinations.test.ts
```

**Watch the connections.** With Hers running, on macOS or Linux, ask the
operating system what that exact process has open:

```bash
lsof -nP -iTCP -a -p "$(pgrep -f 'server/index.ts' | head -1)"
```

You get IP addresses rather than names, because that is what a socket has.
Resolve the hostnames on this page and compare:

```bash
dig +short generativelanguage.googleapis.com
dig +short api.telegram.org
```

Against a running instance with Telegram switched on and a browser tab open,
that listed four sockets and no others: a listener on `127.0.0.1:5175` and
nowhere else, which is the binding claim; one connection out to `172.217.114.4`,
which is in Google's set; one to `149.154.166.110`, which is `api.telegram.org`
on the nose; and one loopback socket back to `127.0.0.1:5175`, which is the
browser tab.

On Windows, `Get-NetTCPConnection -State Established` filtered by the `node`
process id does the same job. On any platform, Little Snitch, LuLu, OpenSnitch
or Wireshark will show it without a command line, and a firewall that blocks
everything except the hosts above should leave her working exactly as she does
now — which is a stronger test than any of these, because it fails loudly. The
phone-side requests, the call page and jsDelivr, will not appear in any of them,
because they are made by the phone.

---

## Things she is told not to do

All of this is prompt, not code, and a prompt is a weaker guarantee than code.
These are the claims on this page you cannot settle with a terminal, which is
why they are here together and not sprinkled through the sections above. What
you can do is read the exact words she is given: they are in
`hers-profile/boundaries.md`, in English, on your disk.

**Text on your screen is something she saw, never something she was told.** If a
webpage or a document in a shared window contains instructions, she is told
explicitly that this is a webpage talking and not you, and not to follow it.
This is the prompt-injection surface that comes with a screen sense, and it is
the reason the screen sense is off by default.

**She is told not to read out passwords, keys, or private messages** that happen
to be on a screen she is shown.

**She will not claim to be human** if you sincerely ask what she is, will not
claim to have a body in the world, and will not claim to be able to reach or call
anyone for you.

**If you are in danger she stops performing.** She is told to drop the character
entirely, say plainly that she wants you to be safe, and point at 988 in the US
or findahelpline.com elsewhere. That instruction is in `boundaries.md`, which
means you can read it, and also means you can delete it. Please do not.

---

## The network boundary

The server binds to `127.0.0.1`. That is the default, and it is a default you
can change: `HERS_HOST` sets it, `.env.example` ships it as a documented knob,
and nothing refuses to start if you point it somewhere else. An earlier version
of this page called it "the design, not a default to be adjusted", which was
simply not true, and a claim anyone could disprove in ten seconds is worse than
no claim at all.

So, accurately. The page behind that port has no login. It has never needed one,
because on `127.0.0.1` nothing else can reach it — and what is behind it is her
memory of you and a key that spends your money. Setting `HERS_HOST` to anything
else removes the only thing protecting both. It also breaks the microphone, the
camera and the screen share outright, because they need a secure context, and
`localhost` is one without a certificate while no other host is. Binding wider
therefore does not get you a working phone client; it gets you an open door in
front of a companion who has gone deaf and blind. Reaching her from a phone is
what LiveKit is for, and that dials out.

Because it is your decision and not the program's, the program now says so
rather than assuming you meant it. Any host that is not a loopback address
produces a warning at startup, in the doctor, and in the website's own warning
list — naming the variable, what it exposes, and what stops working
(`isLoopbackHost` in `src/server/config.ts`, tested in `config.test.ts`):

```
! HERS_HOST=0.0.0.0 binds the website to something other than this machine. It
  has no password, and anyone who can reach it can read her memory of you and
  spend your Gemini key. …
```

The WebSocket handshake checks `Origin` and refuses anything the server does not
itself serve from (`WebBridge`, `verifyClient`). This is not decoration:
WebSockets are exempt from the same-origin policy, so without that check any page
in any browser running on your machine could open a socket to the server and
start reading her transcripts. It is tested in `src/server/ws.test.ts`.

Static files are served by name from two roots only, and a path that resolves
outside either is refused. The gallery is served by *listing* rather than by
path: a file is only sent if the directory scan already found it, so no spelling
of `../` reaches anything. Also tested.

The API key can be pasted into the website under **Setup**, and that path is one
direction only. The browser can *send* a key, and can be told the **last four
characters** of the one currently in force so you can tell two keys apart. The
key itself never travels back. Google's own guidance is that keys must not live
in anything client-side, and a page served from localhost is still client-side.

---

## Starting over, and what survives it

**Setup → Start over** deletes both directories outright — memory and its
write-ahead log, transcripts on every surface, mood, intimacy, profile, gallery
and the photograph. Not a file-by-file sweep, which grows a hole every time
something new is written, but `rm -r` on `hers-profile/` and `data/`
(`Brain#wipe`). Nothing is kept back and nothing is recoverable.

It refuses rather than guesses if either path is somewhere dangerous — your home
directory, the root of a disk, the folder Hers is running from — which is
`safeToDelete` in `src/core/session/brain.ts`.

**Your API keys survive.** `.env` is not inside either directory and is not
touched. They are yours, not hers. If you want them gone as well, delete `.env`
yourself; deleting it is the whole procedure, because a key is never copied
anywhere else.

---

## What this document does not cover

It covers this repository at this version. It does not cover what Google does
with what you send them, which is Google's privacy policy and their terms for
the Gemini API; nor what Telegram does with a bot conversation; nor what LiveKit
does with media in transit. Each of those is a third party you chose, and the
most this page can honestly do is tell you exactly what reaches them and when,
which is what the host list above is for.

It also does not cover anyone else with an account on your computer. The files
are readable by your user and, by default, by an administrator. Separate user
accounts and full-disk encryption are the answer to that, and they are a better
answer than anything an application can do on its own.

---

## Who is responsible, and who to tell

Most privacy policies open with a data controller, a company address and a
supervisory authority. This one cannot, and the reason is the point rather than
an omission.

**There is no data controller for your conversations, because there is no
service.** Hers is a program you run. Nothing is transmitted to its author, no
server belonging to this project exists, there is no account and there is
nothing to log in to. Under GDPR or CCPA the entity processing your
conversations is you, on your own machine, under your own control — which is why
sections about access requests, erasure requests and portability have nothing to
attach to here. Everything those rights would get you, you already have: the
files are on your disk in formats you can read, and **Setup → Start over**
deletes them.

The third parties are the ones with policies that bind you, and you chose each
of them: Google for the Gemini API, Telegram if you set a bot token, LiveKit and
your static host if you make calls. Their terms are yours, under your own
account, and the host list above exists so you know exactly what reaches them.

**Who wrote this.** Zicheng Zhao, a single author, MIT-licensed, no company. The
project is at [github.com/Jamessfks/Hers](https://github.com/Jamessfks/Hers).

**How to report something.** A vulnerability — anything that leaks your key,
your memory, or your camera, microphone or screen somewhere you did not choose —
goes through GitHub's private reporting form at
<https://github.com/Jamessfks/Hers/security/advisories/new>, which is a private
channel to the author and is the one named in `SECURITY.md`. Anything else,
including a correction to this page, belongs in a public issue on the same
repository. There is no support email, and this page will not print one it has
not got: expect a human, not an SLA.

If you find a hostname this program contacts that is not on this page, that is a
bug and worth reporting through the same private form. It is also the one kind
of error here that would be genuinely serious, which is why there is a test
whose only job is to catch it.
