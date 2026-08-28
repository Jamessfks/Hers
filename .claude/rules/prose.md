---
description: The house voice for README, CHANGELOG, docs, and code comments
paths:
  - "*.md"
  - "docs/**/*.md"
  - ".github/**/*.md"
---

# The voice

Every word a person reads in this project is written the same way. Match it or
the change reads as bolted on.

**What it does:**

- States what is true, plainly, and then says why. *"The camera light cannot be
  made to lie."* *"Nothing is fetched from a CDN any more."*
- Gives the reasoning including what was rejected and why: *"Deliberately not by
  waking anyway: that would reintroduce the race the wait exists to prevent."*
- Admits the edges. The `destinations.ts` header has a section titled *"What this
  list cannot catch."* A guarantee that names its own weakest claim is worth more
  than one that does not.
- Uses concrete numbers over adjectives. "Eight seconds", "a few cents", "fourteen
  colours" — not "quickly", "cheap", "several".
- British spelling: *behaviour, colour, licence* (noun), *synthesised*, *recognise*.

**What it never does:**

- Marketing register. No "seamless", "powerful", "robust", "delightful", no
  exclamation marks, no emoji.
- Hedging. No "we believe", "should generally", "may want to consider".
- Explaining the obvious. If a reader can see it in the code, do not narrate it.

CHANGELOG entries are prose paragraphs with **a bolded lead sentence** each, not
bullet lists. Anything that changes a name already typed into a config file is
called out as breaking, with what to do about it.

Comments sit above the code they describe, never trailing it.
