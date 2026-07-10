// Poll-based network + process collector, unprivileged.
// Roots at the Claude Code PID, walks its process tree every INTERVAL ms,
// runs lsof to attribute live sockets to PIDs in that tree, and records
// first-seen processes and first-seen connections.
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const ROOT = parseInt(process.argv[2], 10)
const OUT = new URL('./collector-events.jsonl', import.meta.url).pathname
const INTERVAL = 120
const seenProc = new Set()
const seenConn = new Set()
const nowIso = () => new Date().toISOString()
const write = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + '\n')

function psSnapshot() {
  // pid ppid then full command (command may contain spaces -> take rest of line)
  const out = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf8' })
  const rows = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: +m[1], ppid: +m[2], command: m[3] })
  }
  return rows
}

function treePids(rows, root) {
  const byPpid = new Map()
  for (const r of rows) {
    if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, [])
    byPpid.get(r.ppid).push(r)
  }
  const set = new Map()
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()
    for (const child of byPpid.get(pid) || []) {
      if (!set.has(child.pid)) { set.set(child.pid, child); stack.push(child.pid) }
    }
  }
  return set // Map<pid, {pid,ppid,command}>
}

function lsofFor(pids) {
  if (!pids.length) return []
  let out = ''
  try {
    out = execSync(`lsof -nP -i -a -p ${pids.join(',')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return [] }
  const conns = []
  for (const line of out.split('\n')) {
    if (!/\b(TCP|UDP)\b/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    const pid = +cols[1]
    const nameIdx = cols.findIndex((c) => c.includes('->') || /:\d+$/.test(c))
    const name = cols.slice(8).join(' ')
    const state = (line.match(/\((\w+)\)/) || [])[1] || ''
    conns.push({ pid, name, state })
  }
  return conns
}

const timer = setInterval(() => {
  let rows
  try { rows = psSnapshot() } catch { return }
  const tree = treePids(rows, ROOT)
  // record first-seen processes in the tree
  for (const [pid, p] of tree) {
    if (seenProc.has(pid)) continue
    seenProc.add(pid)
    write({ collector: 'process', ts: nowIso(), event: 'exec_observed', pid: p.pid, ppid: p.ppid, command: p.command.slice(0, 300) })
  }
  // record first-seen network connections owned by tree PIDs
  const treePidList = [...tree.keys()]
  for (const c of lsofFor(treePidList)) {
    const key = `${c.pid}|${c.name}|${c.state}`
    if (seenConn.has(key)) continue
    seenConn.add(key)
    const proc = tree.get(c.pid)
    write({ collector: 'network', ts: nowIso(), event: 'connection', pid: c.pid, command: proc ? proc.command.split(' ')[0] : '?', endpoint: c.name, state: c.state })
  }
}, INTERVAL)

process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
process.on('SIGINT', () => { clearInterval(timer); process.exit(0) })
