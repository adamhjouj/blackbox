import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(root, '.blackbox-demo');
const db = join(home, 'demo.db');
const cli = join(root, 'dist', 'cli.js');
const fixture = join(root, 'examples', 'demo-events.jsonl');
const shiftedFixture = join(home, 'demo-events.jsonl');
const env = { ...process.env, BLACKBOX_HOME: home, BLACKBOX_DB: db };

rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

// Preserve the fixture's ordering/durations while moving its newest event to one
// minute ago. The repository fixture stays deterministic; the demo UI stays fresh.
const rows = readFileSync(fixture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const newest = Math.max(...rows.map((row) => Date.parse(row._captured_at)));
const offset = Date.now() - 60_000 - newest;
for (const row of rows) row._captured_at = new Date(Date.parse(row._captured_at) + offset).toISOString();
writeFileSync(shiftedFixture, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

execFileSync(process.execPath, [cli, 'ingest', shiftedFixture], { cwd: root, env, stdio: 'inherit' });
execFileSync(process.execPath, [cli, 'start', '--port', '7843', '--allow-insecure-git'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (process.env.BLACKBOX_DEMO_NO_OPEN !== '1') {
  execFileSync(process.execPath, [cli, 'ui', '--port', '7843'], { cwd: root, env, stdio: 'inherit' });
}

console.log('\nSynthetic demo ready at http://127.0.0.1:7843/');
console.log(`Stop it with: BLACKBOX_HOME=${home} ${process.execPath} ${cli} stop`);
console.log('The demo is isolated from ~/.blackbox and contains no real session data.');
