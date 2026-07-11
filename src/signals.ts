import type { BlackboxEvent } from './types';

/**
 * Lightweight, read-side "signals" derived from data already in the store — no
 * scores, no versioning, no combination logic. This is deliberately the honest
 * subset the data supports today; Phase 3 turns this same list into the real
 * versioned risk engine with combos.
 */
export type SignalKey = 'failed' | 'secret-touch' | 'destructive-git' | 'dangerous-shell' | 'new-mcp-server';

export interface SignalCtx {
  seenMcp: Set<string>;
}
export function newCtx(): SignalCtx {
  return { seenMcp: new Set() };
}

const PIPE_TO_SHELL = [
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // wget … | sh
  /\bbase64\s+-d[^|]*\|\s*(sh|bash)\b/i, // base64 -d … | sh
];
const CHMOD_OPEN = /\bchmod\s+(-R\s+|-\w+\s+)*(0?777|a=?\+?rwx|ugo\+rwx)\b/i;
// Destructive git that shows up as a Bash command (so coverage doesn't depend on
// the git collector being installed in the repo).
const GIT_DESTRUCTIVE = [
  /\bgit\b[^"'|]*\bpush\b[^"'|]*(--force\b|--force-with-lease\b|-f\b)/i,
  /\bgit\b[^"'|]*\breset\b[^"'|]*--hard\b/i,
  /\bgit\b[^"'|]*\bbranch\b[^"'|]*-D\b/i,
  /\bgit\b[^"'|]*\bclean\b[^"'|]*-[a-z]*f/i,
];

/** rm with BOTH a recursive and a force flag, in any order / long form. */
function rmDestructive(cmd: string): boolean {
  const i = cmd.search(/\brm\b/);
  if (i < 0) return false;
  const rest = cmd.slice(i);
  const stop = rest.search(/[|&;\n]/);
  const seg = stop > -1 ? rest.slice(0, stop) : rest;
  const recursive = /(^|\s)-{1,2}[a-z]*r|--recursive\b/i.test(seg);
  const force = /(^|\s)-{1,2}[a-z]*f|--force\b/i.test(seg);
  return recursive && force;
}

function isDangerousShell(cmd: string): boolean {
  return PIPE_TO_SHELL.some((re) => re.test(cmd)) || CHMOD_OPEN.test(cmd) || rmDestructive(cmd);
}

/**
 * Return the signal keys that apply to one event. `ctx` carries per-session state
 * (which MCP servers have been seen) and MUST be reused across a session's events
 * in chronological order for `new-mcp-server` to be correct.
 */
export function eventSignals(e: BlackboxEvent, ctx: SignalCtx): SignalKey[] {
  const out: SignalKey[] = [];

  if (e.phase === 'failure') out.push('failed');
  if (e.redaction_count > 0) out.push('secret-touch');

  // Ground-truth destructive git from the git collector...
  let destructiveGit = false;
  if (e.action_type === 'git_action' && e.detail) {
    try {
      const g = (JSON.parse(e.detail) as { git?: { is_force?: boolean; is_reset?: boolean; is_delete?: boolean } }).git;
      if (g && (g.is_force || g.is_reset || g.is_delete)) destructiveGit = true;
    } catch {
      /* detail is best-effort */
    }
  }
  // ...or inferred from a destructive git Bash command (collector may not be installed).
  const cmd = e.target ?? '';
  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && GIT_DESTRUCTIVE.some((re) => re.test(cmd))) {
    destructiveGit = true;
  }
  if (destructiveGit) out.push('destructive-git');

  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && cmd && isDangerousShell(cmd)) {
    out.push('dangerous-shell');
  }

  if (e.tool_name && e.tool_name.startsWith('mcp__')) {
    const server = e.tool_name.split('__')[1] ?? '';
    if (server && !ctx.seenMcp.has(server)) {
      ctx.seenMcp.add(server);
      out.push('new-mcp-server');
    }
  }

  return out;
}
