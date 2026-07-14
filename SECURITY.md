# Security policy

Blackbox records security-sensitive agent activity. Please report vulnerabilities privately and avoid including real prompts, credentials, databases, signing keys, or forensic exports in a public issue.

## Reporting a vulnerability

Use **GitHub → Security → Report a vulnerability** on the Blackbox repository. Include:

- the affected version and operating system;
- a minimal reproduction using synthetic data;
- the security impact and attacker prerequisites;
- whether redaction, chain integrity, hook authentication, or remote anchoring is affected.

You should receive an acknowledgement within 72 hours. We will coordinate validation, remediation, and disclosure in the private advisory. Please do not open a public issue until a fix or disclosure plan is agreed.

## Supported versions

| Version | Support |
| --- | --- |
| `0.1.x` beta | Security fixes |
| Earlier prototypes | Unsupported |

## Trust boundaries

Blackbox is local-first and binds its UI/API to `127.0.0.1`. It redacts known secret shapes before persistence and stores most tool output as a hash rather than a body. External anchoring is the intentional exception to local-only operation: it sends signed chain-head receipts, never recorded events or source code.

Blackbox does **not** claim to withstand an attacker who can rewrite the database, signing key, watermark, configuration, hooks, and every external receipt. It does not currently provide kernel-level process/network attribution, prevention, sandboxing, or rollback. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete model and limitations.

## Safe handling

- Never attach `~/.blackbox`, a real `.db`, signing keys, or raw case files to an issue.
- Use `npm run demo` for screenshots and reproductions.
- Run `blackbox audit` before sharing a report.
- Rotate any credential that may have been captured before a redaction rule recognized it.
