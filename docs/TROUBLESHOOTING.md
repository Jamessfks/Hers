# When something is wrong

Start here:

```bash
npm run doctor
```

It checks the key, the model, the profile folder, the memory database and the
bridges, then opens a real Gemini session, says one thing and waits for audio.
If that passes, the only things between you and her talking are the browser's
own permissions.

---

## She does not answer

### I waved at the camera and nothing happened

**This is expected, and it is worth understanding rather than working around.**

The Gemini Live API does not start a turn from video. Its
[own documentation](https://ai.google.dev/gemini-api/docs/live-guide) is
explicit that voice activity detection runs on *audio*: a reply is triggered by
speech ending, by text arriving, or by an explicit turn boundary. Video frames
are context that gets folded into whatever turn happens next — they never
themselves cause one.

So a wave, a nod, holding something up to the lens: she sees all of it, and none
of it makes her speak. What makes her speak is:

- you saying something out loud, with **hearing** on;
- you typing something;
- her own initiative timer running down — at most three minutes, and when it
  fires she is handed the newest frame first, so an opener about what you are
  doing right now is exactly what you get.

If you want a reply to a wave now rather than within three minutes, say
something. If you want her to open more often, lower `HERS_MAX_SILENCE_MS`.

### She answers on Telegram but not in the browser

The browser needs a live WebSocket and the server keeps **one conversation at a
time**. If you have two tabs open, the newest one has her and the older one
shows a card saying so. Click **Bring her here** in the tab you want.

### She stopped mid-sentence and went quiet

A Gemini session with video is capped at about two minutes and can drop at any
time. She rebuilds it, and a single reconnect is routine. To see what is
happening:

```bash
HERS_DEBUG=1 npm start
```

Every reconnect then prints its reason. A stream of them with the *same* reason
is a diagnosis — usually the key, the quota, or the model name.

### She said one thing and then never spoke again

By design. Two openers with no reply and she stops rather than talking into an
empty room. She comes back when you do something: speak, type, or come back to
the tab.

---

## The key

### "Google says: API key not valid"

That message is Google's, passed through unchanged. It almost always means a
character went missing or came along with a paste. Copy it again from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### "That value has characters in it that do not belong in a key"

Something came with the paste — a space, a quote, a newline. Hers refuses to
write it rather than guessing at the escaping and leaving you with a `.env` that
reads back subtly wrong.

### I set the key but she still says she needs one

The setup panel writes to `.env` **and** updates the running process, so it
should take effect immediately. If it did not: a real environment variable beats
the file. Check for `GEMINI_API_KEY` already set in your shell.

---

## The senses

### The button will not light up

A denied permission arrives as an exception, and she says which one plainly.
The browser only asks once per site — after a refusal you have to allow it from
the address bar and try again.

### Screen sharing shares the wrong thing

You pick the window or screen in the browser's own picker, not in Hers. Switch
the sense off and on to be asked again.

### The camera light is on but she cannot see me

If both the camera and screen are on, she is sent **one** composited picture —
your screen with you inset in the corner — because the Live API takes stills on
one channel with no way to label the source. She can still see you; you are
smaller. Turn the screen sense off to send the camera full-frame.

---

## Pictures

### An expression will not generate

Image models decline to draw a photorealistic person often enough that this is an
ordinary outcome rather than a fault. It is retried three times before you are told, and
trying again a minute later usually works. Each attempt is a paid image, which is why it
does not retry forever.

If it never works, check that her photograph is actually a photograph of a person — the
model is being asked to reproduce a real face, and it will refuse on some inputs and not
others.

### She will not generate a picture of herself

She has no photograph yet. Every generated picture starts from the one you
uploaded, and without it she declines rather than inventing a stranger — that is
deliberate, and it is what stops her face drifting.

**Face → Give her a face**, then ask again.

---

## Telegram

### The bot does not answer

- Is the server running? The bot is a long poll from *your machine*; nothing
  answers when she is not up.
- Have you opened the chat and pressed **Start**? A token that works is not
  finished setup. A bot may not message first, and nothing in the Bot API tells
  it which chat is yours, so until something arrives from you there is nobody to
  answer. Setup → **Reach her on Telegram** shows the link.
- If you put `TELEGRAM_BOT_TOKEN` in `.env` by hand, did you restart? A token
  saved from the website takes effect immediately; one edited into the file is
  read at startup.
- Is your chat id allowed? Send `/whoami`. If someone else messaged the bot
  first, she is pinned to them — clear `TELEGRAM_ALLOWED_CHAT_IDS` and message
  her yourself before anyone else does.

### "Telegram says: Unauthorized"

The token is wrong. It is the whole string @BotFather gave you, digits and colon
included, and it is easy to lose a character at either end when copying out of a
chat. Ask @BotFather for `/mybots` → your bot → **API Token** and paste it again;
the box keeps what you typed so you can compare.

### Two of her are answering, or updates go missing

Only one thing may poll a bot token. Telegram hands `getUpdates` to whichever
caller asked most recently and terminates the other, so a second copy of Hers, or
another program on the same token, takes the conversation in half. Stop the other
one. `npm run audit:bridges` also polls, so it will briefly interrupt a running
server — the audit prints the conflict when it happens.

### She sends a photograph that is not the one I uploaded

`/me` sends the original file, byte for byte. `/photo` *generates* a new picture
— it will be the same woman, in a different moment, which is the point of it.

### Commands do not show in the `/` menu

They are published on startup. Restart Hers; Telegram caches the list for a
minute or two after that.

---

## Calls

### The link opens but the call never connects

- Open it in Safari or Chrome, not Telegram's in-app browser. On iOS the in-app
  browser does not reliably grant camera access.
- Call links expire after fifteen minutes. Send `/call` again.
- `HERS_CALL_PAGE_URL` has to be somewhere your **phone** can reach. A
  `127.0.0.1` address works only from the machine Hers runs on.

---

## Starting over

**Setup → Start over**, type `start over`, and everything she has accumulated is
deleted: memory, conversations on every surface, mood, profile, gallery and
photograph. Your API keys survive.

If it refuses with *"Refusing to delete …"*, `HERS_PROFILE` or `HERS_DATA` points
somewhere too dangerous to remove — your home directory, the root of a disk, or
the folder Hers is running from. Point them at folders of their own.

---

## Nothing here matches

```bash
npm run audit
```

It speaks to her with real synthesised speech, shows her real images, waits for
her to open a conversation on her own, and holds an audio+video session open
past the point Google documents it as ending — then prints what it actually
observed rather than only a verdict. It costs a few cents and it is the fastest
way to find out which half of the system is lying.

`--quick` skips the multi-minute checks. `--only=mood` runs one of them.
