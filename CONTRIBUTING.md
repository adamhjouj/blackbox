# Contributing to Blackbox

Thanks for helping make AI-agent activity understandable and reviewable. Security and evidence integrity take priority over convenience: changes must preserve append-only capture, fail-closed redaction, deterministic projections, and hostile-data-safe rendering.

## Set up the project

```bash
git clone https://github.com/adamhjouj/blackbox.git
cd blackbox
npm ci
npm test
```

Use Node.js 18, 20, or 22. Blackbox contains a native SQLite dependency, so switching Node versions requires `npm ci` again.

## Development workflow

1. Create a focused branch from `main`.
2. Add or update tests with the implementation.
3. Run `npm test` and `npm audit --omit=dev`.
4. Exercise user-facing changes with the synthetic environment: `npm run demo`.
5. Open a pull request describing behavior, evidence, security impact, and honest limitations.

## Non-negotiable invariants

- Redact before the first persistent write; a redaction failure must drop content, not leak it.
- Never render recorded data with `innerHTML`, `insertAdjacentHTML`, or an equivalent unsafe sink.
- Keep the read API same-origin and the daemon loopback-only.
- Do not mutate existing event bytes during rescoring, reconciliation, indexing, pruning, or UI reads.
- Keep risk rules versioned and deterministic.
- Never commit real Blackbox databases, session exports, signing keys, local paths, or credentials.

## Good first contributions

- False-positive fixtures for risk or redaction rules
- Accessibility and keyboard-navigation improvements
- Linux lifecycle documentation and packaging
- Performance fixtures for very large sessions
- Clearer deterministic explanations and containment guidance

For vulnerabilities, use the private process in [SECURITY.md](SECURITY.md), not a pull request or public issue.
