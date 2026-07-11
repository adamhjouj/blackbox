# Phase 0 — the store + hash chain (built)

The tamper-evident storage spine. No agent observation yet — this proves we can record events and later prove none were altered. Phase 1 bolts the live hook receiver onto this store.

Hardened after an adversarial review (see the decision log at the bottom): the fixes below closed a false-positive class, an ingest crash, and a tail-truncation blind spot.

## Build & run

```bash
npm install
npm run build          # tsc -> dist/
node dist/cli.js --help
```

## Commands

```bash
# Ingest raw hook payloads (JSONL, one payload per line) into the chained store.
# Stands in for the live receiver until Phase 1; also the fixture-replay path.
node dist/cli.js ingest <file.jsonl> [--db path]

# Verify the hash chain + head anchor; prints the first break or "intact".
node dist/cli.js verify [--db path]

# Print the head anchor (seq, count, hash) — the value an external anchoring
# tier would record off-machine to close the remaining rewrite gap.
node dist/cli.js head [--db path]

# Inspect
node dist/cli.js sessions [--db path]
node dist/cli.js list [--db path] [--session <id>]
```

Default DB path: `$BLACKBOX_DB` or `./blackbox.db`.
Exit codes: `0` ok · `1` chain broken · `2` usage/IO error · `3` ingest recorded nothing or skipped malformed lines.

## What's inside (`src/`)

| File | Role |
|---|---|
| `types.ts` | The canonical `BlackboxEvent` schema + column list (declared once so append/verify can't drift) |
| `hash.ts` | `canonical()` (deterministic key-sorted JSON) + `hashEvent()` + `GENESIS` |
| `store.ts` | SQLite (WAL) schema, `append()` (assigns seq/prev_hash/hash, advances the head anchor), string sanitization, reads |
| `normalize.ts` | Tolerant raw-payload → normalized event; stores `raw` verbatim; code-point-safe truncation |
| `verify.ts` | Walks the chain, then checks the head anchor. First break: `content-tampered` / `broken-link` / `bad-sequence` / `truncated` |
| `cli.ts` | `blackbox` entrypoint |

## The tamper-evidence guarantee — precisely what it catches

Each event's `hash = sha256(canonical(all columns except hash))`, and that content includes `prev_hash` = the previous event's hash. A **head anchor** (`chain_meta`: count + head hash), updated in the same transaction as each append, records where the chain should end.

`verify` therefore catches:
- **Any field edit** → that event's hash no longer matches → `content-tampered`.
- **Delete / reorder / insert in the middle** → a `prev_hash` stops matching, or the seq gap shows → `broken-link` / `bad-sequence`.
- **Tail truncation or full wipe** → the row count/head no longer matches the anchor → `truncated`.

Verified end-to-end against real captured fixtures, and against every scenario the adversarial review used to break the first version.

### Honest limits (V1) — do not overclaim
- **Not tamper-*resistance*.** The hash is a keyless SHA-256 over public columns, and the head anchor lives in the same file. An attacker with write access **and** knowledge of the (open-source) format can recompute the whole chain forward and rewrite the anchor — `verify` then reports intact. Confirmed, and expected. Closing this needs a key the local writer can't read (keyed MAC/HMAC) and/or anchoring the head hash **off-machine** (periodic signed/remote checkpoint) — the [LATER] / paid tamper-resistance tier. `blackbox head` exists to feed exactly that external anchor.
- What V1 *does* buy: defeats accidental corruption, casual/partial edits, and naive (non-recomputing) deletion or truncation — and yields a verifiable artifact. That is *tamper-evidence*, and we state it as exactly that.

## Deferred to Phase 1 (noted, not built)
- **Ingest idempotency.** `event_id` is a random UUID, so re-running `ingest` on the same file appends duplicates. Harmless for the live daemon (it consumes a stream, not a file), but the fixture-replay tool is not idempotent — don't double-run it. A deterministic content id / ingest cursor is the Phase-1 fix.
- **Authoritative timestamps.** `ts` is source/capture-claimed (fixtures carry `_captured_at`); `captured_at` is the recorder-observed time. In Phase 1 the daemon stamps the trusted receive time itself and never lets a payload-provided time drive session ordering.
