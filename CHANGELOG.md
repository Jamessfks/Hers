# Changelog

Versions follow [semver](https://semver.org). Anything that changes a name you
have already typed into a config file — an environment variable, a folder, a
model — is a breaking change and gets called out here with what to do about it.

## Unreleased

Filled in as v1.2 lands.

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
