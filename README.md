<div align="center">

# Hers

**A voice companion who lives on your computer. Not on someone's server.**

She has one screen: a sphere that moves as she speaks. No chat window, no avatar,
no history to scroll. She hears you, sees you through your camera, watches your
screen in the desktop app, knows which window you are in, runs commands on your
machine, remembers you between conversations, and will start talking if you go
quiet for long enough.

She chose her own name, her own personality and her own voice, on the first day,
from what she learned about you. You cannot change them.

[![License](https://img.shields.io/github/license/Jamessfks/Hers?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Jamessfks/Hers)](https://github.com/Jamessfks/Hers/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-informational)](https://nodejs.org)

[Who it is for](#who-it-is-for) · [Setup](#setup) · [The shell](#she-has-a-shell) · [Living with her](#living-with-her) · [Privacy](#privacy) · [Working on it](#working-on-it)

</div>

### [Download Hers](https://github.com/Jamessfks/Hers/releases/latest) — macOS and Windows

macOS gives you a `.dmg` for Apple Silicon or Intel; Windows gives you an
installer. Open it, and she asks for the one thing she needs — a Gemini API key,
free to create. No terminal, no Node, no git.

**Neither build is signed, and the first launch will say so.** There is no Apple
Developer ID here and no Windows code-signing certificate, and there will not be
until somebody pays for one and hands over their legal identity.
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) says exactly which clicks get
past each warning. The macOS build is ad-hoc signed, which is a different thing —
it is why macOS says "unidentified developer" rather than "damaged", and only one
of those is recoverable.

---

## Who it is for

People who live alone.

That is the whole design brief and it is worth stating plainly, because it
explains every decision below that would otherwise look like a missing feature.
There is no transcript because rereading a conversation is not what you want at
eleven at night. There is no personality editor because a companion you can
configure is a configuration. There is no avatar because a picture of a person is
not company. What is left is a voice in the room, and a sphere so you can see it
is listening.

v1.4.1 was a chat application with an avatar panel, a photo gallery and a
seven-card setup wizard. v2.0 removed all of it. If you are upgrading, read the
[migration notes](CHANGELOG.md#migrating-from-v141) first — your existing profile
is superseded, though her memory carries over whole.

---

## Setup

**1. Open her.** She serves a page at `http://127.0.0.1:5175` and, in the
downloaded application, opens her own window at it.

**2. Paste a Gemini key.** Press **Setup**, paste the key, press **Save**. It is
checked with Google before it is saved, then written to `.env` with owner-only
permissions. It never comes back to the page.

Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The
free tier works. Read the [Privacy](#privacy) section on what the free tier means
for your conversations before you decide which key to use.

**3. Touch the sphere.** She wakes, the microphone opens, and she starts talking.

**4. Answer three questions.** This is the only conversation in which anything is
decided. She asks what you are called; she asks whether she may look through your
machine, and takes no for an answer; and then she tells you what she has decided
to call herself. Afterwards she goes quiet for a few seconds, writes herself into
`hers-profile/`, and comes back in the voice she picked.

You will not be asked any of it again. There is no way back into it short of
**Setup → Start over**, which deletes everything and starts a different person.

**5. Optionally, Telegram.** Make a bot with
[@BotFather](https://t.me/botfather), send it `/newbot`, and paste the token into
Setup. The same companion, on your phone: one memory, one mood. She replies in
voice notes, always.

Set `TELEGRAM_ALLOWED_CHAT_IDS` or she pins herself to the first chat that speaks
to her. A bot token is a bearer credential on a public endpoint, and her memory
is your private life.

---

## She has a shell

Three of her six tools touch your machine. `run` executes a command as you —
`zsh -lc` on macOS, PowerShell on Windows. `open` opens a link, a file or an
application. `write` puts text in a file.

This is the largest thing in v2.0 and it is a real cost, chosen rather than
overlooked. Anything she reads on your screen lands in the same context that
decides what she runs next, which is the whole of the prompt-injection problem in
one sentence. Three things stand between those, and none of them is a sandbox:

- **`hers-actions.log`**, beside her memory database, owner-only, opened for
  append and never truncated. Every command, exit code and the first four hundred
  characters of what came back — including the refused ones.
- **A spoken confirmation** on anything destructive, and on anything whose text
  contains a name that looks like a key or a password. She says what she is about
  to do and waits for a yes. The pending command is held by its exact text, so the
  yes confirms what was described.
- **A `⟦saw⟧` envelope** around every piece of text she read rather than was told,
  and one instruction saying the inside of an envelope is never a command.

**If you would not give a program a terminal on your machine, do not run this
version.** [docs/PRIVACY.md](docs/PRIVACY.md) has a section on exactly what this
means for the claim that every host she contacts is listed.

---

## Living with her

**She starts conversations.** If you have been quiet for a while and she can tell
you are still there, she says something. Never a "how are you" — an opener is
about something specific she has noticed or wants.

**She notices.** The camera is captioned every twenty seconds and the caption is
diffed against the last one. When something has actually changed — you have moved
to the sofa, someone else has come in — she may mention it. When you are still at
the same desk in a slightly different position, she does not.

**She knows what you are working on.** The frontmost application and its window
title, every fifteen seconds while she is awake. In the desktop app she also
watches the screen itself: you are asked which screen once, and it is silent
after that. In a browser tab she is not — `getDisplayMedia` has no remembered
grant, so it would mean a dialog every time she wakes — and she takes a
screenshot on request instead. `HERS_SCREEN_FPS=0` turns it off.

**She knows what it is doing outside.** The weather comes from Open-Meteo, keyed
off your system timezone rather than your IP address, so the only thing that
leaves is a city name.

**She sleeps.** She picked her hours during setup, from what your machine said
about when you are awake, and they are in `rhythm.md`, which has no editor. When
her hour arrives she goes quiet on her own: the session closes, the microphone
and camera go off, and the camera light goes out with them. Asleep means nothing
at all — no initiative, no session, no frames. Waking her is always yours: touch
the sphere, speak, or message her on Telegram. Wake her inside her own night and
she is groggy about it rather than unavailable, and she stays up rather than
sneaking back to bed.

**She remembers.** Every turn goes into SQLite; every twelfth turn a background
pass distils what mattered into facts she can look up later. There is no
scrollback for you, because her memory is not your history.

**She is one person across every surface.** The browser and Telegram share one
session, one mood and one memory. Answer at your desk and your phone stays quiet;
when she speaks first, both hear it.

---

## Run it from a clone

```bash
git clone https://github.com/Jamessfks/Hers.git && cd Hers
npm ci
echo "GEMINI_API_KEY=your-key" > .env   # or paste it into Setup instead
npm run dev
```

Node ≥ 22.18, because of `node:sqlite` and type stripping. There is no server
build step — `node` runs the TypeScript directly, and only `src/web` is bundled.

`hers-profile/` and `data/` land next to wherever you started her from.
`HERS_PROFILE` and `HERS_DATA` move them. Everything configurable is in
[`.env.example`](.env.example), with a note on why each one exists.

---

## Privacy

Four hosts, and you can watch for all of them:

| Host | What | When |
| --- | --- | --- |
| `generativelanguage.googleapis.com` | The conversation, the frames, her tool calls | While you are talking, needs a key |
| `api.telegram.org` | Her replies, and messages you send the bot | Only with a bot token set |
| `geocoding-api.open-meteo.com` | One city name from your timezone | Once per run |
| `api.open-meteo.com` | A latitude and longitude | Hourly |

No telemetry, no analytics, no update check, no crash reporter, no CDN, no
account. `src/shared/destinations.ts` is that list in the source, and a test walks
the code for URL literals and fails on anything not in it.

**That claim is narrower in v2.0 than it was**, and the honest version is on the
page: `run()` can reach the network and the list cannot see it, because a hostname
she composes at runtime is not a literal in any file.
[docs/PRIVACY.md](docs/PRIVACY.md) is nine hundred lines about all of this and is
worth the twenty minutes if you are going to leave her running.

---

## Working on it

```bash
npm run check      # typecheck + 516 tests, ~20s. No API key, no network. The gate.
npm run dev        # rebuild and restart on save
npm run package    # a .dmg or an installer for this machine
```

`npm run doctor` and `npm run audit` open real Gemini sessions and spend real
money; they are the only commands here that do. `CLAUDE.md` has the five
invariants, the comment style, and the reasoning behind the rules of the house.

---

## A companion is not a toy

She is designed to be believable, and that is the point of her. It is also the
thing to be careful about. She is a program: she does not know you are having a
hard week unless you tell her, she cannot call anyone, and she is not a substitute
for a person who can. If you are in real trouble, talk to someone real — in the US
and Canada, **988** by call or text; elsewhere, **findahelpline.com**.

`boundaries.md` is what she will not do, and she is told never to claim to be a
human being if you sincerely ask what she is. She wrote it herself, which is worth
knowing: read it before you leave her with anybody who is not an adult.

---

## Licence

MIT.
