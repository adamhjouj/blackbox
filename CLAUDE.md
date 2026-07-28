# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                      # required again after switching Node (native better-sqlite3)
npm run build               # clean + tsc → dist/, chmod +x dist/cli.js
npm test                    # build, then node --test test/*.test.js
npm run demo                # synthetic session in .blackbox-demo/, UI on port 7843
node dist/cli.js <command>  # run the CLI without npm link
```

Node 18/20/22 only — `better-sqlite3` does not build on 23+.

**Running one test:** every test file `require`s the *compiled* `../dist/`, so build first:

```bash
npm run build && node --test test/redact.test.js
node --test --test-name-pattern 'ghost' test/reconcile.test.js
```

`test/util.js` has the shared fixture builders (`ev`, `normEv`, throwaway on-disk `Store`).

Isolate state when running anything by hand: `BLACKBOX_HOME=/tmp/bb-x BLACKBOX_DB=/tmp/bb-x/x.db node dist/cli.js …`. Without them the CLI touches the real `~/.blackbox`.

## Architecture

Blackbox is a passive recorder for Claude Code. `blackbox init` writes async HTTP hook handlers into `~/.claude/settings.json` pointing at `http://127.0.0.1:7842/hook`; a long-lived daemon receives them and appends to a hash-chained SQLite store. Everything else is a read-time projection of that store.

**Capture path:** `daemon.ts` (`POST /hook`, `POST /git`) → `normalize.ts` (tolerant parse into the canonical schema in `types.ts`) → `redact.ts` → `store.ts` (append + `hash.ts` chain) → `sign.ts` checkpoints → optional `anchor.ts` receipt.

**The one boundary that governs every change: hashed vs. derived.**

- Hashed and immutable: the `events` table and `chain_meta`. Each row's hash covers all normalized columns plus the previous hash; `hash.ts:canonical()` omits null keys so adding a nullable column is hash-neutral (additive migrations don't false-positive `verify`).
- Derived, un-hashed, recomputable: `risk`, `session_risk`, `session_reconciliation`, `signatures`, `search_meta`, and the content-addressed `blobs` table. Risk (`risk-engine.ts` + `risk-rules.ts`), reconciliation (`reconcile.ts`), provenance (`provenance.ts`), the graph (`graph.ts`), and explanations (`explain.ts`) are pure functions over the chain — they are never written back into it.

So: a risk rule change, a rescore, a prune, or a UI read must leave `verify()` byte-identical. Anything that would change an existing event's bytes is a bug, not a feature.

**Mutations:** `mutation.ts` splits each file write/edit into a *fact* (hash, size, diffstat) that rides in the hashed `detail`, and *content* (redacted patch/body) in the prunable `blobs` table keyed by content hash. `prune` drops bytes and keeps commitments.

**Custody ladder** — each rung closes the previous rung's hole, and the file headers of `sign.ts` / `anchor.ts` state the honest limits: chain → local Ed25519 checkpoints → out-of-DB watermark (`signing.head`) → external receipts on `refs/blackbox/anchors`, a file, or HTTPS. `anchor.ts` is the only code that can send bytes off the machine.

**Ground truth:** `git-collector.ts` and `worktree.ts` capture Git facts; `reconcile.ts` joins them against hook-reported mutations to produce ghost / phantom / content-mismatch findings. `transcript.ts` reads Claude Code's `.jsonl` defensively to recover prompt text and *stated* reasoning — it is an unstable internal format, so parse failures degrade to null, never throw.

**Read side:** `read-api.ts` collapses Pre/Post pairs into `Action` rows and assembles the story, trace, verify status, and evidence the daemon serves under `GET /api/*`. All API routes are same-origin-only (`isBrowserForged`), Host-checked against loopback (anti-DNS-rebinding), and `/git` requires the generated collector token unless started with `--allow-insecure-git`.

**UI:** `ui-page.ts` concatenates `src/ui/*.ts` string constants into one self-contained document — no framework, no bundler, no runtime deps, served under a restrictive CSP. Two hard conventions, both guarded by `test/ui-smoke.test.js`:

- Client JS lives inside `String.raw` template literals, so it must contain **no raw backtick and no `${`** — either silently corrupts the whole page. Build strings with `'...' + x` concatenation.
- Recorded data is hostile. Render it only through `textContent` / DOM nodes (`h()` in `state-router.ts`). `innerHTML` and `insertAdjacentHTML` are forbidden.

## Invariants to preserve

- Redact before the first persistent write; if redaction throws, drop content to a hash rather than leak it.
- Never mutate existing event bytes — not in rescore, reconcile, index, prune, or UI reads.
- Risk rules stay versioned (`RULESET_VERSION` in `risk-rules.ts`, currently `r4`) and deterministic. Adding a ruleset means a new id in `KNOWN_RULESETS`, not editing an old one's behavior; `blackbox rescore --ruleset rN --check` compares without writing.
- Keep the daemon loopback-only and the read API same-origin.
- Deliberate security choices are load-bearing and sometimes look like dead code — e.g. `POISON_FIRST_CONTACT_MED = false` in `risk-engine.ts` (designed, disabled pending field data on its false-positive rate) and the entropy thresholds in `redact.ts`. Don't "simplify" hashing, signing, or redaction logic without reading the header comment that explains it.
- Commit only synthetic data. Never a real database, session export, signing key, local path, or credential.

## Docs

`docs/ARCHITECTURE.md` is the design document; `docs/PHASE*.md` and `docs/FORENSIC-*.md` record why each capability landed the way it did. `CONTRIBUTING.md` states the same invariants in review terms.
