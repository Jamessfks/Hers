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

## The seam sweep

`/harness/seam.html` is the other page here, and it is a measuring instrument
rather than a view. It seeks a clip frame by frame, measures each frame against
the source photograph with the app's own `measureSeam`, and prints the curve —
which is how "no cut point exists in any of these clips" stopped being a guess.

```
/harness/seam.html?clip=nod      nod.mp4, every frame
/harness/seam.html?clip=tilt     tilt.mp4
/harness/seam.html?clip=idle     anna.mp4
/harness/seam.html?clip=all      all three, in sequence
/harness/seam.html?clip=control  the pairs that say what a number is worth
```

`control` is the one to run first if the numbers ever look wrong. It measures a
known-identical pair, two different clips' opening frames, and a known-different
pair, so a reading has a floor and a ceiling to sit between instead of being a
figure on its own.

It needs `nod.mp4` and `tilt.mp4` beside the two files above:

```bash
LIB=~/Library/Application\ Support/anna/libraries
cp "$(ls -d $LIB/*/ | head -1)"clips/nod.mp4       harness/nod.mp4
cp "$(ls -d $LIB/*/ | head -1)"clips/tilt_head.mp4 harness/tilt.mp4
```

Expect two to three minutes for a five-second clip. It is slow because the
browser pane runs the page hidden, where `requestAnimationFrame` never fires and
timers are throttled to about one a second — worth knowing before you conclude
it has hung. If it stops before printing `source decoded`, that is the same
cause: `img.decode()` never resolves for a detached image in a hidden document,
which is why this page waits on `load` instead.
