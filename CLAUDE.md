# CLAUDE.md

This file provides guidance to AI coding agents working in this repository.

## Commands

```bash
npm ci                      # repeat after switching Node (native better-sqlite3)
npm run build               # clean + tsc → dist/, chmod +x dist/cli.js
npm test                    # build, then node --test test/*.test.js
npm run test:packed-install # pack/install/init/doctor/self-test/verify/uninit lifecycle
npm run demo                # synthetic store in .blackbox-demo/, UI on port 7843
node dist/cli.js <command>  # run the compiled CLI without npm link
```

Supported Node lines are `22`, `24`, and `26`.

Every test file imports compiled modules from `../dist`, so build before running one directly:

```bash
npm run build && node --test test/redact.test.js
node --test --test-name-pattern 'ghost' test/reconcile.test.js
```

`test/util.js` contains shared synthetic fixture builders. Isolate all manual CLI work:

```bash
BLACKBOX_HOME=/tmp/blackbox-dev \
BLACKBOX_DB=/tmp/blackbox-dev/blackbox.db \
node dist/cli.js status
```

Without those variables, the CLI can read or modify the real `~/.blackbox` state.

## Architecture

Blackbox is a passive recorder and review layer for Claude Code and Gemini CLI. Both adapters feed the canonical event shape in `types.ts`; the daemon redacts and appends those events to one hash-chained SQLite store. Everything else is a projection, human review ledger, or signed commitment around that store.

### Capture path

- Claude Code: async HTTP hooks installed by `init.ts` → `POST /hook`.
- Gemini CLI: named command hooks installed by `gemini-init.ts` → `blackbox hook gemini` → `POST /hook/gemini` → `adapters/gemini.ts`.
- Git: token-authenticated facts from `watch.ts`/`git-collector.ts` → `POST /git`.
- Shared pipeline: `normalize.ts` → `redact.ts` → `store.ts`/`hash.ts` → checkpointing in `sign.ts` → optional receipt in `anchor.ts`.

Gemini has no native `tool_use_id`; its adapter uses bounded FIFO correlation over session + mapped tool + canonical redacted input. Missing correlation stays explicitly unmatched.

### Hashed versus non-hashed state

This boundary governs every change.

- **Hashed and immutable:** `events` and `chain_meta`. Event hashes cover normalized columns and the previous hash. Never rewrite an existing event.
- **Hash-committed content:** mutation facts in event `detail`; redacted mutation bodies live in `blobs` under their committed content hash and may be pruned to tombstones.
- **Recomputable projections:** `risk`, `session_risk`, `session_reconciliation`, `session_intent`, search indexes, provenance, graph, explanations, and reports.
- **Signed derived state:** checkpoints, session identity rows, external receipts, and standalone attestations. Signing must never alter events.
- **Human state:** `review_actions` is append-only and local, but not re-derivable and not part of the evidence chain.
- **Project policy:** `.blackbox/policy.json` is external repository input. Its normalized hash binds review decisions and attestation review state.

`hash.ts:canonical()` omits null keys. Additive migrations may add nullable columns (for example legacy `source = null`) without changing old row hashes. Store opening must refuse a newer unknown `user_version` before altering anything.

Rescore, reconcile, index, prune, review, report, attest, and UI reads must leave `verify()` byte-identical.

### Outcomes and findings

`risk-rules.ts` and `risk-engine.ts` hold versioned deterministic interpretation (`r4` is current). `findings.ts` is the shared action/combination outcome projection:

- matching success post → succeeded;
- matching failure event → failed;
- intent without conclusive result → attempted;
- unsupported/insufficient evidence → unknown.

Severity and outcome are independent. A failed external-send chain may remain high severity, but no UI/report/graph/export may call it sent, delivered, or confirmed. Add regression coverage across every consumer when outcome wording changes.

### Review Inbox and baselines

`review.ts` derives stable finding keys and applies baseline labels. `review-inbox.ts` joins current findings to the latest local decisions. `baseline.ts` strictly parses bounded, non-symlinked versioned policy.

Load-bearing rules:

- baselines label only; never suppress or lower severity;
- every decision binds to session head sequence/hash and policy hash;
- evidence or policy changes make a decision stale;
- invalid policy is fail closed: stale decisions, no new review write, no attestation;
- browser review writes require the per-daemon CSRF token plus existing same-origin/Host checks;
- review actions append; they are never updated in place.

### Attestations and GitHub Actions

`attest.ts` creates a domain-separated Ed25519 v1 envelope from a closed aggregate allowlist. Generation verifies the chain/key/watermark, recomputes current `r4` risk and review state in memory, and checks for concurrent session changes before signing.

Never add prompts, commands, paths, hosts, cwd, session names, raw event bytes, blobs, outputs, or review notes to the attestation. A standalone embedded-key signature is integrity, not trusted origin; local `--check` pins the key and checks the chain/range. Verification may not gate or emit Actions output without `--trusted-key` or `--check`.

`github-check.ts` writes aggregate Markdown to `GITHUB_STEP_SUMMARY` and typed values to `GITHUB_OUTPUT`. It requires pinned/local identity and an exact full commit match against `--expected-commit`/`GITHUB_SHA`; missing or unrelated revision must never pass. No threshold means informational, not pass. Generation requires `--out` to keep the envelope out of workflow logs. It does not use the Checks API or upload artifacts. Keep output sanitization and the metadata-only boundary.

### Custody and egress

Custody layers are: event chain → `chain_meta` → local Ed25519 checkpoints → out-of-DB watermark → optional external receipt. Each file header documents the honest limit. A receipt on the same machine is not off-machine resistance.

`anchor.ts` is not the only explicit output surface. Review changes to all of these as egress:

- external Git/HTTPS receipt emission;
- `otel.ts` when `--endpoint` is supplied;
- `github-check.ts` inside Actions;
- local files written by report/OTLP/attestation commands and later uploaded by another workflow.

Raw evidence stays local by default. Do not add automatic evidence upload.

### Daemon and UI

The daemon is loopback-only. Reads are same-origin and Host-checked; `/git` is token authenticated unless the explicit insecure development flag is used.

`ui-page.ts` concatenates `src/ui/*.ts` string constants into a self-contained page with no runtime dependency. Two conventions are guarded by tests:

- client JavaScript lives inside `String.raw` templates, so raw backticks and `${` corrupt the generated page; build strings with quoted concatenation;
- recorded data is hostile; render it only with DOM nodes/`textContent`, never `innerHTML` or `insertAdjacentHTML`.

Keep direct routes working, especially Review Inbox (`#/review`) and Settings (`#/settings`). Visually inspect desktop and narrow/mobile layouts for user-facing changes.

## Invariants to preserve

- Redact before persistence; on failure, keep a commitment instead of content.
- Never mutate existing event bytes or silently downgrade a store schema.
- Keep rulesets versioned and projections deterministic.
- Keep outcome wording consistent across UI, graph, blast radius, report, and OTLP.
- Fail open for the agent hook, fail closed for evidence claims.
- Preserve unrelated Claude/Gemini settings and use durable absolute hook paths.
- Baselines annotate only; review actions stay append-only and stale safely.
- Keep attestations and Actions output on a closed aggregate metadata allowlist.
- Keep the daemon loopback-only, browser API same-origin, and recorded data text-only.
- Commit only synthetic data. Never commit a real database, session export, private key, local path, credential, review note, or real attestation.
- Do not push, publish packages, create releases, or upload artifacts unless explicitly authorized.

## Documentation

`README.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `docs/BASELINES.md`, and `docs/ATTESTATIONS.md` describe current behavior. `docs/PHASE*.md`, `docs/FORENSIC-ROADMAP.md`, and experiment notes are historical design records and may describe superseded plans.
