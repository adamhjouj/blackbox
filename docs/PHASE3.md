# Phase 3 — The Risk Engine (ruleset r2)

Phase 2 showed *ephemeral* signals. Phase 3 makes them a real risk engine: versioned, scored, **persisted**, with **combination logic** (the flagship) and a session-level verdict surfaced in the timeline. **r1** shipped the exfil-chain combo. **r2** (this update) recalibrates scoring to kill per-event noise and adds two combo families: **injected-tamper** and **tool-poisoning**.

## The load-bearing rule
> **Facts observed at capture time → the hashed `detail` column. Interpretations (scores, flags, combos, verdicts) → a separate, unhashed, re-derivable `risk` layer.**

Risk is a **pure function of the immutable chained events**, so its integrity comes from *recomputability* (`blackbox rescore --check`), not from being hashed. Consequences, all verified on the real DB and in the test suite:
- **`verify()` is byte-identical before and after any rescore** — the forensic record is never touched.
- Rules improve by **version bump**, never by rewriting history. `rulesFingerprint('r1')` is **byte-frozen** — it equals the hash stored by the original r1 code (`sha256:92ec93a2…`), so every r1 report stays reproducible after the r2 bump.
- Combos are retroactive (an earlier antecedent is implicated only when a later consequent arrives) and live at the session level, which an append-only hashed row could never represent.

## r2 recalibration — why the timeline is quiet now
Measured over 38 real sessions, `secret-touch` fired **345×** (one session 180×), painting a third of every large timeline. Its value is as a **combo antecedent**, not a per-event chip. r2 fixes this without weakening detection:

- **Two flag classes** (`risk-rules.ts`): `RISK_FLAGS` (`dangerous-shell, auth-edit, mass-diff, destructive-git`) score >0 and paint the timeline red; `ANNOTATION_FLAGS` (`secret-touch, external-send, new-mcp-server, injection-output, failed`) score **0** — combo fuel / muted context. Combos key off flag **presence**, so zeroing the score changes nothing they do.
- **Presentation split** (`read-api.ts`): an annotation lands in `signals` (a row chip) only if it's an always-show kind (`external-send`/`injection-output`/`new-mcp-server`, rendered muted) or sits on a fired combo's cited seq; otherwise it drops to `notes` (dossier-only). The full flag list is always in `/api/event`. Result on the real "design" session: 616 rows went from ~119 chips to **1 red risk chip** + a few muted, 107 notes hidden — verdict LOW, not a false MEDIUM.
- **`dangerous-shell` rm re-scope**: r2 fires `rm -rf` only on catastrophic targets — bare `/ ~ $HOME $PWD * . .. ./` wipes, bare top-level dir wipes (`/app`), **system/home-root** shallow paths (first segment in `etc/usr/var/opt/srv/Users/home/…`, depth ≤2), deep-but-catastrophic prefixes (`/var/lib/*`, `/usr/local/*`, `/var/www/*`), sensitive `~`/`$HOME` children (`.ssh`, `.aws`, …), and `.git/.svn/.hg`. `/tmp`, `/var/tmp`, `/var/folders`, and non-system deep paths (`/app/node_modules`, `/data/cache`) are exempt. Quote-blanking keeps `grep 'rm -rf /etc'` a literal (no fire) while catching a quoted real target (`rm -rf "/"`). This cleared all 84 observed FPs plus the container-path FPs and deep-catastrophic FNs found in review. **r1's rm is untouched.**
- **Verdict math is FROZEN** (`aggregate()` unchanged, `medScore 50`): a lone `auth-edit`/`mass-diff` still reaches MED; the noise reduction comes entirely from the score demotion, never from moving thresholds. (Rejected the first draft's 50→60 raise, which silently demoted a single-file auth backdoor to LOW.)

## r2 combos

**exfil-chain** (r1, version-independent): `secret-touch` → `external-send` carrying a sensitive file ⇒ HIGH; temporal variant ⇒ MED.

**injected-* family** — a **provenance-gated** antecedent: an injection-shaped output on an **untrusted channel** whose captured i1 patterns **arm**, then a dangerous consequent within 20 seq. Arming is **channel-aware**: an `mcp_call` (clearly untrusted tool output) arms on one strong marker (`ignore-instructions`/`disregard`/`override-safety`/`conceal-from-user`); a `web_fetch` needs **corroboration** (≥2 markers), because a security article or doc commonly *quotes* a single injection string. `reveal-prompt`/`fake-role-tag` never arm.
- `injected-tamper` — a **strong** auth-path write (excludes ambiguous `middleware`/`guard`); HIGH, or MED on a test path.
- `injected-exfil` — **any** external send (data-bearing PUSH, a query-payload GET, or a remote MCP call — the armed antecedent is a strong enough gate). `injected-rce` — a dangerous shell. `injected-ci-write` — a write to CI/build config (`.github/workflows`, `Jenkinsfile`, `package.json`, `Makefile`, …).

The provenance gate is the key FP control: reading a local file that merely *contains* an injection string never arms — so injection-detection work on this very repo can't manufacture a tamper verdict.

**tool-poisoning** — a server first-seen this session (`new-mcp-server`) that later, via an `mcp__server__*` call, ships a sensitive local file the session **already read** (data-flow link) ⇒ HIGH. The "already read" set is derived from the **event itself**, not from redaction evidence — a real `.env` read is redacted and its `secret-touch` hit carries no path, so relying on that would silently disable the combo in production. External host is optional evidence, never the trigger. A first-contact MED tier (new server names a never-read sensitive file) is designed but **shipped disabled** — a filesystem MCP reading `.env` directly is plausible.

All new combos are gated on `rulesetNum(ruleset) >= 2`, so an r1 replay is byte-identical.

## Verified
- **86-test suite** (`npm test`, `node --test`): rm target matrix (positives, FP-safes incl. container paths, deep-catastrophic prefixes, flag-form evasions, anti-literal), all five combo families (positives + negatives: provenance, weak arming, `web_fetch` single-marker, `middleware`, window, never-arm, no-prior-read, git-push), a **redacted-read** tool-poisoning regression, query-payload injected-exfil, the r1 version-gate, and four invariants — golden `rulesFingerprint('r1')`, `computeSession`==live-hydrate equivalence, rescore idempotency, `verify()` byte-identical.
- **Adversarial review round**: an independent reviewer found a production-killing bug (tool-poisoning's data link was starved by redaction), an unvalidated-`--ruleset` crash, and calibration gaps (web-research FP, rm FN/FP, query-payload exfil). All fixed and re-tested; the tool-poisoning bug is now guarded by a `redaction_count>0` fixture.
- **Real DB migration**: 48 sessions rescored under r2 → verdict spread **45 none / 2 med / 1 low** (was per-event chip chaos); `rescore --check` green for both r2 (active) and r1 (frozen). The worst session's timeline dropped from ~119 chips to 1 red risk chip.

## Known limitations (honest)
- injected-* / tool-poisoning are verified on **synthetic fixtures** — the recorded corpus has **zero MCP activity** (no `mcp_call` events), so live-data coverage of these two is pending real MCP sessions.
- Injection recall is **forward-only**: pre-scanner sessions carry no injection fact.
- tool-poisoning v1 misses the **case-(ii)** rug-pull where a poisoned MCP tool causes a *shell/file* action rather than an `mcp__` call, and its data link is an **exact path-string match** (read `/app/config/.env`, ship `config/.env` evades) — the near-zero-FP choice for v1, at the cost of some recall.
- `injected-ci-write` includes `package.json` (a high-churn file); the strong untrusted-channel + arming gate keeps its FP rate low, but it is the family's most permissive consequent.
- After a mid-session ruleset switch, the **inactive** ruleset's row for the still-growing live session goes stale until re-scored (expected; the active ruleset stays current). `--check` reports this as "differs", distinct from a `null` "not yet scored".
