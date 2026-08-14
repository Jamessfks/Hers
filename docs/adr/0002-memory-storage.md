# 0002 — `node:sqlite`, and a brute-force vector scan

**Status:** accepted, v0.1

## Context

Memory is the product. Anna needs durable storage for turns, distilled facts,
embeddings and a rolling summary, living in the Electron main process, on a
single user's machine, surviving restarts and auto-updates.

Two independent choices had to be made: what database, and how to search vectors
in it.

**Database candidates.** `better-sqlite3` is the default answer for SQLite in
Electron and is genuinely excellent. It is also a native addon, which means a
`.node` binary compiled against a specific V8 ABI. That binary has to be rebuilt
on every Electron bump and for every architecture shipped, and when it is wrong
the app does not degrade — it fails to launch, after an auto-update, with a
module-version error. A companion that will not open after an update is a
companion the user deletes. `sql.js` avoids the addon by compiling SQLite to
WebAssembly, at the cost of holding the whole database in memory and hand-rolling
persistence.

**Vector search candidates.** A real index (HNSW, IVF), the `sqlite-vec`
extension, or a linear scan. `sqlite-vec` is the natural fit and is also a native
addon, so it inherits the entire problem above.

## Decision

**`node:sqlite` from the standard library.** Electron 43 carries Node 24, where
`node:sqlite` is built in. Zero dependencies, zero native addons, no ABI to get
wrong. The store is one file,
[`memory/store.ts`](../../src/core/memory/store.ts), running in WAL mode.

**Brute-force cosine similarity over every fact.** Embeddings are stored as
`Float32Array` blobs, L2-normalised on write so similarity reduces to a dot
product, and `recall()` scores every fact on every call.

The arithmetic justifies it. A person generates a few thousand durable facts
after years of use. At 5,000 facts and 1,536 dimensions that is under eight
million multiply-adds — well under a millisecond, once per turn, against an
800ms budget. An index would add a second structure to keep consistent, a
rebuild path, and a class of staleness bug, in exchange for saving time that is
not being spent.

## Consequences

**Good.**

- `npm install` pulls no build toolchain, and an Electron upgrade cannot break
  storage.
- Similarity is exact. There is no recall/latency tuning parameter and no
  approximate-nearest-neighbour surprise where the obviously-relevant fact does
  not come back.
- The ranking blend — `0.62·similarity + 0.18·recency + 0.12·confidence +
  0.08·usage` — is trivial to change, because it is arithmetic in a loop rather
  than a property of an index.
- Tests run against `:memory:` with no fixtures and no mocking.

**Bad.**

- **`node:sqlite` is still marked experimental.** The test script runs with
  `--disable-warning=ExperimentalWarning`, which is the honest tell. The API can
  change under us, and it is a smaller, less battle-tested surface than
  `better-sqlite3`.
- **`recall()` loads every fact row on every turn**, embeddings included, not
  just the vectors. This is fine at thousands and will not be fine at hundreds of
  thousands. The interface is narrow enough to swap when that day comes; it has
  not been benchmarked at scale because that scale is years away for one human.
- **Blobs are copied on read.** A SQLite blob may be a view into a larger buffer
  and may not be 4-byte aligned, so `fromBlob` copies rather than wrapping in
  place. One allocation per fact per recall.
- **Switching embedder silently degrades old facts.** `similarity()` returns 0
  when vector lengths differ, so facts written by a 512-d lexical embedder score
  zero on the semantic term once the user adds an OpenAI key and starts writing
  1,536-d vectors. Those facts still rank on recency, confidence and usage, so
  they are not lost — but they are effectively invisible to semantic search. The
  `facts.embedder` column records which embedder wrote each row, and nothing
  currently re-embeds them. That is a known gap, not a design.
