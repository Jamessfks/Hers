# Changelog

Versions follow [semver](https://semver.org). Anything that changes a name you
have already typed into a config file — an environment variable, a folder, a
model — is a breaking change and gets called out here with what to do about it.

## Unreleased

**She is a download now.** `npm run package` builds a double-clickable
application — a `.dmg` on macOS, an NSIS installer on Windows — with Electron
carrying its own Node inside it. Eleven steps became three, and the three hard
gates went: no Node to install, no git, no terminal. The same server, the same
page, the same everything, in a window that opens itself.

Nothing about running her from a clone changed. `npm start` still serves on
5175 out of `hers-profile/` and `data/` beside the code, still reads and writes
`.env` there, and an install that works today goes on working.

**Where the application keeps things**, because it cannot keep them beside
itself — macOS puts an application inside a read-only signed bundle and Windows
puts it under `Program Files`, and an upgrade replaces both:

| What            | macOS                                             | Windows                       |
| --------------- | ------------------------------------------------- | ----------------------------- |
| Profile         | `~/Library/Application Support/Hers/hers-profile` | `%APPDATA%\Hers\hers-profile` |
| Memory          | `…/Hers/data`                                      | `%APPDATA%\Hers\data`         |
| Keys            | `…/Hers/.env`                                      | `%APPDATA%\Hers\.env`         |
| Log of last run | `…/Hers/hers.log`                                  | `%APPDATA%\Hers\hers.log`     |

`HERS_PROFILE` and `HERS_DATA` still win over all of it, which is the point: an
existing install is not orphaned by installing the application, and pointing the
application at a clone's folders is how you move. Nothing is migrated
automatically, because guessing which of two profile folders is the real person
is how somebody loses her.

**New:** `HERS_ENV_FILE`, which is where the Setup panel writes the key. It
defaults to `.env` and exists because the application needs somewhere writable
that is not next to the executable. That was the subtle half of this work: a
first run that ends at "paste your key" and then cannot store it is a first run
that is also the last one.

**The LiveKit binding is loaded only when calls are configured.** It was
imported unconditionally before. Inside the application that meant a second copy
of WebRTC alongside Chromium's, registering nine Objective-C classes under names
Chromium had already taken, which macOS warns "may cause mysterious crashes".
Nobody who has not set up LiveKit is exposed to it now.

**The builds are not signed**, and the README says which two clicks get past
Gatekeeper and SmartScreen rather than pretending the warning is not there. They
*are* ad-hoc signed, which is a different thing and the reason macOS says
"unverified developer" rather than "damaged" — an unsealed bundle fails
verification outright and that message is unrecoverable advice.

Published builds are Apple Silicon and Windows x64. Intel Macs have no build
yet: LiveKit's binding is a per-architecture package that `npm install` picks
for the machine doing the installing, so each artifact has to be built on its
own. `.github/workflows/release.yml` does that, one runner per platform, on a
tag.

## v1.3.0 — 27 August 2026

**A voice menu.** Fourteen prebuilt Gemini voices, each with Google's own one-word
description of how it sounds — `Sulafat — Warm`, `Algenib — Gravelly`,
`Achernar — Soft` — on the **voice** tab of **Who she is**. Picking one writes it
into `voice.md`, so it is still a file you can edit by hand, and the menu reads
back whatever is in that file. She picks it up the next time she wakes, because
a Live session fixes its voice at setup.

Fourteen and not thirty because she is a woman, and those are the ones Google
labels female. The other sixteen are still accepted if you type one into
`voice.md` yourself — narrowing the menu must not quietly reset a profile that
already chose one — and a voice the file names that the menu does not offer is
shown in the menu anyway rather than hidden behind a name it never chose.

Google publishes that label on Cloud Text-to-Speech's pages for the same thirty
names, not on the Gemini page, which lists only a name and a character word.
Verified against the raw table on two of its pages, which agree.

The voice list and the frontmatter parser moved to `shared/`, so the browser and
the server read one copy rather than two.

**`sendClientContent` mid-session is confirmed to work.** v1.2.0 shipped with
this question open. The answer, measured: it arrives on
`gemini-3.1-flash-live-preview`, with and without the
`initialHistoryInClientContent` mode Google documents, and the control arm that
was never seeded says "I do not know". So her mood updates, sense changes,
photograph and the `⟦director⟧` cue behind the three-minute rule all reach her.

Still undocumented, and `npm run probe:client-content` stays runnable for the day
Google enforces what its guide says. Also measured: 3.1 Flash Live refuses `TEXT`
as a response modality outright.

## v1.2.0 — 27 August 2026

Nothing she does changed. Everything written about what she does did.

**The documentation now says what the code does.** Every factual claim in the
README, PRIVACY, TROUBLESHOOTING and `.env.example` was checked against the code
that implements it. Seven disagreed. The one that mattered: PRIVACY.md promised
"No access to your files, your email, your calendar, or your browser history",
while **Setup → Let her read your files** has always read the folders you tick
and sent excerpts to Google to be distilled. The README described that feature
honestly; the privacy page contradicted it, which is the worst direction for a
contradiction to point. It is now scoped to what happens, the upload is listed
in the table of what leaves the machine, and two files the page never mentioned
— `intimacy.state.json` and `knowledge.json`, which records the absolute paths
of folders you approved — are listed too.

Also corrected: she has four tools and not three (`recall` shipped in v1.1), the
test count was 382 and is 414, the gallery has always accepted `.jpeg`, `.gif`
and `.mov`, and `GOOGLE_API_KEY` has always worked as an alias for
`GEMINI_API_KEY` and was documented nowhere.

**Comments sit above the code they describe again.** The same editing mistake had
happened six times — a new declaration pasted in above an existing one, leaving
the older declaration's comment stranded above it, describing something else.
The worst was in `gallery.ts`, where a stale block ending "the newest gallery
image is kept only as the fallback" sat directly above the block explaining that
the fallback had been removed and why. In `protocol.ts` the same thing at the
level of a union: four comments above four members in exactly reverse order.

Three comments cited things that do not exist: a `move` tool that went with
Hedra, an `HERS_LIVEKIT_*` variable that never existed, and
`docs/adr/0002-memory-storage.md`, along with a rationale about Electron ABI
bumps inherited from a different codebase. This has never been an Electron app.

**New:** `CHANGELOG.md`, `SECURITY.md`, `.editorconfig`, licence and version
badges, and a table of contents. `npm run probe:client-content` asks whether a
mid-session `sendClientContent` still reaches her, because Google documents that
channel as startup-only on the default model and five of her behaviours depend
on it. That question is **open** — the answer needs an API key that is not over
its spending cap.

**Removed:** `RecallQuery`, imported by nothing. The web UI's second copy of the
list of three senses. A real Telegram chat id from a test file — it is not a
credential, but it did not belong in a public repository.

## v1.1.0 — 19 August 2026

**She can look things up.** A `recall` tool, so a question about something you
told her weeks ago goes to her memory instead of to whatever she can infer.
Measured live across two isolated sessions: eleven lookups, no question answered
without one, and two answered from facts that were provably not in her prompt.

**She stopped interviewing you.** Turns used to end on a question 71% of the
time, which reads as an interrogation rather than a conversation. A turn now
ends on something she wants, an opinion, or a noticing, and no question two
turns running. Question load fell to 15%.

**The first thing she ever says is now something she wants.** First-turn
questions went from 10 in 24 openers to 2; openers that lead with a want of her
own went from 3 in 24 to 24 in 24.

**One Gemini key, and nothing else.** Hedra is gone. Her expressions are
generated on Gemini's image model instead, which removed a second credential, a
job queue, a resume path, and an external spend ceiling.

**Telegram set up from the website.** Setup takes the token, checks it with
Telegram, starts the bot without a restart, and fills in the chat id once you
have opened the chat.

Fixed:

- Two callers asking her name at once could produce two different names.
- A chosen name was verified against a profile another caller might have
  replaced, rather than the one actually read back.
- A fact cut off mid-sentence was stored as a fact — `"The user"`, two words,
  ranked first on six recalls.
- Every `AvatarStudio` shared one `faces` object, so an expression made in one
  appeared in all of them.
- `npm run check` did not typecheck `scripts/`, so the audit could break while
  the check passed.

Documented: unsetting `TELEGRAM_BOT_TOKEN` to run a second copy does the
opposite of what it looks like — `process.loadEnvFile` only skips keys already
present, so the real token loads from `.env` and a second poller starts stealing
your bot. Use an empty value instead.

## v1.0.0 — 17 August 2026

First public release, and the rename from Anna to Hers.

She sees your screen, sees you through the camera, hears you, remembers in a
local SQLite file, and speaks first. Her personality is six markdown files you
can edit. She chooses her own name on the first conversation, once, permanently.
Closeness runs 1% to 80% over 1,460 days of turning up and cannot be bought or
talked into.

### Upgrading from a pre-1.0 install

`ANNA_*` environment variables became `HERS_*`. The old names still work — the
config reads `HERS_*` first and falls back to `ANNA_*`, and warnings name the
variable you actually set, so they point at a line you can edit.

The profile folder `anna-profile/` became `hers-profile/`. Hers renames it for
you on first run, but only when the destination does not already exist; if both
are present it leaves them alone rather than guessing which one is yours. Both
names stay gitignored.
