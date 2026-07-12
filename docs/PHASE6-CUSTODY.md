# Phase 6 (R3) — Chain-of-custody hardening

Phases 0–5 made the store tamper-**evident**: a local SHA-256 hash chain plus a same-file `chain_meta` head anchor. Its honest limit (stated at `store.ts`): an attacker who rewrites the whole chain *and* the anchor consistently passes `verify()` — a local chain proves internal consistency, not that it wasn't re-authored. R3 closes that with **cryptographic signing**, and ships a real **forensic case-file**.

## The load-bearing rule (unchanged)
> Facts → the hashed chain. Interpretations/derivations → separate, never hashed.

Signatures are **derived from** the immutable chain (they sign the head hash) and stored **outside** it, in a new un-hashed `signatures` table. Signing never touches `events`/`chain_meta`, so **`verify()` is byte-identical before and after** (asserted in tests). This is the same discipline as the risk and reconciliation layers.

## What shipped
- **Ed25519 signing (`src/sign.ts`, Node `crypto`, zero deps).** `blackbox init` generates a keypair once: private key `~/.blackbox/signing.key` (chmod **0600**, outside the DB), public key `~/.blackbox/signing.pub`. `signHead(store, keys, nowIso)` signs `blackbox-checkpoint\nseq=<S>\nhead=<H>\nts=<T>` and appends a checkpoint `{seq, head_hash, sig, pubkey, ts}` to the `signatures` table. Idempotent — never re-signs the same head; a no-op on an empty chain.
- **The daemon signs at session boundaries** (`session_start`/`session_end`/`stop`) plus a startup checkpoint — off the hook path, in `try/catch`, so signing can never fail a recording. This bounds the signature count (~2/session) while checkpointing every boundary and any downtime gap.
- **`verify` upgrade (`src/verify.ts`).** New optional `{ trustedPublicKey, watermark }`. When supplied, after the chain walk every signed checkpoint must (a) verify under the trusted key and (b) still match the chain at its seq (three break shapes: wrong-key re-sign, truncation below a signed head, content altered after signing). **`verify(store)` with no key is unchanged** — the 160 existing tests and all read callers are unaffected. `blackbox verify` now loads `signing.pub` and reports `N signed checkpoint(s) OK`.
- **Anti-deletion watermark (`signing.head`, 0600).** A same-file `signatures` table is defeated by a local DB writer who just `DELETE FROM signatures` — no key needed (caught in adversarial review). So `signHead` also records the newest checkpoint out of band in `signing.head`; `verify` (given the watermark) requires that exact `{seq, head_hash}` to still be present and valid in the DB. A DB-only attacker who deletes or rolls back the signatures can't reach the watermark file → the removal is caught.
- **Forensic case-file (`blackbox report --forensic`).** A self-contained evidentiary bundle: chain-of-custody block (`verify()` status, head hash, the covering Ed25519 signature + key fingerprint, the honest-limit statement), the plain-English risk report, the provenance story (files changed + commits), and a **SHA-256 manifest of the whole document** so the case-file is itself tamper-evident. `--anchor <url>` is a wired **stub** for remote head anchoring.

## The money-shots (verified in tests)
- **Wrong-key rewrite:** rewrite the whole chain consistently (internal walk passes) and re-sign the head with a *wrong* key → `verify` (with the trusted `signing.pub`) reports `signature-invalid`. Without the private key an attacker can't forge a checkpoint.
- **Signature deletion (`DELETE FROM signatures`):** a DB-only writer removes the signatures and rewrites freely → the `signing.head` watermark still points at a checkpoint that's now missing → `verify` reports `signature-invalid` (deleted or rolled back).

## Honest limit (stated here, in the case-file, and the README) — corrected after adversarial review
What R3 **detects** (given the trusted `signing.pub` + `signing.head`, which live outside the DB): wrong-key re-signing, content alteration at/below a signed head, and **signature deletion/rollback by a writer who can't reach the watermark file**. What R3 does **not** resist: an attacker with **full write access to `~/.blackbox`** (the DB *and* the key/watermark files) can re-sign a rewrite. That is only stopped by shipping signed heads off-machine to a key/log the local user doesn't control — the `--anchor` path / enterprise tier. R3 does not overclaim: the first draft's "catches the rewrite" was too strong (deletion needs no key); this is the accurate scope.

## Files
`src/sign.ts` (new) · `src/store.ts` (signatures table + CRUD, `SignatureRow`) · `src/verify.ts` (checkpoint check, `signature-invalid`) · `src/daemon.ts` (boundary + startup signer, off hook path) · `src/init.ts` (keygen) · `src/report.ts` (`buildForensicReport`) · `src/cli.ts` (`report --forensic`, `--anchor`, signed `verify`) · `test/sign.test.js` (8 tests).

## Verification
`test/sign.test.js`: sign→verify round trip; **wrong-key rewrite → `signature-invalid`**; no-key `verify` ignores signatures (backward compat); signing byte-identical to the chain; case-file bundles custody + a valid self-manifest; **secret in a mutated file never appears in the case-file** (redaction); `signHead` idempotency + empty-chain no-op; keypair idempotency + 0600 perms. Full suite green.
