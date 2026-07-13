/**
 * Hardening flags for every `git` the daemon runs against a repository path taken
 * from a hook payload (a path the agent — or a malicious repo it cloned — controls).
 *
 * The vector: a repo can set `core.fsmonitor` in its own config to an arbitrary
 * program, which git EXECUTES the next time it refreshes the index — and
 * `git diff` / `git status` / `git ls-files` all refresh the index. So merely
 * READING a hostile worktree could run code inside the daemon. A command-line
 * `-c key=val` overrides repo config, so prepending `core.fsmonitor=false`
 * neutralises it (verified: a planted `core.fsmonitor` command does not fire).
 *
 * `core.hooksPath=/dev/null` is defense-in-depth: none of the daemon's git calls
 * run hooks (only commit/merge/checkout/push do, which the daemon never invokes),
 * but pinning it away from a repo-supplied hooks dir costs nothing.
 *
 * `=false` rather than an empty value: some older gits treat a non-empty
 * `core.fsmonitor` as a hook command and an empty one inconsistently; the literal
 * boolean is unambiguous across versions.
 */
export const GIT_SAFE_FLAGS: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
