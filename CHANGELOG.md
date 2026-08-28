# Changelog

Versions follow [semver](https://semver.org). Anything that changes a name you
have already typed into a config file — an environment variable, a folder, a
model — is a breaking change and gets called out here with what to do about it.

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
