# The harness

Anna's window calls `setContentProtection(true)`. She is deliberately invisible
to every screen recorder on the machine — correct for a companion who would
otherwise turn up in a shared screen during a work call, and fatal for anyone
trying to review how she looks, because a screenshot of her window comes out
empty rather than wrong.

This page is the way round that. It loads the real `src/renderer/styles.css`,
the real `Thread` and the real `fitComposer` into a plain browser tab that can
be photographed. Nothing is restyled here: if it looks wrong in this page it is
wrong in the app.

## Running it

```bash
npx vite --port 5199
```

Then open `http://localhost:5199/harness/` at a 393x852 aspect — the layout is
written against that reference and scales to any window, so any size with that
proportion shows the same thing.

## The media

Two files are needed and neither is committed, because both are a copy of
whichever avatar happens to be installed on the machine:

```bash
LIB=~/Library/Application\ Support/anna/libraries
cp "$(ls -d $LIB/*/ | head -1)"clips/idle.mp4 harness/anna.mp4
cp "$(ls -d $LIB/*/ | head -1)"source.jpg      harness/anna.jpg
```

Without them the page still renders the whole interface; the background is just
the empty well behind it.

## States

The layout has four states worth looking at, and the query string reaches all of
them:

| | |
|---|---|
| `/harness/` | the default thread |
| `?state=thinking` | her typing indicator |
| `?mic=on` | the handset listening |
| `?empty=1` | no messages — the first-run view |
| `?long=1` | one bubble taller than anything the reference contains |

The default script is the conversation from the reference screenshot, verbatim.
That is deliberate: identical text is what makes a side-by-side a comparison of
layout rather than of line-wrapping luck, and six of its seven bubbles should
break their lines exactly where the reference breaks them. If a wrap moves, the
type or the bubble geometry has drifted.
