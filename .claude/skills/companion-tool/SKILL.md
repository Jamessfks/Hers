---
description: How to add, change, or remove one of her tools (feel, remember, recall, run, open, write) in src/core/gemini/tools.ts without breaking the live session or the product's promise.
---

# Changing her tools

`src/core/gemini/tools.ts` is the highest-risk file in the repo. Read its header
comment before touching it — every tool there earns its place by doing something
that cannot be faked from outside, and the list is short deliberately: a realtime
model with a long tool list spends its attention deciding rather than talking,
and the symptom is a companion who pauses before every sentence.

## The hard limit

**Three of them now read files, run commands and reach the network**, which was
forbidden until v2.0 and is now the product rather than a lapse. What replaced
the old rule is in `CLAUDE.md` invariant 4: the action log, the spoken
confirmation on destructive commands, and the `⟦saw⟧` envelope. A tool that
skips any of those is
a different product. If the user asks for one, say this and ask them to confirm
before you write it.

## The six, and why each exists

| Tool       | Why it cannot be done from outside                                      |
| ---------- | ------------------------------------------------------------------------ |
| `feel`     | Only she knows whether that landed. A classifier on the transcript is slower and worse. |
| `remember` | Background consolidation catches most things. This is the moment she decides something matters. |
| `recall`   | The other half of `remember`. Without it she can file a memory she cannot look up. |
| `run`      | A shell. She lives on the machine, and a companion who can only describe what she would do is pretending. |
| `open`     | Separate from `run` only because it is the common case, and a tool that names what it does gets called when it should be. |
| `write`    | The same argument. `run` could write a file with a heredoc and would get the quoting wrong on the fourth line of a poem. |

Six is the ceiling, and the ceiling is measured rather than aesthetic: a realtime
model with a long tool list spends its attention deciding rather than talking,
and the symptom is a companion who pauses before every sentence. `hersTools()`
returns `BASE_TOOLS` whole — nothing is conditional any more.

## Adding one

1. Write the reason first, in the header comment, in the form the others use:
   what this does that cannot be faked from the outside. If you cannot write that
   sentence, the tool does not belong.
2. Declare it with a `description` written to her, in her register — the existing
   ones tell her when to use it and when not to announce it. Read `run`'s.
3. Handle it in `src/core/session/companion.ts`, and add the refusal path for
   arguments that cannot be satisfied.
4. Add a case to `companion.test.ts` shaped like the existing ones: the tool call
   goes in as a `functionCall`, and the assertion is about what she does with it.
5. Check the model constraint. `gemini-2.5-flash-native-audio-preview-12-2025`
   closes the socket with `1011` when function declarations meet audio input, so
   Hers runs it with no tools at all. Anything you add is absent on that model —
   confirm the behaviour degrades rather than breaks.

Then `npm run check`. The live behaviour is only proven by `npm run audit`, which
costs money and is the user's call.
