/**
 * Plain-English explainer. Turns a recorded action (especially a gnarly shell
 * command) into: a one-line summary, a step-by-step breakdown, and a "what's
 * dangerous and why" list. This is the point of the whole product — a forensic
 * record no one can read is useless (ARCHITECTURE.md §8/§9: "why it flagged" +
 * a plain-language "what to check").
 *
 * Deterministic and LOCAL — no LLM, no network. blackbox's promise is "nothing
 * leaves this machine", and a security tool must not ship every command to an
 * API. Like risk, the explanation is a re-derivable READ-time interpretation of
 * already-stored facts; it never touches the hash chain.
 */
import { isSensitivePath } from './redact-rules';
import type { FlagId } from './risk-rules';
import type { BlackboxEvent } from './types';

export interface ExplainStep {
  /** Plain-English description of one step. */
  text: string;
  /** True if this specific step is the risky part (drives a subtle UI accent). */
  danger?: boolean;
}
export interface Danger {
  /** What was done, in plain English. */
  what: string;
  /** Why it is risky, in plain English (honest — notes when it's likely benign). */
  why: string;
}
export interface Explanation {
  /** One-line plain-English gist of the whole action. */
  summary: string;
  /** Ordered breakdown (multiple only for compound shell commands). */
  steps: ExplainStep[];
  /** What was done that's dangerous, and why. Empty when nothing stands out. */
  dangers: Danger[];
}

// ---- helpers -------------------------------------------------------------

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;
/** The URL host inside a string — prefers an explicit `http(s)://host`, else a
 *  dotted domain. Deliberately NOT the first word (so `curl … | node` doesn't
 *  report the host as "curl"). */
function hostOf(s: string): string | null {
  const u = s.match(/https?:\/\/([a-z0-9.\-]+)(?::\d+)?/i);
  if (u?.[1]) return u[1];
  const d = s.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/i);
  return d?.[1] ?? null;
}
function isLocal(host: string | null): boolean {
  return !!host && LOCAL_HOST.test(host);
}
const truncate = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Split a compound shell command into top-level segments (respecting quotes and
 *  `$(…)`/`(…)` nesting), so `a && b | c ; d` becomes [a, b, c, d]. */
function splitSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let sq = false;
  let dq = false;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (sq) {
      if (c === "'") sq = false;
      cur += c;
      continue;
    }
    if (dq) {
      if (c === '"') dq = false;
      cur += c;
      continue;
    }
    if (c === "'") { sq = true; cur += c; continue; }
    if (c === '"') { dq = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { if (depth > 0) depth--; cur += c; continue; }
    if (depth === 0) {
      // `&&` / `||` are separators; a lone `&` is a redirection (2>&1) or a
      // backgrounding op — not a step boundary — so it's left attached.
      if ((c === '&' && n === '&') || (c === '|' && n === '|')) { segs.push(cur); cur = ''; i++; continue; }
      if (c === ';' || c === '\n' || c === '|') { segs.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** Split a segment into top-level words, respecting quotes and `$(…)`/`(…)` so a
 *  command-substitution value stays one word. */
function topWords(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let sq = false;
  let dq = false;
  let depth = 0;
  for (const c of seg) {
    if (sq) { if (c === "'") sq = false; cur += c; continue; }
    if (dq) { if (c === '"') dq = false; cur += c; continue; }
    if (c === "'") { sq = true; cur += c; continue; }
    if (c === '"') { dq = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { if (depth > 0) depth--; cur += c; continue; }
    if (depth === 0 && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const backtick = (a: string): string => '`' + a + '`';

/** Explain one shell segment in plain English. null → too trivial to list. */
function explainSegment(rawSeg: string): ExplainStep | null {
  const tw = topWords(rawSeg.trim());
  if (!tw.length) return null;
  // Peel leading `VAR=val` assignments.
  const assigns: string[] = [];
  let ai = 0;
  while (ai < tw.length && isAssign(tw[ai]!)) { assigns.push(tw[ai]!.split('=')[0]!); ai++; }
  if (ai >= tw.length) {
    // A pure assignment segment (`PORT=7861`, `SID=$(curl … | node …)`).
    if (assigns.length === 1 && /\$\(|`/.test(tw[0]!)) return { text: `Set ${backtick(assigns[0]!)} to the output of a command.` };
    return { text: `Set the environment variable${assigns.length > 1 ? 's' : ''} ${assigns.map(backtick).join(', ')}.` };
  }
  const rest = tw.slice(ai);
  const seg = rest.join(' ');
  const toks = rest;
  const prog = (toks[0] ?? '').replace(/^\W+/, '');
  const arg1 = toks[1] ?? '';
  const prefix = assigns.length ? `Set ${assigns.map(backtick).join(', ')}, then ` : '';
  const cap = (t: string): ExplainStep => ({ text: prefix ? prefix + t.charAt(0).toLowerCase() + t.slice(1) : t });

  // control/no-ops
  if (/^(true|:|exit)$/.test(prog)) return null;
  if (prog === 'cd') return cap(`Change into the directory \`${truncate(arg1 || '~')}\`.`);
  if (prog === 'export') return cap(`Set the environment variable ${backtick(arg1.split('=')[0] ?? '')}.`);
  if (prog === 'echo') return cap('Print text to the output.');
  if (prog === 'mkdir') return cap(`Create the directory \`${truncate(arg1)}\`.`);
  if (prog === 'cat') return cap(`Read and print the file \`${truncate(arg1)}\`.`);
  if (prog === 'sleep') return cap('Wait for a moment.');
  if (/^(mv|cp)$/.test(prog)) return cap(`${prog === 'mv' ? 'Move' : 'Copy'} \`${truncate(toks[1] ?? '')}\` to \`${truncate(toks[toks.length - 1] ?? '')}\`.`);
  if (prog === 'ln') return cap('Create a link.');

  if (prog === 'rm') {
    const target = toks.slice(1).find((t) => !t.startsWith('-')) ?? '';
    const recursive = /-{1,2}[a-z]*r|--recursive/i.test(seg);
    return { text: `${prefix}${recursive ? 'Recursively delete' : 'Delete'} \`${truncate(target)}\`.`, danger: true };
  }
  if (prog === 'chmod') return { text: `${prefix}Change the permissions of \`${truncate(toks[toks.length - 1] ?? '')}\` to \`${arg1}\`.`, danger: /777|a=?\+?rwx|ugo\+rwx/.test(seg) };

  if (/^(curl|wget)$/.test(prog)) {
    const url = toks.find((t) => /https?:\/\//.test(t) || /\.[a-z]{2,}(\/|$|:)/i.test(t)) ?? '';
    const host = hostOf(url);
    const sends = /(-d\b|--data|--form|-F\b|-T\b|--upload-file|-X\s+(POST|PUT|PATCH))/i.test(seg);
    const local = isLocal(host);
    if (sends) return { text: `${prefix}${local ? 'Send data to the local service' : 'Upload/send data to the external server'} \`${truncate(host ?? url)}\`.`, danger: !local };
    return { text: `${prefix}${local ? 'Fetch data from the local service' : 'Download from the external URL'} \`${truncate(host ?? url)}\`.`, danger: !local };
  }

  if (/^(node|nodejs|python3?|ruby|perl|deno|bun)$/.test(prog)) {
    const inline = toks.some((t) => /^(-e|-c|--eval|-E)$/.test(t));
    if (inline) {
      const does: string[] = [];
      if (/writeFileSync|createWriteStream|>\s|appendFile/.test(seg)) does.push('writes files');
      if (/fetch\(|http\.request|urlopen|requests\.|net\.|https?:\/\//.test(seg)) does.push('makes network requests');
      if (/exec|spawn|child_process|os\.system|subprocess/.test(seg)) does.push('runs other commands');
      const tail = does.length ? ` that ${does.join(', ')}` : '';
      return { text: `${prefix}Run an inline ${prog} script${tail}.`, danger: does.includes('runs other commands') };
    }
    // node dist/cli.js start / stop → known blackbox verbs
    const script = toks.find((t) => /\.(js|mjs|cjs|ts|py|rb|pl)$/.test(t)) ?? arg1;
    if (/cli\.js/.test(script)) {
      if (seg.includes(' start')) return cap('Start the blackbox recorder daemon.');
      if (seg.includes(' stop')) return cap('Stop the blackbox recorder daemon.');
    }
    return cap(`Run the ${prog} program \`${truncate(script)}\`.`);
  }

  if (prog === 'git') {
    const sub = arg1;
    if (sub === 'push' && /--force|-f\b|--force-with-lease/.test(seg)) return { text: `${prefix}Force-push to a git remote (overwrites remote history).`, danger: true };
    if (sub === 'reset' && /--hard/.test(seg)) return { text: `${prefix}Hard-reset the repository (discards uncommitted changes).`, danger: true };
    if (sub === 'clean' && /-[a-z]*f/.test(seg)) return { text: `${prefix}Delete untracked files with \`git clean\`.`, danger: true };
    return cap(`Run \`git ${sub}\`.`);
  }

  if (/^(sh|bash|zsh|eval)$/.test(prog)) return { text: `${prefix}Run a nested shell (\`${prog}\`).`, danger: /-c/.test(seg) };
  if (/^(nc|ncat|netcat|scp|rsync|sftp|ssh|ftp|telnet)$/.test(prog)) return { text: `${prefix}Open a network connection with \`${prog}\`.`, danger: true };
  if (/^(base64|xxd|openssl)$/.test(prog)) return cap(`Encode/decode data with \`${prog}\`.`);
  if (/^(grep|rg|awk|sed|find|ls|test|wc|head|tail|sort|jq|cut|tr)$/.test(prog)) return cap(`Search or inspect files with \`${prog}\`.`);

  return cap(`Run \`${truncate(prog)}\`${toks.length > 1 ? ' with arguments' : ''}.`);
}

// ---- danger explanations (flag → plain English, with the specific reason) ---

function shellDangers(cmd: string): Danger[] {
  const out: Danger[] = [];
  const pipe = cmd.match(/\b(curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(sh|bash|zsh|python3?|node|nodejs|perl|ruby|eval)\b/i);
  if (pipe || /\bbase64\s+-d[^|]*\|\s*(sh|bash|node|python)/i.test(cmd)) {
    const host = pipe ? hostOf(pipe[0]) : null;
    const local = isLocal(host);
    out.push({
      what: 'Piped a download straight into a program interpreter (e.g. `curl … | bash`).',
      why: local
        ? `This is the classic pattern for running code fetched from the internet without inspecting it first — a common malware/remote-code-execution technique. Here the source is your own machine (${host ?? '127.0.0.1'}), so it's most likely reading a local service rather than executing remote code.`
        : 'This runs whatever code the remote server returns, with no chance to inspect it first — the standard way malware and supply-chain attacks execute on a machine.',
    });
  }
  const rmIdx = cmd.search(/\brm\b/);
  if (rmIdx >= 0) {
    const seg = cmd.slice(rmIdx).split(/[|;&\n]/)[0] ?? '';
    if (/(^|\s)-{1,2}[a-z]*r|--recursive\b/i.test(seg) && /(^|\s)-{1,2}[a-z]*f|--force\b/i.test(seg)) {
      out.push({ what: 'Recursively force-deleted files (`rm -rf`).', why: 'This permanently removes files and whole directories with no undo and no trip to the trash. On a system or home path it can destroy work or break the machine.' });
    }
  }
  if (/\bchmod\s+(-R\s+|-\w+\s+)*(0?777|a=?\+?rwx|ugo\+rwx)\b/i.test(cmd)) {
    out.push({ what: 'Made a file world-readable/writable/executable (`chmod 777`).', why: 'Any user or process on the machine can now read, modify, or run that file — a common way to accidentally expose secrets or let malware persist.' });
  }
  return out;
}

/** Build the "what's dangerous & why" list from the risk flags + specifics. */
function dangersFor(e: BlackboxEvent, flags: FlagId[], input: Record<string, unknown> | null): Danger[] {
  const out: Danger[] = [];
  const cmd = e.target ?? '';
  const has = (f: FlagId): boolean => flags.includes(f);

  // NOTE: `dangerouslyDisableSandbox` is deliberately NOT a danger — running
  // Claude Code in bypass-permissions mode is a common, intentional user choice
  // (a whole-session setting), so flagging every command for it is pure noise.

  if (has('dangerous-shell')) out.push(...shellDangers(cmd));

  if (has('secret-touch')) {
    const path = (input?.file_path as string) || cmd;
    const named = isSensitivePath(path) ? ` (\`${truncate(path.split('/').pop() ?? path, 40)}\`)` : '';
    out.push({ what: `Read or handled a sensitive file${named}.`, why: 'Files like `.env`, private keys, and credential stores hold secrets. Touching one is normal on its own, but it becomes the first half of an exfiltration if the session later sends data out.' });
  }
  if (has('external-send')) {
    out.push({ what: 'Sent data to an external server.', why: 'Data left (or was about to leave) your machine for an outside host. Combined with a secret read, this is the shape of an exfiltration; on its own it may be a normal upload — check the destination.' });
  }
  if (has('auth-edit')) {
    out.push({ what: 'Modified an authentication / permission file.', why: 'Changes to auth, login, or access-control code can weaken who is allowed to do what — the kind of edit a prompt-injection attack makes to plant a backdoor.' });
  }
  if (has('destructive-git')) {
    out.push({ what: 'Ran a history-rewriting git command.', why: 'Force-push, hard-reset, or branch-delete can discard commits or overwrite the remote — recoverable only if someone else still has the old history.' });
  }
  if (has('mass-diff')) {
    out.push({ what: 'Made an unusually large change.', why: 'A very large or bulk-deletion diff can be accidental destruction, or an attempt to bury a small malicious change inside a lot of noise.' });
  }
  if (has('new-mcp-server')) {
    out.push({ what: 'Used a new MCP tool server for the first time this session.', why: 'A tool server introduced mid-session (or one whose behavior changed) is the tell for tool-poisoning / rug-pull. Confirm it is one you trust.' });
  }
  if (has('injection-output')) {
    out.push({ what: 'A tool returned output shaped like a prompt-injection attack.', why: 'The output contained text resembling instructions to the agent ("ignore previous instructions…"). If the agent then acted on it, that is a hijack — check what it did next.' });
  }
  return out;
}

// ---- per-action explanations --------------------------------------------

const shortPath = (p: string): string => truncate(p, 90);

/** The one-line plain-English summary of an action. Prefers the agent's own
 *  `description`, else synthesizes from the command/target. Light-weight (no risk
 *  flags, no raw payload) so it can run for EVERY timeline row, not just on expand. */
export function actionSummary(actionType: string, target: string | null, toolName: string | null, description: string | null): string {
  const desc = (description ?? '').trim();
  const t = target ?? '';
  switch (actionType) {
    case 'shell_command':
    case 'git_action': {
      if (desc) return desc;
      const segs = splitSegments(t).map(explainSegment).filter((s): s is ExplainStep => s !== null);
      if (segs.length === 0) return 'Ran a shell command.';
      if (segs.length === 1) return segs[0]!.text;
      // No agent description — name the most salient step (a danger, else the
      // first substantive one) so even a compound command reads at a glance.
      const salient = segs.find((s) => s.danger) ?? segs.find((s) => !/^(Change into|Set |Print |Wait )/.test(s.text)) ?? segs[0]!;
      const gist = salient.text.replace(/\.$/, '');
      return truncate(`Ran a ${segs.length}-step shell command — ${gist.charAt(0).toLowerCase() + gist.slice(1)}`, 120);
    }
    case 'file_read':
      return desc || `Read the file \`${shortPath(t)}\`.`;
    case 'file_write':
      return desc || `Wrote (created or replaced) the file \`${shortPath(t)}\`.`;
    case 'file_edit':
      return desc || `Edited the file \`${shortPath(t)}\`.`;
    case 'web_fetch':
      return desc || `Fetched the web page \`${truncate(hostOf(t) ?? t, 90)}\`.`;
    case 'mcp_call': {
      const parts = (toolName ?? '').split('__');
      return desc || `Called \`${parts.slice(2).join('__') || 'a tool'}\` on the MCP server \`${parts[1] ?? 'unknown'}\`.`;
    }
    case 'task_control':
      return desc || 'Managed a sub-agent or task.';
    case 'session':
      return 'A session lifecycle event (start/stop).';
    default:
      return desc || `${toolName ?? actionType} action.`;
  }
}

/** Full explanation for the expanded dossier: summary + step breakdown (compound
 *  shell only) + the "what's dangerous and why" list. `input` is the parsed
 *  (redacted) tool_input. */
export function explainEvent(e: BlackboxEvent, flags: FlagId[], input: Record<string, unknown> | null): Explanation {
  const desc = typeof input?.description === 'string' ? (input.description as string).trim() : null;
  const summary = actionSummary(e.action_type, e.target, e.tool_name, desc);
  let steps: ExplainStep[] = [];
  if (e.action_type === 'shell_command' || e.action_type === 'git_action') {
    const all = splitSegments(e.target ?? '').map(explainSegment).filter((s): s is ExplainStep => s !== null);
    steps = all.length > 1 ? all : []; // a single step is already the summary
  }
  return { summary, steps, dangers: dangersFor(e, flags, input) };
}
