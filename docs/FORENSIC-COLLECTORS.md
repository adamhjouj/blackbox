# Forensic collectors — what we capture, how, and at what friction

Synthesis of the collector research + empirical tests run 2026-07-11 on macOS 26.5.1 (Apple Silicon), Claude Code 2.1.206. Decision: **V1 ships Tier 1 only.** Tier 2/3 are documented here so the roadmap is captured, not to build now.

The mental model: **hooks record what the agent *said* it did; every OS-level collector records what the machine *actually did*, so the two can be reconciled and the agent can't quietly lie.**

---

## Tier 1 — V1 scope (zero-friction, no root, no entitlement, one-command install)

| Collector | Captures (ground truth) | Attribution | Perms | Verified |
|---|---|---|---|---|
| **Claude Code hooks** (HTTP + `async`) | Intent + result at the tool boundary: full `tool_input`, full `tool_response`/`error`, `duration_ms`, `tool_use_id`, `prompt_id`, subagent `agent_id`/`agent_type` | It's the agent's own event surface | none | ✅ `docs/DAY1-FINDINGS.md`, `experiments/day1-hooks/` |
| **git `reference-transaction` hook** | Every ref mutation with old→new SHA: commit, amend, `reset --hard`, branch/tag create+delete, rebase, force-push targets | It's the repo's own hook, running as a child of the git process | none | ✅ `experiments/four-collectors-demo/` |
| **`lsof`/`nettop` poll (~1s)** | Observed `pid → remote IP:port` for established connections | same-uid PID → agent process tree | none (unprivileged) | ✅ live: caught `curl → Cloudflare 443` |
| **ppid process-tree** from agent PID | The exec chain (which process spawned the connection / the write) | ppid walk seeded at the Claude node PID | none | ✅ live |
| **FSEvents / `fs.watch`** | *Unattributed* file-change corroboration (paths changed) | ⚠️ none — FSEvents carries **no PID** | none | (documented; not yet wired) |
| **`HTTPS_PROXY` injection** *(optional aid)* | Attribution-by-construction for proxy-honoring programs | by construction | none | (documented; not yet wired) |

**Honest Tier-1 limits — state these in the README, they build trust:**
- **Not in the request path.** We catch the *consequence*, never block the *cause*. Prompt injection is detected after the fact.
- **No packet contents.** We record "connected to `162.159.140.220:443`", not the bytes (TLS anyway). Phrase as *"an outbound transfer-shaped command ran to X,"* never "data was exfiltrated."
- **Network polling is lossy.** A connection shorter than the poll interval can be missed. The hook still has the full command string (incl. URL) regardless — the poller only adds the confirmed *resolved IP*. Label polled flows best-effort.
- **Hooks are agent-self-reported.** A process that detaches and re-parents to `launchd` breaks the ppid tree; a write via a subprocess yields only a command string. Closing that gap is exactly what Tier 2 (kernel-level) does — deferred.

---

## Tier 2 — DEFERRED (opt-in "deep mode"; documented, not in V1)

**Endpoint Security (ES)** — Apple's kernel event-subscription framework (the userspace replacement for `kauth` kexts; the substrate EDR tools like CrowdStrike sit on). Gives unbypassable, kernel-level, attributed **exec/fork/file** events. **Critical gap: ES has NO TCP/UDP events** — only UNIX-domain/XPC sockets. So even full Tier 2 does *not* complete network capture.

- **Prototype path:** `sudo eslogger exec fork write create rename unlink open …` → newline-delimited JSON. No native client / no Apple entitlement needed (`/usr/bin/eslogger` is already Apple-signed with the ES entitlement). But Apple says its output "is NOT API… may change from release to release without warning" — **version-fragile; pin a schema_version and alert on unknown versions.**
- **Attribution (the load-bearing correction):** build the process tree via **`(pid, pidversion)` + `parent_audit_token`**, seeded at the agent's known node PID. A bare PID is unsafe (macOS recycles PIDs; `pidversion` disambiguates). **Do NOT use `responsible_audit_token`** — live testing showed it resolves to the process *itself* (or Terminal.app) when responsibility is disclaimed via `posix_spawn`, which dev tooling does routinely. `original_ppid` "stays constant even if reparented," unlike the `ppid` that Tier 1 polls — that's the hole ES closes.
- **Permissions (why it's deep-mode, not default):** requires **root** (mandatory — verified: unprivileged fails `ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED`) via a root LaunchDaemon or sudoers rule, **plus a one-time Full Disk Access (TCC) grant** that is a *manual* System Settings toggle — cannot be granted programmatically without MDM. The installer must detect a missing FDA grant and explain it.
- **Completeness is monitored, not assumed:** ES NOTIFY events drop under load; watch `seq_num`/`global_seq_num` gaps and flag "may have missed events here." Also: eslogger auto-suppresses its own process group, so the daemon must not launch from inside the agent tree it watches.

**Why deferred despite being the "teeth":** a *robust* Tier 2 is a root daemon (privileged signed installer + uninstall story), an FDA onboarding flow you can't automate, and a parser that breaks on macOS point releases — a root-privileged daemon parsing an event firehose is itself a reputational attack surface for a *security* tool. And it doesn't change what V1 is testing (retention on the timeline experience). If/when we add it: ship as opt-in deep-mode via `sudo eslogger` first; the process-tree attribution engine is the **same code** whether fed by Tier-1 ppid polls or Tier-2 ES events, so it's a clean seam, not a rewrite.

---

## Tier 3 — future "blackbox.app" (gap-free network)

**`NEFilterDataProvider`** (NetworkExtension system extension) is the only event-driven, no-root path to per-flow network capture with `sourceProcessAuditToken` (macOS 13+). Its entitlement is self-serve Developer ID (not an Apple petition), but it demands a paid developer account, notarization, an `.app` in `/Applications`, and user-approval dialogs — the wrong friction class for a V1 CLI, right for a later packaged app tier. Root alternative: `pktap` via `tcpdump -k` (per-process packets; `/dev/bpf*` is root-only).

---

## Explicitly do NOT ship (dead ends found in research)

- **mDNSResponder unified-log DNS collector** — did not reproduce unprivileged on 26.5.1 (needs an admin-installed Apple debug profile even to emit query logs). Fragile/opt-in at best.
- **`pktap`/`tcpdump`** except as a `sudo` debug command — kernel-enforced root.
- **BSM `/dev/auditpipe`** — Apple: "deprecated since macOS 11.0, disabled since 14.0, WILL BE REMOVED."
