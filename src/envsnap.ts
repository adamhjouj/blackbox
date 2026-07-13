/**
 * R7.1 — the environment/toolchain snapshot captured once at SessionStart. It
 * fixes the agent's capability/attack surface at capture time: what version of
 * Claude Code + Node, which OS, which MCP servers were configured, and content
 * hashes of the hook config + project manifests. Pairs with R5 anti-forensics
 * (the hooks_hash proves the hook config at start) and sharpens tool-poisoning
 * (a server "in config at start" vs one that "appeared mid-session").
 *
 * LOW-LEAK BY DESIGN: MCP entries are the server NAME + command WORD only — never
 * args or `env` (which carry tokens) — and still pass through redactText. Configs
 * are content-HASHED, never copied. Best-effort + bounded; never throws.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, homedir, platform, release } from 'node:os';
import { join } from 'node:path';
import { redactText } from './redact';

/** ~/.claude.json routinely grows into the MBs (per-project history + OAuth). Cap
 *  the read so a giant config can't stall even the off-hook-path enrichment tick. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface EnvSnapshot {
  claude_version: string | null;
  node_version: string;
  os: string;
  /** "name (command-word)" per MCP server — names + command word ONLY. */
  mcp_servers: string[];
  /** sha256 over the MERGED hooks blocks (user + project + local settings). */
  hooks_hash: string | null;
  /** sha256 of package.json / lockfiles in cwd, by filename. */
  file_hashes: Record<string, string>;
}

function safeExec(cmd: string, args: string[], timeout = 250): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim() || null;
  } catch {
    return null;
  }
}

function readCappedJson(path: string, cap = MAX_CONFIG_BYTES): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    if (buf.length > cap) return null; // too big to parse safely — skip rather than stall
    return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sha256(buf: Buffer): string {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/** Extract "name (command-word)" for each server in an `mcpServers` map, dropping
 *  args/env entirely. The command word is the executable basename (npx, docker,
 *  python3), never the full path or its arguments. */
function extractMcp(servers: unknown, into: Set<string>): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    let word: string | null = null;
    if (cfg && typeof cfg === 'object' && typeof (cfg as { command?: unknown }).command === 'string') {
      word = ((cfg as { command: string }).command.split(/[\s/\\]+/).pop() ?? '').trim() || null;
    }
    into.add(redactText(word ? `${name} (${word})` : name).text);
  }
}

/** sha256 over the concatenated `hooks` blocks of the user + project + local
 *  settings — so project-scope hook tampering is visible, not just user scope. */
function hooksHash(cwd: string | null): string | null {
  const paths = [join(homedir(), '.claude', 'settings.json')];
  if (cwd) paths.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
  const blocks: string[] = [];
  for (const p of paths) {
    const j = readCappedJson(p, MAX_MANIFEST_BYTES);
    if (j && j.hooks) blocks.push(JSON.stringify(j.hooks));
  }
  return blocks.length ? 'sha256:' + createHash('sha256').update(blocks.join('\n')).digest('hex') : null;
}

function fileHashes(cwd: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cwd) return out;
  for (const f of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements.txt', 'Cargo.lock', 'go.sum']) {
    try {
      const p = join(cwd, f);
      if (existsSync(p)) {
        const buf = readFileSync(p);
        if (buf.length <= MAX_MANIFEST_BYTES) out[f] = sha256(buf);
      }
    } catch {
      /* unreadable → skip this file */
    }
  }
  return out;
}

/** Collect the snapshot. Every field is best-effort; a failure yields null/empty,
 *  never an exception. Runs off the hook path (the daemon schedules it). */
export function collectEnv(cwd: string | null): EnvSnapshot {
  const mcp = new Set<string>();
  const userConfig = readCappedJson(join(homedir(), '.claude.json'));
  if (userConfig) {
    extractMcp(userConfig.mcpServers, mcp);
    const projects = userConfig.projects as Record<string, { mcpServers?: unknown }> | undefined;
    if (cwd && projects && projects[cwd]) extractMcp(projects[cwd].mcpServers, mcp);
  }
  if (cwd) {
    const projectMcp = readCappedJson(join(cwd, '.mcp.json'), MAX_MANIFEST_BYTES);
    if (projectMcp) extractMcp(projectMcp.mcpServers, mcp);
  }
  return {
    claude_version: safeExec('claude', ['--version']),
    node_version: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    mcp_servers: [...mcp].sort(),
    hooks_hash: hooksHash(cwd),
    file_hashes: fileHashes(cwd),
  };
}
