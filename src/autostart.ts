import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logPath } from './paths';

export const LAUNCH_AGENT_LABEL = 'com.blackbox.daemon';

export interface PlistOptions {
  label?: string;
  nodePath: string;
  cliPath: string;
  port: number;
  logFile: string;
  db?: string;
}

/** XML-escape a plist string value (paths can contain & < >). */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A macOS LaunchAgent plist that keeps the daemon running across logins/reboots
 * (RunAtLoad + KeepAlive). Pure — returns the plist XML; writing and loading it
 * is the caller's job, so this stays unit-testable without touching launchctl.
 */
export function buildLaunchAgentPlist(opts: PlistOptions): string {
  const label = opts.label ?? LAUNCH_AGENT_LABEL;
  const argv = [opts.nodePath, opts.cliPath, 'start', '--foreground', '--port', String(opts.port)];
  if (opts.db) argv.push('--db', opts.db);
  const argXml = argv.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const log = xmlEscape(opts.logFile);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log}</string>
    <key>StandardErrorPath</key>
    <string>${log}</string>
  </dict>
</plist>
`;
}

export function launchAgentPath(label = LAUNCH_AGENT_LABEL): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export interface AutostartResult {
  supported: boolean;
  path: string;
  action: 'installed' | 'removed' | 'absent' | 'unsupported';
}

/** Write the LaunchAgent plist and (re)load it (macOS only). Idempotent. */
export function enableAutostart(opts: { nodePath: string; cliPath: string; port: number; db?: string }): AutostartResult {
  const path = launchAgentPath();
  if (process.platform !== 'darwin') return { supported: false, path, action: 'unsupported' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildLaunchAgentPlist({ ...opts, logFile: logPath() }));
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'ignore' }); // no-op if not loaded
  } catch {
    /* not loaded yet */
  }
  execFileSync('launchctl', ['load', path], { stdio: 'ignore' });
  return { supported: true, path, action: 'installed' };
}

/** Unload and remove the LaunchAgent plist (macOS only). Idempotent. */
export function disableAutostart(): AutostartResult {
  const path = launchAgentPath();
  if (process.platform !== 'darwin') return { supported: false, path, action: 'unsupported' };
  if (!existsSync(path)) return { supported: true, path, action: 'absent' };
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'ignore' });
  } catch {
    /* already unloaded */
  }
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  return { supported: true, path, action: 'removed' };
}
