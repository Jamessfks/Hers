# Changelog

Versions follow [semver](https://semver.org). Anything that changes a name you
have already typed into a config file — an environment variable, a folder, a
model — is a breaking change and gets called out here with what to do about it.

## Unreleased

**The camera light cannot be made to lie.** The sense buttons were drawn from a
WebSocket message, so anything that reached that socket could darken the sight
indicator and hide the self-preview while the camera stayed open and frames kept
going to Google. They are drawn from `MediaStreamTrack.readyState` now — the
device's own account, read-only per the specification — and a claim that
contradicts the hardware is refused in both directions.

**The WebSocket requires an `Origin`.** It used to accept a connection that sent
none, reasoning that a page always sends one. True, and it does not follow: any
other process on the machine could find the port and read the last forty turns,
every stored fact, her mood and the key hint, then send back `say`,
`memory.forget`, `intimacy.pin` and `profile.save`, which rewrites the
instruction she is built from. `HERS_ALLOW_HEADLESS=1` for anybody writing their
own client.

**The first run cannot end on nothing.** "Meet her" holds the wake until the
server echoes back the profile the wizard just wrote, so her first system
instruction is built from the new folder rather than the one it replaced. That
wait had no timeout: a dropped socket between the save and the echo ended the
ceremony on a focused button and no explanation. It now gives up after eight
seconds and says so, rather than waking anyway — guessing on the one conversation
where she chooses her own name is not a trade worth making.

**Smaller things.** `hers.log` is created owner-only; it carries no credential but
it does carry your account name in the paths and the pinned Telegram chat id, and
that is a reason to keep it rather than a reason to leave it world-readable. The
two tests that check every host and every written path carries an explanation used
to accept `"x."` — a punctuation check dressed as a documentation check. They ask
for a sentence now, which immediately caught three of this project's own entries
being too thin to be useful.

**Nothing is fetched from a CDN any more.** The call page imported LiveKit's
client from `cdn.jsdelivr.net` at run time. That was the hardest outbound request
in this project to notice, because the *phone* made it — so the "unplug your
network and watch" check this project invites people to run would have come back
clean. `livekit-client` is a devDependency now, pinned in the lockfile, and the
build copies it in beside the page. One fewer party in the call path, and the
list of hosts this program can reach is one shorter.

## v1.4.0 — 28 August 2026

**Every host she can reach, and every file she writes, in a list the tests hold
her to.** `docs/PRIVACY.md` was rewritten to be checkable rather than
reassuring: the exact paths on each platform, every outbound hostname and what
triggers it, what is held only in memory, and commands a reader can run to
confirm all of it. `npm test` now fails if the program can dial a host, or write
a file, that the document does not name — so the page is not an assertion, it is
something the build will not pass without.

That turned up `cdn.jsdelivr.net`, which the phone's call page then fetched
`livekit-client` from before a call starts. It was documented nowhere, and it is
invisible to a network monitor on the machine Hers runs on, because that machine
is not the one making the request.

It also corrected this page's own earlier claims. The privacy document had
promised "No access to your files", which was never true of **Setup → Let her
read your files**; had said the two folders "are not in an application-support
directory", which the desktop build made false; and had described the loopback
bind as "the design, not a default to be adjusted" when `HERS_HOST` is exactly
that. A non-loopback bind now warns loudly at startup, in the doctor, and in the
website.

**A first run that is about her.** The first time the page opens on a profile folder
nobody has used, a wizard asks seven questions — one for each of the six files in
`hers-profile/`, in the order the editor shows them, and a seventh for the photograph.
Every step skips, and skipping writes nothing: take the shortest path through it and the
folder is byte-for-byte the one that ships, plus the date under `met:` in
`relationship.md`. Closing it or pressing Escape keeps whatever was answered so far.

Every choice shows the exact sentence it will put in her file, and that sentence is what
gets written — into the prose, where Gemini reads it, rather than as an adjective in a
header nothing reads. The three headers that *are* read get written properly:
`identity.md` for age and where she is from, `voice.md` for the voice, `mood.md` for the
five numbers behind a temperament. Changing where she is from now rewrites the paragraph
that says where she is from, so the header and the biography cannot disagree; changing
her age leaves that paragraph alone and rewrites the sentence about her age.

Card five asks the thing the product had machinery for and no question about: what she
does with the days you are not here. Card three offers four voices described in a line
each rather than fourteen of Google's satellite codenames — the full thirty are still on
the voice tab of **Who she is**.

It does not ask her name. She still chooses that herself on the first conversation, and
the last card is about why — it carries the Gemini key, which is the only question in the
whole flow that is not about her, and its button wakes her. The wizard ends on her first
sentence and the name she picks, rather than on a wake button and a note about
scheduling. Nothing else in the app wakes her without being asked, and Escape and Close
still do not.

Nothing is drawn where her name goes until there is a name. The page shipped the
placeholder in its markup and printed `Anna` in the header and the tab title from the
first frame, so the card explaining that she has not chosen one was displayed under the
name it says she does not have.

Fresh is three things, not one: she has not named herself, memory holds nothing at all,
and `met:` is still the sentence it ships with. Deleting everything under **Start over**
makes a folder fresh again, and the wizard comes back with it.

**She is a download now.** `npm run package` builds a double-clickable
application — a `.dmg` on macOS, an NSIS installer on Windows once somebody
runs that build — with Electron
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

**The build is not signed**, and the README says which two clicks get past
Gatekeeper rather than pretending the warning is not there — plus the `xattr
-dr com.apple.quarantine` line, which cannot fail and which the first draft of
that page left out. It *is* ad-hoc signed, which is a different thing and the
reason macOS says "unverified developer" rather than "damaged": an unsealed
bundle fails verification outright, and that message is unrecoverable advice.
Install to `/Applications` — anywhere else, App Translocation runs a quarantined
app from a randomized read-only copy of itself and the exception you granted
does not stick.

**`npm run package` produces one artifact: `Hers-1.4.0-arm64.dmg`, 127.5 MiB, 294 MB
installed. It has not been published — the releases page carries source tags and no
binaries, so there is nothing to download yet.**
Windows and Intel Mac are configured and have never been compiled or run.
LiveKit's binding is a per-architecture package that `npm install` picks for the
machine doing the installing, so each artifact has to be built on its own
machine; a Windows installer built on a Mac would carry a macOS `.node` and fail
on the first import. `.github/workflows/release.yml` does one runner per
platform on a tag, and it has never run either.

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
