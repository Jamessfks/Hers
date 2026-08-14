# 0001 — User-supplied API keys, no hosted backend

**Status:** accepted, v0.1

## Context

Anna needs a frontier language model, a streaming voice, and optionally a
transcriber. She runs all day, and she is talking about the inside of someone's
life — the interview they are dreading, the argument they had, what time they
went to bed.

Three ways to get her a model:

1. **Host a backend and resell inference.** Standard, and it means running a
   service that sees every conversation, plus an account system, a billing
   system, a data-retention policy, and a subpoena surface.
2. **Ship a local model.** No network, no vendor, no cost. Also a 7B-class model
   competing with a three.js render for the same GPU on a laptop, and a
   companion whose character collapses into "helpful assistant" the moment the
   context gets long — which is the single failure mode this product cannot
   survive.
3. **The user brings their own keys.**

## Decision

The user brings their own keys. There is no Anna backend, no account, and no
telemetry. Keys are stored in the macOS Keychain via `safeStorage`
([`secrets.ts`](../../src/main/secrets.ts)), never written to `config.json`, and
never sent to the renderer.

No local model ships either. The escape hatch is left open rather than built:
the OpenAI adapter speaks Chat Completions rather than the Responses API
specifically so that `baseUrl` can be pointed at a local llama.cpp server, or at
Groq, Together or OpenRouter, without a fourth adapter.

Providers are mixed freely, because each job is a separate key: an Anthropic
brain with a Cartesia voice and Deepgram ears is the default configuration.

## Consequences

**Good.**

- Nothing we operate ever sees a conversation, because there is nothing we
  operate. The privacy claims in [PRIVACY.md](../PRIVACY.md) are structural
  rather than promissory.
- The user pays the vendor directly, at the vendor's price, on a tier they chose.
- Provider mixing falls out for free, and so does provider *switching* — the
  three interfaces in `core/` mean changing vendor is a dropdown, not a rewrite.
- Failure degrades along known paths instead of taking the app down: no
  embeddings key means the offline lexical embedder rather than no memory.

**Bad, and worth saying plainly.**

- **Onboarding is a wall.** Anna cannot say a word until two keys exist. Every
  competitor is one download and one tap. This is the single largest adoption
  cost of the decision and there is no clever way around it.
- **We do not control latency or quality.** A user on a rate-limited free tier
  gets a worse Anna, and the 800ms budget is partly someone else's to keep.
- **Every vendor error becomes our UI.** Each adapter carries a `describeFailure`
  that turns an HTTP status into a sentence a person can act on — "Cartesia
  account is out of credit", "ElevenLabs rate limit, or the character quota is
  spent". That is ongoing work that a hosted backend would not need.
- **Model drift is the user's problem.** `model` is free text and the suggested
  lists in `LLM_PROVIDER_INFO` will go stale.
- **No usage data at all.** We cannot see that the persona regressed on a new
  model version, because we cannot see anything. Assistant drift has to be
  caught by hand, which is why it is on the checklist in
  [BENCHMARK.md](../BENCHMARK.md).
- **No revenue.** This is a decision about what the product is, and it forecloses
  the obvious business model.
