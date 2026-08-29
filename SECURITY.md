# Security

Hers runs on your own machine and holds more of your private life than most
programs you install. This is what is sensitive, where it lives, and what to do
when something goes wrong.

## What is sensitive

**Your Gemini API key.** Billed to you, and anyone who has it can spend your
money. It lives in `.env`, which is gitignored.

**Your Telegram bot token, if you set one.** This is the one worth
understanding. A bot token is a bearer credential on a *public* endpoint —
Telegram will hand your bot's messages to whoever holds it, and anyone who finds
your bot can message it. Her memory is your private life, so
`TELEGRAM_ALLOWED_CHAT_IDS` is not a nicety. Until you set it she pins herself
to the first chat that speaks to her and ignores everyone else.

**Whatever a command she ran had access to.** Since v2.0 her `run` tool is a
real shell with your privileges, so a compromise of her context is a compromise
of anything you can reach from a terminal. `hers-actions.log` is the record of
what she actually did.

**Her memory.** `data/memory.db` is a plain SQLite file holding everything she
has been told. It is gitignored. It is also readable by anything else running as
you — it is not encrypted, and this project does not claim it is.

**Her profile folder.** `hers-profile/` may contain a photograph of a real
person. It is gitignored under both its current name and the legacy
`anna-profile/`, because dropping the old line would quietly start offering that
photograph to `git add`.

## What the server exposes

The web UI binds to `127.0.0.1` by default. That is deliberate: it is a local
page with no authentication, and anything reachable on your network could read
her memory and spend your key. `HERS_HOST` will let you change it. Think about
what you are doing before you do.

The camera, microphone and screen share need a secure context. `localhost`
counts as one without a certificate; another host does not.

## If you have leaked a key

- **Gemini:** revoke it at <https://aistudio.google.com/apikey>, then issue a new
  one. Check <https://ai.studio/spend> for usage you did not make.
- **Telegram:** send `/revoke` to [@BotFather](https://t.me/BotFather), then
  `/token` for a fresh one.
- **Anything a command touched:** read `hers-actions.log` first — it is
  append-only and holds every invocation, including the refused ones.

A key committed to git is still in the history after you delete the line. Rotate
it; do not only remove it.

## Reporting a vulnerability

Please report privately rather than in a public issue, through GitHub's private
reporting form:

<https://github.com/Jamessfks/Hers/security/advisories/new>

This is a single-author project, not a funded program — expect a human reply
rather than an SLA. Include what you did, what happened, and what you expected.

## Scope

In scope: anything that leaks your key, your memory, or your camera, microphone
or screen to somewhere you did not choose. Anything that lets a remote party
reach the local server.

Out of scope: that the local web UI has no login (it is bound to localhost by
design), and that `memory.db` is unencrypted at rest (documented above, not a
defect).
