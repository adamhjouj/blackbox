# Contributing to Blackbox

Thanks for helping make AI-agent activity understandable and reviewable. Security, privacy, and evidence integrity take priority over convenience.

## Set up the project

Use Node.js `22`, `24`, or `26`:

```bash
git clone https://github.com/adamhjouj/blackbox.git
cd blackbox
npm ci
npm test
```

Blackbox contains a native SQLite dependency. Run `npm ci` again after changing Node major versions.

Useful commands:

```bash
npm run build                 # clean TypeScript build into dist/
npm test                      # build + all node:test files
npm run test:packed-install   # pack, install, initialize, diagnose, verify, uninstall
npm run test:codex-live       # opt-in authenticated Codex turn in temporary homes
npm run demo                  # isolated synthetic UI on port 7843
node dist/cli.js help --all   # run the compiled CLI without npm link
```

Every test file imports compiled code from `dist`, so build before running one file directly:

```bash
npm run build
node --test test/baseline.test.js
node --test --test-name-pattern 'failed exfil' test/findings.test.js
```

`test:codex-live` is intentionally not part of CI: it needs an installed, authenticated Codex CLI and makes one model request. The harness copies `auth.json` to a private temporary home, uses installer-generated hooks, records only to a temporary database, and deletes the fixture without changing the normal Codex or Blackbox homes.

When exercising CLI commands by hand, isolate state so you do not touch your real recorder:

```bash
BLACKBOX_HOME=/tmp/blackbox-dev \
BLACKBOX_DB=/tmp/blackbox-dev/blackbox.db \
node dist/cli.js status
```

## Development workflow

1. Create a focused branch from `main`.
2. Add or update tests with the behavior change.
3. Run `npm test` and `npm audit --omit=dev`.
4. Run `npm run test:packed-install` for setup, lifecycle, adapter-install, or packaging changes.
5. Exercise user-facing work with `npm run demo`; inspect desktop and narrow/mobile layouts.
6. Update README, architecture/security documentation, and `CHANGELOG.md` when behavior or a trust boundary changes.
7. Open a pull request that describes the outcome, evidence, migration impact, privacy/egress impact, and honest limitations.

CI runs the build/test suite and packed installer on Node `22`, `24`, and `26` across macOS and Linux.

## Non-negotiable invariants

### Evidence and migrations

- Redact before the first persistent event/blob write. A redaction failure must drop content to a commitment, not leak it.
- Never update or delete an existing event row during rescoring, reconciliation, indexing, pruning, review, attestation, reporting, or UI reads.
- Keep the event column list and hash contract centralized. A hash-format change requires an explicit new schema/version strategy.
- Additive event columns must be nullable for legacy rows unless a tested migration can preserve every old row hash.
- Refuse newer unknown store versions rather than risking a downgrade rewrite.
- Test migrations against a populated legacy database, then verify that event hashes and chain results are unchanged.

### Deterministic interpretation

- Keep risk rules versioned and reproducible. Existing ruleset behavior is frozen; behavioral changes require a new ruleset unless the change corrects an outcome/presentation bug without altering rule firing.
- Severity and outcome are separate. Tool intent without a result is attempted/unknown; a failure event must never be described as successful delivery.
- Keep findings, graph edges, reports, blast radius, UI, and OTLP language consistent with the same outcome projection.
- Git and transcript reconciliation report discrepancy/coverage facts. They must not invent attribution or imply kernel-level observation.

### Adapters

- Every adapter feeds the normalized schema instead of adding vendor-specific branches throughout the product.
- Unknown/missing vendor fields degrade to `null`, `other`, or an explicit unmatched state; never synthesize evidence.
- Redact before retaining adapter correlation material.
- Agent hooks must fail open for the agent. Recorder transport or parse errors cannot deny a tool call.
- Setup must merge and remove only Blackbox-owned hooks, preserve unrelated settings, use durable absolute command paths, and roll back partial changes where practical.

### Review and baselines

- Human review actions stay outside the evidence chain and append rather than update.
- Bind a disposition to the reviewed evidence head and baseline-policy hash so later changes make it stale.
- A baseline may label a finding expected; it must never remove the finding, lower its severity, alter its outcome, or bypass review automatically.
- Baseline parsing stays strict, bounded, and symlink-safe. Invalid policy is a fail-closed state.
- The browser review write route must retain same-origin/Host protection and CSRF validation.

### Attestations and exports

- Attestation generation must verify the chain, recompute current assessment/review state, and detect a concurrent session change before signing.
- Keep the attestation payload a closed allowlist. Never add raw event data, prompts, commands, paths, hosts, working directories, session names, tool output, mutation bodies, or review notes.
- Domain-separate signed bytes and validate the exact schema during standalone verification.
- Do not describe an embedded-key signature as trusted identity. Pin the recorder key/fingerprint when origin matters.
- Never gate or emit GitHub output from an unpinned self-signature; require a trusted public key or verified local recorder.
- Bind Actions output to the full expected commit and refuse missing/mismatched revision metadata.
- Keep no-threshold Actions output informational rather than presenting it as a passing gate, and require `--out` for generation in Actions.
- GitHub Actions output stays aggregate-only and must not upload an artifact or call an external API implicitly.
- Document every new network/export surface. Raw evidence remains local by default.

### Daemon and UI

- Keep the daemon loopback-only and browser reads same-origin with anti-DNS-rebinding Host checks.
- Treat every recorded value as hostile. Render through `textContent`/DOM nodes; never use `innerHTML`, `insertAdjacentHTML`, or equivalent sinks.
- Client JavaScript is embedded in `String.raw` templates. Do not add raw backticks or `${` sequences to UI source strings.
- Keep direct hash routes restorable, including `#/review` and `#/settings`.

### Repository hygiene

- Commit only synthetic evidence and fixtures.
- Never commit a real Blackbox database, session export, private key, local path, credential, review note, or attestation from a real session.
- Do not push tags, publish packages, or create releases from an ordinary contribution.

## Good first contributions

- Synthetic false-positive and outcome fixtures
- Accessibility and keyboard-navigation improvements
- Large-session performance fixtures
- Linux lifecycle documentation and packaging
- Clearer deterministic explanations and containment guidance
- New normalized adapters that preserve the same privacy and provenance contract

For vulnerabilities, use the private process in [SECURITY.md](SECURITY.md), not a pull request or public issue.
