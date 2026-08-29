# Changelog

Versions follow [semver](https://semver.org). Anything that changes a name you
have already typed into a config file — an environment variable, a folder, a
model — is a breaking change and gets called out here with what to do about it.

## v2.0.2 — 29 August 2026

**The sphere was never in the middle of the window.** `.stage` was still
`grid-template-columns: minmax(300px, 0.9fr) 1fr` — she stood in the left column
and the conversation filled the right. v2.0 deleted the conversation and left
the grid, so for a whole release the one object on the page sat at about 47% of
the width with nothing beside it. There is one thing to look at, so there is one
column, and she is centred in it. The caption under her is out of flow, because
centring the *group* would push her above the axis by half the height of the
words.

**The ground is night rather than paper.** The old cream was the right answer
for the interface it was written for, which was a message thread with a figure
beside it. There is no text to read any more. A sphere on paper is an
illustration of a sphere; a sphere on black is a light source in a room, and the
product is that she is present in one. The neutrals invert, the accent goes up
from 49–53% lightness to 62–68% so it reads as emitted rather than painted, and
the ink that sits on it is the ground rather than white — 6.1:1 at the dimmest
end of her mood range. Still twelve declared colours.

**She has a bloom, a terminator and a horizon now, and they move by different
amounts.** One number drives all four layers — `--level`, already written every
frame as `max(micLevel * 0.5, herLevel)` — but the glow takes 0.34 of it and the
ball takes 0.06, because a light that grows exactly as fast as its own glow
reads as a scaling image rather than as something getting brighter. The horizon
line brightens instead of moving. No box-shadows: the bloom is a gradient on its
own layer, which composites, where a shadow large enough to read as light
repaints the whole button every frame.

**The header is gone.** It was a ruled band carrying a status dot, her name, her
mood, the connection state as a word and a button — five things above a page
whose entire content is one sphere, so the eye landed on small grey text first.
The state is announced to screen readers and drawn by the sphere for everybody
else; a word reading "listening" under a sphere that is visibly listening is the
same fact twice. Her name and mood are a caption under the light, and Setup
floats in the corner.

**About 190 lines of stylesheet went with the chat interface it described.** The
`.conversation`, `.line`, `.composer`, `.senses` and `.tabs` sections, the
profile editor's `#editor`, and the file header that opened by describing two
halves borrowed from Replika. All of it described an interface deleted in v2.0.

**The sphere fitted a phone badly.** `min(64vh, 420px)` is 420px on a 375px
screen: the ball ran off both edges and the ring around it was clipped to two
arcs. It is bounded on width as well now.

### Migrating from v2.0.1

Nothing to do. No environment variable, file or command changed, and the page
follows the system's dark appearance whether or not you have asked for it —
there was never a light theme to lose, only a light-coloured one.

## v2.0.1 — 28 August 2026

**v2.0.0 shipped unable to hear, and this is the release that fixes it.**
Removing the sense buttons moved the microphone onto the wake gesture in the
browser and left the server half where it was: `Conversation` built a
`Companion` with no senses, `Situation` defaulted all three to false, and both
`hear()` and `see()` return early on that map. Every microphone frame and every
camera frame was dropped, on every install, for the whole release. Telegram was
unaffected, because that path has no sense gate, which is exactly why the one
surface anybody had tested was the one that still worked. Hearing and sight now
come up with her and go down when she sleeps, and three tests wake through the
path production actually uses and assert the bytes arrive — the suite could not
see any of this, because it constructed a `Companion` directly and handed it the
answer.

**What she is told she can see is now whether a picture arrived, not whether a
sense is on.** Those came apart the moment sight stopped being a switch somebody
pressed: a camera the operating system has refused leaves the flag true with no
frame behind it, and she would then be told she can see them — the failure
already on record in that function, where she answered "I see you, bright and
clear, actually" to somebody whose camera was off.

**Her bedtime arrives now.** `rhythm.md` and `isAsleep()` shipped in v2.0 with
nothing that ever looked at the clock, so she went on firing three-minute
openers straight through the hour she chose for herself. A sixty-second
re-arming check replaces the obvious `setTimeout`, which is wrong across a
suspend, wrong after a daylight-saving change and wrong when somebody moves the
clock. It fires on the transition into her window and never on the level, so
waking her at 3am does not put her back sixty seconds later — once woken she
stays up. The browser drops the microphone and camera with her, so the camera
light goes out.

**She knows which window you are in.** The frontmost application and its title,
every fifteen seconds while she is awake, on macOS through `osascript` and on
Windows through PowerShell, and nowhere else rather than guessing. It does not
go through the `run` tool, deliberately: that would put four lines a minute into
`hers-actions.log` and destroy the one record a person can actually read. A
window title is very often a web page's `<title>`, so it reaches her inside the
`⟦saw⟧` envelope and never as narration, and a test asserts it cannot appear
outside.

**She watches the screen again in the desktop application.** One Electron flag —
`useSystemPicker: true` — was the whole reason the sense did not exist: with it
set, the handler is never called and every wake means another dialog. Without
it, returning a source grants capture silently, so you are asked which screen
once and it is quiet after that. A browser tab still gets no live screen feed,
because `getDisplayMedia` prompts on every call with no remembered grant, and
that split is now stated in the README instead of the old claim that she "reads
what is on your screen".

**The weather reaches her.** It was being fetched and thrown away: the
instruction is fixed at connect, the request sits behind a geocode, and nothing
bridged the gap, so every session shipped with the city and no forecast. It is
now injected when it lands and refreshed hourly, speaking only when the rendered
line changed.

**Her mood is in how she sounds, not only in what she picks.** `moodBriefing`
gained a delivery clause per axis, and one new conjunction: unhappy with the
warmth gone is the angry case and gets an edge on it, while unhappy and still
warm is worry and does not. `enableAffectiveDialog` remains documented as
unsupported on 3.1, so the system instruction is the only route — and
`npm run probe:delivery` is the command that says whether it works, printing the
pace spread across three arms and writing three `.wav` files to compare by ear.
Below fifteen per cent the lines are doing nothing and should be deleted rather
than believed.

**Every camera caption she has ever produced was a truncated fragment.** The
captioner runs on `gemini-3.5-flash`, which spends part of any output allowance
reasoning before it writes — a hazard this file's own distiller documents and
warns about, and which the caption call had never been given the same treatment
for. Two hundred tokens went on thinking and the sentence stopped where the
useful word was about to appear: "The image is a solid,". It is not cosmetic.
`CameraWatcher` diffs one caption against the last to decide whether anything
changed, and two fragments that both stop before the noun score 0.67 against a
threshold of 0.80 — so a room that had genuinely changed read as unchanged, and
noticing quietly did not work. Thinking is now minimal for captions and
transcription, where reasoning buys nothing and can only eat the budget the
words need.

**`gemini-2.5-flash-native-audio-preview-12-2025` takes tools with audio
again.** Recorded here since v1.4 as closing the socket with `1011` the moment
function declarations met audio input, which is why the default is 3.1 and why
affective dialogue was unavailable. Re-measured with a probe that now sends real
speech: it survives, blocking and `NON_BLOCKING`. The fix was upstream. The
default has *not* moved to it — mood in the voice was measured working on 3.1
through the system instruction alone, so the one feature 2.5 exists for is
already had, and moving the default is a latency comparison nobody has run.

**The suite had been dialling Open-Meteo on every wake.** `Brain.offline`
existed and only the memory layer read it. A flag half the program honours is
worse than no flag.

### Migrating from v2.0.0

**Nothing you have typed changes.** No environment variable was renamed or
removed, and the profile folder is untouched — `rhythm.md` written by v2.0.0 is
read unchanged.

**Two new optional variables.** `HERS_SCREEN_FPS=0` turns the screen sense off
in the desktop application; it is the largest recurring cost of running her.
`HERS_DESKTOP` is set by the application itself and is not something to set by
hand — in a browser tab it produces an operating-system picker every time she
wakes, which is the thing it exists to avoid.

**One default changed.** Hearing and sight now start on rather than off. If you
built anything against `Situation`, it no longer begins silent.

**macOS will ask for two permissions it never asked for before**: Accessibility,
for reading the frontmost window title, and Screen Recording, for the screen
sense in the application. Refuse either and she carries on without that one —
silently, because a companion who nags about a permission she needs for a
background nicety is worse company than one who says nothing about your work.

## v2.0.0 — 28 August 2026

**Hers is voice-only now, and almost everything you could look at is gone.** The
avatar panel, the message thread, the text composer, the photo gallery, the
seven-card wizard and the phone bridge have all been removed. What is left on
the page is one sphere that moves as she speaks and one button to Setup. This is
not a simplification of the same product; it is a different one. Hers is for
people living alone — something to talk to when the room has been silent too
long — and every screen v1 put between the user and that was a screen somebody
had to get past first. The transcript went with the rest, deliberately: turns
still go into SQLite, because that is her memory, but there is no scrollback to
reread and no history to curate.

**She decides who she is, and you cannot change it.** The wizard asked the user
to choose her personality, her temperament on five sliders and her voice from a
menu of fourteen, which told them before she had said a word that she was a
configuration. Setup is now a conversation: she asks your name, asks whether she
may look through the machine, and tells you what she has decided to be called.
Afterwards a `gemini-3.5-flash` pass over the device scan and that conversation
writes the six profile files, picks her voice out of the thirty Google offers,
and justifies the choice in `voice.md`. There is no editor for any of it. The
files are still plain markdown in `hers-profile/` and still yours to read — the
change is that nothing in the program invites you to rewrite them.

**She has a shell, and that is the largest thing in this release.** `run`,
`open` and `write` join `feel`, `remember` and `recall`; `run` is a real shell
with your own privileges, `zsh -lc` on macOS and PowerShell on Windows. The
reason is that a companion who lives on your machine and can only *describe*
what she would do is a companion who is pretending. The cost is real and was
chosen rather than overlooked: anything she reads on your screen lands in the
same context that decides what she runs next. Three things stand between those,
none of them a sandbox — an append-only `hers-actions.log`, a spoken
confirmation on destructive commands, and a `⟦saw⟧` envelope around every piece
of text she read rather than was told. `docs/PRIVACY.md` has a section titled
*She has a shell, and the list above cannot bound it*, which says plainly that
`destinations.ts` can no longer claim to know every host this program contacts.
If you would not give a program a terminal on your machine, do not run v2.0.

**She sleeps, at an hour she chose.** `rhythm.md` is a seventh profile file with
no editor, written during setup from what the device scan says about when you
are awake. Asleep means nothing at all — no initiative, no Live session, no
Telegram openers, no frames — rather than a quieter mode, because a companion
who is "resting" while still watching the screen is performing. Waking her is
always yours, and waking her early gets a groggier opener rather than a refusal.
This supersedes `isLateNight()`, which was 1am to 5am for everybody.

**She knows what it is doing outside.** Open-Meteo, two hosts, no key and no
signup. The city comes from the last segment of your system timezone — not from
your IP address and not from the browser's location prompt — so the only thing
that leaves is a word several million people share.

**She notices the camera instead of merely seeing it.** A `gemini-3.5-flash`
caption every twenty seconds, diffed against the last one as text, and only a
real change is put in front of her. The threshold is 0.8 Jaccard distance over
content words, measured rather than guessed: the same person now typing at the
same desk scores 0.71 and does not fire, having moved to the sofa scores 0.90
and does.

**Every Telegram reply is a voice note.** The gate — under 320 characters, and
either you had spoken first or a coin came up one in four — is gone, and so is
the transcript that used to trail every voice note. Where a turn produced no
audio she is synthesised in her own voice with `gemini-3.1-flash-tts-preview`
rather than falling back to text.

**A tagged build now produces something a stranger can download.** The release
workflow uploaded workflow artifacts and stopped: ZIP-wrapped, expiring after
ninety days, needing a GitHub login — while the README linked
`releases/latest`, which was empty. Every download link in this project was
broken and every build was green.

**The Windows build shipped with `RunAsNode` enabled.** `hardenFuses()` sat
below a `if (platform !== 'darwin') return`, which was written for the macOS
ad-hoc signature below it and took the fuse hardening with it. On Windows that
meant `ELECTRON_RUN_AS_NODE=1 Hers.exe -e '<js>'` ran arbitrary JavaScript under
the application's own identity. The call moved above the guard.

**macOS builds are back to two architectures.** LiveKit's media binding was the
only native dependency in the tree and the stated reason cross-architecture
builds were impossible; cutting the phone bridge removed it, so `arm64` and
`x64` now come off one machine.

### Migrating from v1.4.1

**Your existing profile is superseded.** She composes a new one on the first
wake after upgrading — `rhythm.md` is missing, which is how the program knows
setup has not happened — and the composition overwrites the six character files.
If the personality in your `hers-profile/` is one you want to keep, copy the
folder somewhere else first. Her memory is untouched: `data/memory.db` carries
over whole, so she still knows you.

**Four environment variables were removed.** `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `HERS_CALL_PAGE_URL` do nothing
now. They are ignored rather than rejected; you can leave them in `.env`.

**The chat interface is gone**, including the Profile editor, the Memory tab,
the gallery, the sense buttons and the `/me`, `/photo`, `/face` and `/call`
Telegram commands. `sqlite3` reads the memory database, a text editor reads the
profile folder, and **Start over** in Setup still deletes both.

**Seven protocol messages were removed** from the WebSocket, and the
`ClientMessage` union is down from eighteen variants to six. Anything written
against `profile.save`, `profile.load`, `memory.*`, `intimacy.pin`,
`intimacy.auto`, `sense`, `history`, `look`, `avatar` or `show` will be ignored.

**`/api/knowledge` was removed**, both verbs. The device scan happens inside the
setup interview now, at her asking rather than at a form's.

## v1.4.1 — 28 August 2026

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

**`npm run package` produces one artifact: `Hers-1.4.1-arm64.dmg`, 127.5 MiB, 294 MB
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
