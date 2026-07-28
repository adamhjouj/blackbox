# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/) after the first stable release.

## [Unreleased]

### Added

- Durable one-command bootstrap: `npx --yes blackbox-recorder@beta install` installs the exact running package globally before first-run setup, preventing hooks and autostart from pointing into an `npx` cache.
- First-run agent selection for Claude Code, Gemini CLI, Codex CLI, or any combination, with a privacy disclosure, custody decision, daemon health gate, isolated recorder self-test, hook rollback, and direct Health & Privacy navigation.
- `blackbox self-test` for isolated capture, redaction, deterministic risk, signing, and verification checks without touching the user's evidence chain.
- Recorder readiness and Health & Privacy UI with adapter-hook, runtime, key, daemon, custody, database, retention, and chain checks at `#/settings`.
- First-party Gemini CLI adapter using the shared normalized event schema, bounded redacted FIFO tool correlation, non-destructive settings merge/backups, and a fail-open command-hook bridge.
- First-party Codex CLI adapter using native lifecycle hooks and stable session/turn/tool ids, strict outcome mapping, non-destructive `hooks.json` merge/backups, trust guidance, and a fail-open command-hook bridge.
- Event-source attribution for Claude Code, Gemini CLI, Codex CLI, Git, and Blackbox-generated events.
- Pre-merge Review Inbox at `#/review`, grouped by project/revision/session with severity, action outcome, local notes, and acknowledged/expected/false-positive/reopen decisions.
- Append-only `review_actions` ledger. Decisions bind to the evidence head and policy hash and become stale when either changes.
- Strict project baselines at `.blackbox/policy.json`, with normalized fingerprints and selectors for finding ids, rule ids, hosts, paths, command prefixes, and MCP servers.
- Portable v1 Ed25519 session attestations containing a closed aggregate metadata projection of evidence, revision, recorder, sources, current assessment, review state, and reconciliation coverage.
- Standalone attestation schema/signature verification and optional local recorder/chain/range checking.
- Optional GitHub Actions summary and named step outputs from `blackbox attest --github-output`; `--fail-on high|medium|low` turns unresolved signed severity aggregates into job exit status, while no threshold remains informational.
- Full revision binding for Actions output through `--expected-commit` or `GITHUB_SHA`.
- Node `22`, `24`, and `26` build/test and packed-install CI coverage on macOS and Linux.
- Focused baseline and attestation documentation.

### Changed

- Supported Node engines are now `^22 || ^24 || ^26`; unsupported Node `18` and `20` guidance was removed.
- `blackbox init` starts and health-checks the daemon and passes an isolated self-test before modifying agent settings.
- Gemini hook configuration uses absolute paths to the durable Node runtime and Blackbox CLI.
- Setup and Settings now state the local-evidence posture and distinguish local-only receipts from off-machine custody.
- Session findings use one outcome projection—attempted, succeeded, failed, or unknown—across explanations, Review Inbox, graph, blast radius, Markdown reports, and OTLP export.
- Dashboard and sidebar review counts now reflect unresolved Review Inbox findings rather than raw verdict/flag counts.
- Documentation now distinguishes signed receipt egress, explicit OTLP export, GitHub Actions aggregate output, and local `--out` files.
- Public documentation now describes Claude Code, Gemini CLI, and Codex CLI as supported adapters and treats historical phase documents as design records rather than the current product contract.

### Fixed

- Failed external-send/exfiltration attempts retain appropriate severity but are no longer described as sent, delivered, or confirmed.
- Pre/post/failure pairs now produce consistent action outcomes even when events arrive in unusual order or correlation is unavailable.
- Gemini MCP names now preserve the documented server/tool boundary in Blackbox's canonical `mcp__server__tool` identity, keeping server-aware review and tool-poisoning correlation intact.
- Adding nullable source attribution preserves legacy evidence hashes and chain verification.
- Opening a legacy store creates the review ledger additively without rewriting evidence.
- Review decisions automatically reopen when the session head or baseline policy changes.
- Invalid baseline state is no longer confused with no baseline; it invalidates prior decisions and blocks new decisions/attestations until corrected.
- Review Inbox cards no longer render absent optional baseline metadata as literal `null` text.
- First-run config, key, and adapter settings writes are atomic and preserve unrelated/unknown fields; Claude, Gemini, and Codex settings changes use private, versioned, no-clobber backups.

### Security

- New state/config/key files use private POSIX modes where supported, and existing SQLite files are tightened during safe additive open migration.
- Baseline files are bounded, schema-strict, and read without following project-policy symlinks.
- Attestation generation verifies local chain/key/watermark state and recomputes current risk and review projections inside one consistent SQLite snapshot before signing.
- Attestation payload tests recursively exclude prompts, commands, paths, hosts, working directories, session names, raw payloads, blobs, tool output, and review notes.
- Attestation gating/Actions output refuses unpinned self-signatures and requires a trusted public key or local recorder comparison.
- Actions output refuses a missing or mismatched signed commit and generation requires an output file to avoid logging the envelope.
- GitHub Actions output contains aggregate signed metadata only and performs no implicit artifact upload or direct Checks API request.
- Raw evidence remains local by default; enabled external anchors emit signed chain-head receipt metadata only.

## [0.1.0-beta.1] - 2026-07-14

### Added

- Local Claude Code hook receiver and localhost investigation UI.
- Append-only SHA-256 event chain with Ed25519 checkpoints and external receipts.
- Capture-time secret redaction and content-addressed mutation evidence.
- Versioned risk rules for external-send chains, prompt injection, destructive actions, tool poisoning, and recorder tampering.
- Git worktree reconciliation, capture-coverage analysis, environment snapshots, corpus search, file history, blast radius, deterministic reports, and causal graph.
- Prompt, agent-stated reasoning, model, token, tool, and nested-step projections.

[Unreleased]: https://github.com/adamhjouj/blackbox/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/adamhjouj/blackbox/releases/tag/v0.1.0-beta.1
