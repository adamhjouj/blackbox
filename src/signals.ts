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

const DANGEROUS_SHELL = [
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // wget … | sh
  /\brm\s+-[a-z]*\br?f\b|\brm\s+-[a-z]*rf\b|\brm\s+-rf\b/i, // rm -rf
  /\bchmod\s+(-R\s+)?777\b/i, // chmod 777
  /\bbase64\s+-d[^|]*\|\s*(sh|bash)\b/i, // base64 -d … | sh
];

/**
 * Return the signal keys that apply to one event. `ctx` carries per-session state
 * (which MCP servers have been seen) and MUST be reused across a session's events
 * in chronological order for `new-mcp-server` to be correct.
 */
export function eventSignals(e: BlackboxEvent, ctx: SignalCtx): SignalKey[] {
  const out: SignalKey[] = [];

  if (e.phase === 'failure') out.push('failed');
  if (e.redaction_count > 0) out.push('secret-touch');

  if (e.action_type === 'git_action' && e.detail) {
    try {
      const g = (JSON.parse(e.detail) as { git?: { is_force?: boolean; is_reset?: boolean; is_delete?: boolean } }).git;
      if (g && (g.is_force || g.is_reset || g.is_delete)) out.push('destructive-git');
    } catch {
      /* detail is best-effort */
    }
  }

  if ((e.action_type === 'shell_command' || e.action_type === 'git_action') && e.target && DANGEROUS_SHELL.some((re) => re.test(e.target!))) {
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
