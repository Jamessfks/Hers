# When something is wrong

**If you installed the application,** start with its log. It is rewritten on
every launch and holds everything a terminal would have printed — where her
folders are, which model she is on, every configuration warning, and the reason
she would not start if she would not.

| Platform | Log                                            |
| -------- | ---------------------------------------------- |
| macOS    | `~/Library/Application Support/Hers/hers.log`   |
| Windows  | `%APPDATA%\Hers\hers.log`                       |

Nothing secret is in it. The key is written masked to its last four characters
and the bot token is never written at all, so it is safe to send to somebody.

**If you are running from a clone,** start here:

```bash
npm run doctor
```

It checks the key, the model, the profile folder, the memory database and the
bridges, prints every path she writes to and every host this build can reach,
then opens a real Gemini session, says one thing and waits for audio. If that
passes, the only things between you and her talking are the browser's own
permissions.

Everything except that last step runs offline. `GEMINI_API_KEY= npm run doctor`
stops before it and still prints both lists, which is the cheap way to answer
"where is my stuff and who can she talk to" without spending anything.

---

## The downloaded application

### macOS says it cannot verify the developer

Expected. The build is not signed — see the README for why, and for the exact
clicks. In short: on macOS Sequoia and later, **System Settings → Privacy &
Security**, scroll to **Security**, **Open Anyway**, then **Open**. On macOS 14
and earlier, Control-click her in Applications and choose **Open**. If you would
rather not click through any of it:

```bash
xattr -dr com.apple.quarantine /Applications/Hers.app
```

That deletes the flag macOS puts on downloaded files, which is the thing all of
this keys off. Measured here: held-forever to a window in about two seconds.

### It asks again every single time I open her

You are launching her from somewhere that is not `/Applications` — the disk
image itself, or Downloads. macOS runs a quarantined application from a
randomized read-only copy of itself unless it has been properly installed, so
the exception you granted was granted to a path that no longer exists the next
time. Drag her into **Applications** and launch her from there, or run the
`xattr` line above, which removes the condition entirely.

### macOS says Hers is damaged and should be moved to the Bin

That is a *different* message and it does not mean what it says. It means the
signature did not verify — almost always an incomplete or corrupted download.
Delete the file and download it again. If a build you made yourself does this,
the ad-hoc signing step in `build/adhoc-sign.cjs` did not run.

### Windows says "Windows protected your PC"

**There is no Windows build yet** — nothing has been compiled and nothing has
been run, so if you are reading this you have built it yourself. When one
exists: SmartScreen, for the same reason as Gatekeeper. **More info**, then
**Run anyway**. If it asks every single launch, right-click the file →
**Properties** → tick **Unblock** on the General tab. Everything else on this
page about the application is written for both platforms and tested on macOS
only.

### The icon bounced once and nothing opened

**On macOS, and if there is no `hers.log` at all, this is Gatekeeper.** Not a
crash, not a permissions problem. An earlier version of this page sent you to
check whether `~/Library/Application Support` was writable, which was the wrong
first answer and cost somebody their afternoon: when Gatekeeper holds a
quarantined application, *zero instructions of it run*. Nothing is mapped, no
folder is created, no log is written, and there is nothing to read because
nothing happened. An absent log is the symptom, not a second fault.

Three things do it, in order of likelihood:

1. **You have not got past the unsigned warning yet.** Do that first — the
   clicks are in [the README](../README.md#2-get-past-the-warning-because-there-will-be-one).
2. **You are launching her from the disk image, or from Downloads.** Drag her
   into **Applications** and launch her from there. Anywhere else, macOS may run
   a quarantined app from a randomized read-only copy of itself — App
   Translocation — and the permission you granted does not stick, so the same
   refusal comes back on every launch.
3. **Neither worked.** One line in Terminal ends it, by deleting the download
   flag the whole mechanism keys off:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Hers.app
   ```

   Then open her normally. This is the escape hatch that cannot fail, and it is
   also the one you should understand before running: it tells macOS to stop
   treating this file as downloaded, so run it against *her* and not as a habit.

**If `hers.log` does exist**, she got as far as running and the problem is
inside. If it is empty or ends without the `Hers is at http://…` line, she did
not finish starting and the last thing in the file is why. Only if the log is
absent *and* you have ruled out all three of the above is it worth checking that
`~/Library/Application Support` (or `%APPDATA%`) is writable.

### She started fresh and does not know me

The application and a clone are two separate installs and nothing is migrated
between them, because guessing which of two profile folders holds the real
person is how somebody loses her. Point the application at the clone's folders
instead: set `HERS_PROFILE` and `HERS_DATA` to their full paths. Those win over
everything, in the application exactly as in a clone.

### I closed the window and she is still running

On macOS that is deliberate. Closing a window is not quitting, and if you have
her on Telegram, closing the desk window should not end a conversation happening
on your phone. **Cmd-Q**, or **Hers → Quit**, actually stops her. On Windows,
closing the last window quits.

### Where did she put my key?

`~/Library/Application Support/Hers/.env` on macOS, `%APPDATA%\Hers\.env` on
Windows, `.env` beside the clone otherwise. Never next to the program: on macOS
that folder is inside a read-only bundle and on Windows it is under `Program
Files`, and on both an upgrade replaces it.

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
write it rather than guessing at the escaping and leaving you with a key file
that reads back subtly wrong.

### I set the key but she still says she needs one

The setup panel writes to the key file **and** updates the running process, so
it should take effect immediately. If it did not: a real environment variable
beats the file. Check for `GEMINI_API_KEY` already set in your shell — or, if
you launch her from a terminal with one exported, in that terminal.

---

## The senses

### She cannot hear me

The microphone comes up when you touch the sphere and goes down when she sleeps —
there is no switch, since v2.0. If the browser refused it you get a message
saying so. Check the site permission for `127.0.0.1:5175`, and on macOS check
System Settings → Privacy & Security → Microphone for the application you started
her from.

### She will not run a command

Look in `hers-actions.log`, beside her memory database. Every attempt is there,
including the refused ones, with the reason.

Three things refuse a command outright rather than asking about it: a path that
looks like a credentials file, a write into her own profile or memory folders,
and a write to `.env`. Everything destructive is not refused — she is supposed to
describe it and wait for you to say yes. If she describes something and then does
nothing, she probably did not hear the yes; say it again plainly.

On macOS a command that reads files outside her own folders may come back with a
permission error. That is Full Disk Access, and the grant follows the Node binary
rather than the application, so upgrading Node silently revokes it: System
Settings → Privacy & Security → Full Disk Access, and add whatever you start her
from.

### She is not watching my screen

**In the downloaded application** she should be. The first time she wakes you
are asked which screen, once; after that it is silent, and quitting and
reopening her is how you change the answer. On macOS the first share also needs
Screen Recording permission — System Settings → Privacy & Security → Screen
Recording — and macOS will not apply it until the application is restarted.

**In a browser tab she is not, deliberately.** `getDisplayMedia` shows the
operating system's picker on every single call and there is no remembered
grant, so bringing the screen up with her would mean a dialog every time she
wakes. Ask her to take a screenshot instead; that is `run` and it works.

To turn it off in the application, set `HERS_SCREEN_FPS=0`. It is the largest
recurring cost of running her.


### The camera light is on but she cannot see me

If both the camera and screen are on, she is sent **one** composited picture —
your screen with you inset in the corner — because the Live API takes stills on
one channel with no way to label the source. She can still see you; you are
smaller. Turn the screen sense off to send the camera full-frame.

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

### Running a second copy without stealing your bot

Unsetting the variable does not work, and it is worth knowing why before you try it.
`loadDotEnv` calls Node's `process.loadEnvFile`, and Node only skips a key that is
already **present** in the environment. `env -u TELEGRAM_BOT_TOKEN` makes the key
absent, so the token in `.env` is loaded and a second poller starts — the opposite of
what you wanted. Set it to empty instead, which counts as present:

```bash
TELEGRAM_BOT_TOKEN= TELEGRAM_ALLOWED_CHAT_IDS= \
  HERS_PORT=5180 HERS_PROFILE=/tmp/scratch/profile HERS_DATA=/tmp/scratch/data \
  npm start
```

Verified: with the key absent Node returns the `.env` value; with it set to an
empty string the empty string survives.

### Two of her are answering, or updates go missing

Only one thing may poll a bot token. Telegram hands `getUpdates` to whichever
caller asked most recently and terminates the other, so a second copy of Hers, or
another program on the same token, takes the conversation in half. Stop the other
one. `npm run audit:bridges` also polls, so it will briefly interrupt a running
server — the audit prints the conflict when it happens.


## Starting over

**Setup → Start over**, type `start over`, and everything she has accumulated is
deleted: memory, conversations on every surface, mood, her profile including
the hours she chose, and
photograph. Your API keys survive.

If it refuses with *"Refusing to delete …"*, `HERS_PROFILE` or `HERS_DATA` points
somewhere too dangerous to remove — your home directory, the root of a disk, or
the folder Hers is running from. Point them at folders of their own.

---

## Nothing here matches

From a clone:

```bash
npm run audit
```

It speaks to her with real synthesised speech, shows her real images, waits for
her to open a conversation on her own, and holds an audio+video session open
past the point Google documents it as ending — then prints what it actually
observed rather than only a verdict. It costs a few cents and it is the fastest
way to find out which half of the system is lying.

`--quick` skips the multi-minute checks. `--only=mood` runs one of them.
