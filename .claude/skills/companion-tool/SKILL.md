---
description: How to add, change, or remove one of her tools (feel, remember, recall, show, look) in src/core/gemini/tools.ts without breaking the live session or the product's promise.
---

# Changing her tools

`src/core/gemini/tools.ts` is the highest-risk file in the repo. Read its header
comment before touching it — every tool there earns its place by doing something
that cannot be faked from outside, and the list is short deliberately: a realtime
model with a long tool list spends its attention deciding rather than talking,
and the symptom is a companion who pauses before every sentence.

## The hard limit

**No tool may read a file, run a command, or reach the network.** That is not a
security posture, it is the product: the README shows her declining to go through
the computer, and it works because the tools genuinely cannot. A tool that can is
a different product. If the user asks for one, say this and ask them to confirm
before you write it.

## The five, and why each exists

| Tool       | Why it cannot be done from outside                                      |
| ---------- | ------------------------------------------------------------------------ |
| `feel`     | Only she knows whether that landed. A classifier on the transcript is slower and worse. |
| `remember` | Background consolidation catches most things. This is the moment she decides something matters. |
| `recall`   | The other half of `remember`. Without it she can file a memory she cannot look up. |
| `show`     | Choosing a picture that fits the conversation is a judgement about the conversation. |
| `look`     | Only offered when expressions exist for the current photograph.          |

`look` is returned by `hersTools(readyFaces)` rather than sitting in `BASE_TOOLS`,
because offering an expression that has not been generated produces a tool call
the server must refuse — which she experiences as her own face not working.

## Adding one

1. Write the reason first, in the header comment, in the form the others use:
   what this does that cannot be faked from the outside. If you cannot write that
   sentence, the tool does not belong.
2. Declare it with a `description` written to her, in her register — the existing
   ones tell her when to use it and when not to announce it. Read `look`'s.
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
