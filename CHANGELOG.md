# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/) after the first stable release.

## [Unreleased]

### Added

- `blackbox doctor` setup and integrity diagnostics
- Explicit first-run privacy disclosure
- Safe full-store erasure and uninstall-with-data controls
- Synthetic, isolated demo environment
- Session titles fall back to the first captured prompt when transcript metadata is unavailable
- Risk cards distinguish causal findings from ordinary per-event flags
- Built-in Health & Privacy page shows the recorder endpoint, storage posture, retention policy, output-body behavior, custody destination, and safe removal commands
- Same-origin `/api/privacy` posture endpoint that never returns collector credentials
- Public security, contribution, conduct, and release documentation

## [0.1.0-beta.1] - 2026-07-14

### Added

- Local Claude Code hook receiver and localhost investigation UI
- Append-only SHA-256 event chain with Ed25519 checkpoints and external receipts
- Capture-time secret redaction and content-addressed mutation evidence
- Versioned risk rules for exfiltration, prompt injection, destructive actions, tool poisoning, and recorder tampering
- Git worktree reconciliation, capture-coverage analysis, environment snapshots, corpus search, file history, blast radius, deterministic reports, and causal graph
- Prompt, agent-stated reasoning, model, token, tool, and nested-step projections

[Unreleased]: https://github.com/adamhjouj/blackbox/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/adamhjouj/blackbox/releases/tag/v0.1.0-beta.1
