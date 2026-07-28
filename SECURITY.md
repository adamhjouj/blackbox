# Security policy

Blackbox records security-sensitive agent activity. Report vulnerabilities privately, and do not include real prompts, credentials, databases, signing keys, review notes, reports, or attestations in a public issue.

## Reporting a vulnerability

Use **GitHub → Security → Report a vulnerability** on the Blackbox repository. Include:

- the affected Blackbox, Node, operating-system, and agent-CLI versions;
- a minimal reproduction using synthetic data;
- the security impact and required attacker capabilities;
- whether redaction, hook authentication, chain integrity, migration, review state, baseline parsing, signing, attestation, or egress is affected.

You should receive an acknowledgement within 72 hours. We will coordinate validation, remediation, and disclosure in the private advisory. Do not open a public issue until a fix or disclosure plan is agreed.

## Supported versions

| Version | Support |
| --- | --- |
| `0.1.x` beta | Security fixes |
| Earlier prototypes and archived phase builds | Unsupported |

The supported Node lines are `22`, `24`, and `26`. Windows is experimental and is not in the current CI matrix.

## Trust boundaries

### Local recorder

The daemon binds to `127.0.0.1`, validates loopback Host headers, keeps browser reads same-origin, and rejects browser-forged ingestion requests. The `/git` route requires a generated token unless the explicit `--allow-insecure-git` development option is used.

Blackbox redacts known secret shapes before persistence and elides tool-output bodies to hashes by default. Redaction is defense in depth: a novel, context-free credential format can escape rules, and `--capture-output` intentionally retains more redacted material.

Claude's asynchronous HTTP hooks and the fail-open Gemini/Codex command bridges are observational. If the daemon is unavailable, a Codex hook has not been trusted, or an agent does not expose a field/event, the action is not made safer or blocked. Missing evidence must not be interpreted as proof that an action did not occur.

### Evidence integrity

The event hash chain detects row changes, broken links, sequence corruption, and—in combination with `chain_meta`—many tail deletions. Local Ed25519 checkpoints and the out-of-database watermark add protection against limited database/signature rewrites. External receipts can prove an older signed head existed when the destination remains outside the attacker's control.

Blackbox does not claim to withstand an attacker who can rewrite the database, signing key, watermark, configuration, hooks, and every external receipt. Git reconciliation corroborates file/ref state, not arbitrary process execution or network delivery.

Additive migrations must preserve legacy event hashes. This build refuses a store stamped with a newer schema version instead of attempting a downgrade.

### Review state and baselines

Review decisions are append-only local rows outside the forensic event chain. They bind to the session head and normalized policy hash. They are evidence of a local UI action, not a cryptographic identity assertion by a named reviewer.

Project baselines at `.blackbox/policy.json` annotate findings only. They never suppress evidence, findings, severity, or outcomes. Policies have a strict schema and size limits and are read without following symlinks. Invalid policies fail closed: decisions become stale, new decisions are refused, and attestation generation is blocked until the policy is corrected.

A repository contributor who can change the baseline can change the expected label and policy hash. Protect policy changes with the same repository review controls used for other security-sensitive configuration.

### Session attestations

A v1 attestation is a signed aggregate snapshot, not the underlying evidence. Its closed payload excludes prompts, commands, paths, hosts, working directories, session names, raw event bodies, mutation blobs, tool output, and review notes. It still contains identifiers and metadata including session id, optional commit/branch, timestamps, recorder fingerprint, finding/review aggregates, and coverage.

Standalone verification proves that the payload was signed by the embedded key; it does not establish who owns that key. Use `blackbox attest verify <file> --check` on the originating recorder or distribute the recorder fingerprint/public key through a trusted channel. Blackbox will not use an unpinned self-signature for `--fail-on` or `--github-output`; verification enforcement requires `--trusted-key` or `--check`. Local checking validates the key, chain, and session range, but intentionally does not require current derived review/risk state to equal a historical signed snapshot.

`--github-output` writes metadata-only values to GitHub Actions-managed summary/output files and can fail the job on unresolved severity. It requires the signed commit to match a full `--expected-commit` or `GITHUB_SHA`, preventing an unrelated clean session from satisfying the current revision's check. In `pull_request` workflows, callers must pass `github.event.pull_request.head.sha` because the default `GITHUB_SHA` normally names the synthetic merge commit; `GITHUB_SHA` is appropriate for `push`. Without `--fail-on`, the result is `informational`, not `pass`. Generation also requires `--out`, so the envelope is not printed to workflow logs. It does not call the Checks API or upload the attestation. Treat workflow logs, summaries, outputs, and uploaded artifacts according to the repository's retention and access policy.

## Privacy and egress

Raw and redacted evidence is local by default. Blackbox has these explicit/configured output surfaces:

- external `git:` or `https:` anchors send signed chain-head receipt metadata only;
- `blackbox otel --endpoint <url>` posts a redacted operational projection that can include action metadata;
- `blackbox attest --github-output` writes aggregate metadata to the Actions run;
- `--out` creates local reports, OTLP files, or attestations that another tool may upload.

Setup discloses proposed Git receipt egress and requires approval unless the user has made an explicit non-interactive choice. A `file:` receipt on the same computer is not off-machine protection.

## Out of scope

Blackbox does not provide:

- kernel-level process or packet attribution;
- prevention, sandboxing, policy enforcement, or rollback;
- proof of remote network delivery beyond tool-reported outcomes;
- complete capture when hooks are dropped, disabled, unsupported, or unavailable;
- anonymity for attestation metadata;
- reviewer identity/authentication or multi-user authorization.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete model and [docs/ATTESTATIONS.md](docs/ATTESTATIONS.md) for attestation-specific verification limits.

## Safe handling

- Never attach `~/.blackbox`, a real `.db`, private key, raw report, or real-session attestation to a public issue.
- Use `npm run demo` and synthetic fixtures for screenshots and reproductions.
- Run `blackbox audit --session <id>` before sharing a report, but do not treat it as a guarantee that all sensitive values were found.
- Inspect an attestation before publication; branch names, commit ids, session ids, and timestamps can still be sensitive metadata.
- Rotate any credential that may have been captured before a redaction rule recognized it.
- Do not weaken repository review around `.blackbox/policy.json` merely because baselines do not suppress findings.
