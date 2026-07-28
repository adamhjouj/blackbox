# Review baselines

Blackbox baselines label known project behavior in the Review Inbox. They do not suppress evidence, remove a finding, lower severity, change an action outcome, or automatically pass a merge gate.

## Location

Create this file at the root of the repository being reviewed:

```text
<repo>/.blackbox/policy.json
```

Blackbox resolves the repository root from the recorded session working directory. If the directory is not a Git repository, it looks beside that working directory instead.

The `.blackbox` directory and `policy.json` must be real filesystem entries, not symlinks. The file is limited to 64 KiB. Policies are versioned and reject unknown fields, unsupported versions, duplicate ids, empty selectors, and values over their documented limits.

## Example

```json
{
  "version": 1,
  "expected": [
    {
      "id": "approved-generated-cleanup",
      "reason": "The build intentionally replaces only its generated output directory.",
      "rule_ids": ["dangerous-shell"],
      "command_prefixes": ["rm -rf ./generated"]
    },
    {
      "id": "approved-release-host",
      "reason": "Release verification may target the company upload service.",
      "finding_ids": ["exfil-chain"],
      "hosts": ["uploads.example.com"]
    },
    {
      "id": "synthetic-auth-fixture",
      "reason": "The security suite intentionally edits only its synthetic auth fixtures.",
      "rule_ids": ["auth-edit"],
      "paths": ["test/fixtures/auth/**"]
    }
  ]
}
```

Each entry requires:

- `id`: unique, 1–80 characters using letters, numbers, dots, underscores, or dashes;
- `reason`: non-empty reviewer-facing text, at most 1,000 Unicode code points;
- at least one selector category.

The policy supports at most 128 entries. Each selector contains 1–64 non-empty patterns, and each pattern is limited to 512 Unicode code points.

## Selectors

| Field | Matches | Notes |
| --- | --- | --- |
| `finding_ids` | Stable finding category, such as `exfil-chain` or `action-risk` | `*` and `?` globs supported |
| `rule_ids` | Risk flag id, such as `dangerous-shell`, `auth-weaken`, or `recorder-tamper` | `*` and `?` globs supported |
| `hosts` | Normalized observed host | Case-insensitive; `*` and `?` supported |
| `paths` | Normalized observed path | `/`-aware globs: `*` does not cross `/`, `**` does |
| `command_prefixes` | Start of a normalized shell/Git command | Plain values require a command boundary; globs supported |
| `mcp_servers` | Normalized MCP server name | Case-insensitive; `*` and `?` supported |

Selector values inside one category are alternatives (logical OR). Every populated selector category in an entry must match (logical AND).

For example:

```json
{
  "id": "scoped-release-upload",
  "reason": "Only the approved release command may target this service.",
  "finding_ids": ["exfil-chain"],
  "hosts": ["uploads.example.com"],
  "command_prefixes": ["curl"]
}
```

This entry matches only an `exfil-chain` finding that names the approved host and includes a command beginning with `curl`. Adding more categories narrows an entry; it never broadens it.

### Path matching

Paths are normalized to `/` separators and a leading `./` is ignored. A plain relative pattern can match the same suffix inside an absolute captured path. Use:

- `generated/*` for one level below `generated`;
- `generated/**` for any depth below it;
- `/absolute/path` only when the absolute path is intentionally stable.

Avoid broad patterns such as `**` or `*` without another narrowing selector. Baselines remain visible, but overly broad labels still create reviewer fatigue and weaken the usefulness of the expected marker.

### Command prefixes

A plain command prefix matches only at a boundary. `npm test` matches `npm test -- --runInBand`, but not `npm testing`. Glob patterns are anchored at the beginning of the trimmed command.

Commands are sensitive operational metadata. Keep policy examples synthetic and avoid copying secrets or private absolute paths into a version-controlled baseline.

## Review behavior

A matching finding remains in the Review Inbox with its original severity, score, outcome, target, and evidence links. Blackbox adds:

- an **Expected by baseline** label;
- the matching entry id and reason;
- the normalized policy hash used for staleness checks and attestations.

A reviewer must still choose `Acknowledge`, `Expected`, or `False positive` to resolve it. Baseline matching alone does not resolve the finding.

Review decisions bind to both the session evidence head and normalized policy hash. These changes reopen a previously resolved finding:

- new evidence appended to the session;
- any semantic baseline change affecting the normalized policy;
- the policy becoming unreadable or invalid.

Whitespace, object-key order, entry order, and selector-value order do not change the normalized policy hash.

## Fail-closed errors

If a baseline is invalid, unreadable, oversized, or symlinked:

- no baseline match is applied;
- the Review Inbox displays the error;
- prior decisions are treated as stale;
- the review API refuses new decisions;
- session attestation generation refuses to sign the ambiguous review state.

Fix the policy and reload the Review Inbox. Do not delete the policy merely to clear the error unless the project intentionally no longer has baseline expectations.

## Repository governance

Baselines are reviewer-authored repository policy. A contributor able to change the file can change which findings receive an expected label, even though the finding remains visible. Recommended controls:

- require normal code review for `.blackbox/policy.json`;
- use narrow selectors and specific reasons;
- review baseline changes alongside the code/workflow that needs them;
- avoid entries with no planned owner or expiration/review context;
- never use a baseline as a substitute for investigating a new outcome or host.

The normalized policy hash appears in signed session attestations, allowing downstream reviewers to detect that two review snapshots used different policy state without exposing the policy contents.
