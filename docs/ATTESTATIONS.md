# Signed session attestations

A Blackbox session attestation is a portable, Ed25519-signed aggregate snapshot of one recorded session. It is designed for pre-merge checks and external verification without moving the underlying prompt/tool evidence out of the local store.

An attestation is not a forensic report and cannot reproduce its own findings. Preserve the local evidence chain when later investigation may be required.

## Create an attestation

```bash
blackbox attest \
  --session <session-id> \
  --out blackbox-attestation.json
```

`--session` is recommended for deterministic automation. If omitted, the CLI uses the same latest-session selection as `blackbox report` and fails when no eligible session exists.

The output file is created privately (`0600` on POSIX). Blackbox refuses to replace an existing file unless `--force` is supplied:

```bash
blackbox attest \
  --session <session-id> \
  --out blackbox-attestation.json \
  --force
```

Without `--out`, the JSON envelope is written to standard output.

### Revision metadata

Blackbox walks captured session anchors in order and uses the last available commit/branch. A SessionEnd anchor therefore represents the post-work revision when present; older sessions with only SessionStart remain supported. Override revision metadata explicitly only when the evidence and intended revision relationship has been established independently:

```bash
blackbox attest \
  --session <session-id> \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --branch feature/review-gate \
  --out blackbox-attestation.json
```

Commit overrides must be 7–64 hexadecimal characters. Branches are limited to 255 characters and cannot contain control characters. Branch names are included in the signed payload and can be sensitive metadata.

## What generation verifies

Before signing, Blackbox:

1. verifies the complete local event chain against the recorder public key and available signing watermark;
2. refuses a missing/empty session;
3. recomputes the current `r4` risk assessment in memory rather than trusting a stale stored verdict;
4. projects current Review Inbox findings and decisions against the current project baseline;
5. refuses an invalid/unreadable baseline instead of signing ambiguous review state;
6. includes reconciliation coverage only when it describes the current session head;
7. rechecks the session range and whole chain inside the same SQLite read snapshot, so concurrent WAL writers cannot mix database states into one artifact;
8. signs canonical payload bytes under the domain `blackbox-session-attestation-v1` with the local Ed25519 key.

Attestation creation does not append to the event chain or update derived risk/review tables.

## V1 envelope

The JSON envelope has four top-level fields:

```json
{
  "format": "blackbox-session-attestation",
  "version": 1,
  "payload": {},
  "public_key": "-----BEGIN PUBLIC KEY-----\n...",
  "signature": "base64..."
}
```

The strict, signed payload contains only:

- session id;
- first/last sequence, last event hash, and event count;
- optional commit and branch;
- recorder id and public-key fingerprint;
- normalized agent sources (`claude-code` and/or `gemini-cli`);
- current ruleset id/fingerprint, verdict, score, and aggregate finding counts by severity/outcome;
- aggregate review status, dispositions, stale/unresolved counts, unresolved counts by severity, and normalized policy hash;
- available aggregate reconciliation/coverage counts;
- canonical issue timestamp.

Unknown fields are rejected during verification. This prevents a future producer from placing sensitive data in an unsigned or ambiguously interpreted extension.

### Excluded evidence

The payload construction and privacy tests exclude:

- prompt and agent-response/reasoning text;
- commands and tool arguments;
- paths, working directories, and project/session display names;
- observed hosts and MCP arguments;
- raw event payloads and mutation blobs;
- tool-output bodies;
- review notes;
- environment snapshots and secrets.

The artifact is metadata-only, not anonymous. Session id, optional revision, timestamp, recorder fingerprint, risk/review aggregates, and coverage can still reveal operational context. Inspect an artifact before distributing it.

## Verify an attestation

### Self-contained signature check

```bash
blackbox attest verify blackbox-attestation.json
```

This validates the exact v1 schema, payload invariants, recorder fingerprint/public-key relationship, and Ed25519 signature. It proves that the payload has not changed under the embedded public key. It does not prove who owns that key.

### Pin an expected recorder key

```bash
blackbox attest verify \
  blackbox-attestation.json \
  --trusted-key recorder-signing.pub
```

This additionally requires the embedded key to equal the supplied Ed25519 public key. Distribute the key or its fingerprint through a channel independent of the attestation.

Blackbox refuses to combine self-contained/unpinned verification with `--fail-on` or `--github-output`. Those enforcement modes require `--trusted-key` or `--check`; otherwise an attacker could substitute a clean artifact signed by an unrelated key.

### Compare with the originating local store

```bash
blackbox attest verify blackbox-attestation.json --check
```

`--check` requires the local evidence database, `signing.pub`, and available watermark. It verifies:

- the attestation signature;
- equality with this recorder's trusted public key;
- the complete local evidence chain;
- the session event count, first/last sequence, and last hash.

Local comparison intentionally does not require today's derived risk or review state to match a historical attestation. Baselines, acknowledgements, and rules-derived state can legitimately evolve after the artifact was signed. Generate a new attestation to publish a new review snapshot.

Verification reads at most a 1 MiB regular attestation file and rejects unstable/non-regular inputs. Trusted public-key files are also bounded. No-follow descriptors are used where supported, with filesystem identity checks as the fallback.

## Review gates

`--fail-on` evaluates the signed current unresolved counts. It is valid while generating with the local recorder key; when verifying an existing artifact, it requires `--trusted-key` or `--check`:

| Threshold | Exit `1` when the attestation has… |
| --- | --- |
| `high` | one or more unresolved high findings |
| `medium` | one or more unresolved high or medium findings |
| `low` | one or more unresolved findings of any severity |

Examples:

```bash
# Gate while generating from the local evidence store
blackbox attest \
  --session <session-id> \
  --out blackbox-attestation.json \
  --fail-on medium

# Gate a previously signed artifact under a pinned key
blackbox attest verify \
  blackbox-attestation.json \
  --trusted-key recorder-signing.pub \
  --fail-on medium
```

Baselines do not remove unresolved findings. A reviewer disposition resolves a finding only while it is current for the evidence head and policy hash.

## GitHub Actions output

Inside a GitHub Actions runner, add `--github-output` to generation or verification:

```yaml
- name: Verify Blackbox review attestation
  id: blackbox
  env:
    BLACKBOX_EXPECTED_COMMIT: ${{ github.event.pull_request.head.sha }}
  run: |
    blackbox attest verify \
      blackbox-attestation.json \
      --trusted-key .github/blackbox-recorder.pub \
      --github-output \
      --expected-commit "$BLACKBOX_EXPECTED_COMMIT" \
      --fail-on medium
```

For a `pull_request` event, bind the artifact to `github.event.pull_request.head.sha` as above. GitHub's `GITHUB_SHA` is normally the event's synthetic merge commit, which will not match an attestation produced for the PR head. On a `push` event, use `GITHUB_SHA` (or omit `--expected-commit` and let Blackbox use it by default).

The command requires `GITHUB_ACTIONS=true` and at least one runner-provided destination:

- `GITHUB_STEP_SUMMARY`: receives a Markdown table of signed aggregate values and the verification trust level;
- `GITHUB_OUTPUT`: receives named `blackbox_*` step outputs (GitHub serializes output values as strings).

It also requires:

- a pinned recorder identity (`--trusted-key` or `--check`) when verifying an existing artifact;
- `--out` when generating, so the full envelope is not printed into Actions logs;
- a full 40- or 64-hex expected commit supplied by `--expected-commit` or the runner's `GITHUB_SHA`;
- exact equality between that expected commit and the commit inside the signed payload.

A missing or mismatched revision is an error, not a pass or informational result. This prevents a clean session from another revision being used for the current pull request.

Current outputs are:

```text
blackbox_result
blackbox_session_id
blackbox_verdict
blackbox_score
blackbox_unresolved
blackbox_unresolved_high
blackbox_unresolved_medium
blackbox_unresolved_low
blackbox_recorder_id
blackbox_attestation_file
```

The threshold exit status makes the normal Actions job become the repository's pass/fail check. Blackbox does not call GitHub's Checks API, need a GitHub token, set branch protection, or upload the attestation file.

Without `--fail-on`, the summary is explicitly informational and `blackbox_result=informational`; it is not reported as a passing gate.

The runner summary/output files are opened as regular append-only files without following symlinks. Values are stripped of control/newline characters, Markdown table values are escaped, and only the attestation basename—not its local path—is emitted.

### Generate on a runner with local evidence

If a self-hosted or ephemeral runner has the Blackbox database and recorder key, it can generate and report in one step:

```yaml
- name: Create Blackbox review result
  env:
    BLACKBOX_DB: ${{ runner.temp }}/blackbox/blackbox.db
    BLACKBOX_HOME: ${{ runner.temp }}/blackbox
    BLACKBOX_EXPECTED_COMMIT: ${{ github.event.pull_request.head.sha }}
  run: |
    blackbox attest \
      --session "$BLACKBOX_SESSION_ID" \
      --out "$RUNNER_TEMP/blackbox-attestation.json" \
      --github-output \
      --expected-commit "$BLACKBOX_EXPECTED_COMMIT" \
      --fail-on medium
```

The example targets `pull_request`. For a `push` workflow, set `BLACKBOX_EXPECTED_COMMIT: ${{ github.sha }}` instead.

Do not copy a raw Blackbox database or private signing key to a hosted runner merely to obtain a check. Prefer creating the signed artifact where the evidence already lives, then verify it in CI under a pinned public key. Any transfer/storage mechanism is outside Blackbox and must follow your access and retention policy.

## Exit behavior

- `0`: signature/check succeeded and the optional review threshold passed, or no threshold produced informational output;
- `1`: invalid/tampered attestation, local range/chain mismatch, or unresolved findings at the chosen threshold;
- `2`: usage, unsafe input/output, missing local trust material, invalid generation state, or runner configuration error.

`--github-output` can still write a fail summary before the command exits `1` for the threshold.

## Trust checklist

Before using attestations for merge gating:

- pin the recorder public key or verify against the originating local store;
- protect `.blackbox/policy.json` changes with repository review;
- decide which unresolved severity threshold matches the repository's risk tolerance;
- retain the local evidence chain for the investigation window;
- review Actions summary/artifact retention and access;
- do not mistake tool-reported success or absence of evidence for kernel-observed delivery/completeness;
- generate a new attestation whenever you want current review state represented.
