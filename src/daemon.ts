import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import {
  Correlator,
  classify,
  commitMeta,
  diffstat,
  normalizeGit,
  parseRefLines,
  resolveRepoTop,
} from './git-collector';
import { sessionAnchor } from './mutation';
import { normalize, normalizeAndCapture } from './normalize';
import { blackboxDir, configPath } from './paths';
import { eventDetail, sessionActions, sessionCards, sessionStory } from './read-api';
import { backfill, RiskEngine, riskRowFrom, sessionRiskRowFrom } from './risk-engine';
import { RULESET_VERSION } from './risk-rules';
import { ensureKeypair, isSignableBoundary, signHead, writeWatermark, type Keypair } from './sign';
import { Store } from './store';
import type { BlackboxEvent } from './types';
import { renderPage } from './ui-page';

export interface DaemonOptions {
  db: string;
  port?: number;
  maxBodyBytes?: number;
  captureOutput?: boolean;
  logFile?: string;
}

export interface Daemon {
  port: number;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 7842;
const DEFAULT_MAX_BODY = 16 * 1024 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

/**
 * Only requests whose Host is a loopback name are honored. Binding 127.0.0.1 is
 * NOT enough: a DNS-rebinding page rebinds its own hostname to 127.0.0.1 and then
 * reads the daemon same-origin (bypassing the Origin/Sec-Fetch checks). Rejecting
 * any non-loopback Host header closes that hole.
 */
function isLoopbackHost(hostHeader: string): boolean {
  if (!hostHeader) return false;
  const h = hostHeader
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function readBody(req: http.IncomingMessage, maxBody: number): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = Number(req.headers['content-length'] ?? 0) > maxBody;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        truncated = true;
        return; // stop accumulating; keep draining so the socket closes cleanly
      }
      if (!truncated) chunks.push(c);
    });
    req.on('end', () => settle(() => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated })));
    // A client abort/half-open body must settle the promise so the handler never leaks.
    req.on('aborted', () => settle(() => resolve({ body: '', truncated: false })));
    req.on('close', () => settle(() => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated })));
    req.on('error', (err) => settle(() => reject(err)));
  });
}

/** A browser CSRF from any website could POST a "simple request" to localhost.
 *  Claude's hook client (axios/node) never sets Origin/Sec-Fetch-Site; a browser
 *  always does on a cross-site request. Reject anything that smells browser-driven. */
function isBrowserForged(headers: http.IncomingHttpHeaders): boolean {
  if (headers.origin) return true;
  const site = headers['sec-fetch-site'];
  const s = Array.isArray(site) ? site[0] : site;
  return !!s && s !== 'same-origin' && s !== 'none';
}

/**
 * Start the receiver. Binds 127.0.0.1 ONLY (never 0.0.0.0). Single long-lived
 * Store instance → writes serialize (single-writer invariant). The request
 * handler is wrapped so a malformed request can never crash the process; hooks
 * are async/fire-and-forget so we always answer 200 after logging.
 */
export function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const port = opts.port ?? DEFAULT_PORT;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const store = new Store(opts.db);
  const startedAt = Date.now();
  const correlator = new Correlator();
  const riskEngine = new RiskEngine((sid) => store.eventsLight(sid));
  // R3 chain-of-custody: load the signing key once (null if never keyed). Signing
  // is off the hook path and best-effort — it can never fail a recording.
  let signingKeys: Keypair | null = null;
  try {
    signingKeys = ensureKeypair();
  } catch {
    /* signing stays off until a key exists */
  }

  let configToken = '';
  try {
    configToken = (JSON.parse(readFileSync(configPath(), 'utf8')) as { token?: string }).token ?? '';
  } catch {
    /* no config yet — accept unauthenticated git events (local-trust) */
  }

  const hdr = (h: http.IncomingHttpHeaders, k: string): string => {
    const v = h[k];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  };

  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    if (opts.logFile) {
      try {
        appendFileSync(opts.logFile, line);
      } catch {
        /* logging must never throw */
      }
    } else {
      process.stdout.write(line);
    }
  };

  // Score an appended event and persist its risk (separate interpretation layer,
  // separate transactions from append). Must never fail a hook — try/catch.
  const scoreAndPersist = (e: BlackboxEvent): void => {
    try {
      const now = new Date().toISOString();
      const r = riskEngine.score(e);
      if (r.risk) store.riskUpsert(riskRowFrom(r.risk, RULESET_VERSION, now));
      store.sessionRiskUpsert(sessionRiskRowFrom(r.verdict, RULESET_VERSION, now));
    } catch (err) {
      log(`risk scoring failed: ${(err as Error).message}`);
    }
  };

  // Sign the chain head at session boundaries (once or twice per session) — bounds
  // the signature count while checkpointing every session start/end. Off the hook
  // path via try/catch; never fails a recording.
  const signNow = (): void => {
    if (!signingKeys) return;
    try {
      const s = signHead(store, signingKeys, new Date().toISOString());
      if (s) writeWatermark(blackboxDir(), { seq: s.seq, head_hash: s.head_hash }); // out-of-DB anti-deletion anchor
    } catch (err) {
      log(`signing failed: ${(err as Error).message}`);
    }
  };
  const maybeSign = (e: BlackboxEvent): void => {
    if (signingKeys && isSignableBoundary(e.phase)) signNow();
  };

  const recordHook = (body: string, truncated: boolean): void => {
    const capturedAt = new Date().toISOString();
    if (truncated) {
      // Record, don't drop: a marker so the timeline shows a gap, not silence.
      scoreAndPersist(
        store.append(normalize({ hook_event_name: 'OversizedHook', session_id: 'unknown', _truncated: true }, capturedAt)),
      );
      log('recorded oversized/truncated hook as marker');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      log('drop: invalid JSON body');
      return;
    }
    if (!isPlainObject(payload)) {
      log('drop: non-object payload');
      return;
    }
    // Feed correlation state (session cwd + recent git Bash calls) before recording.
    try {
      correlator.observe(payload, Date.now());
    } catch {
      /* correlation is best-effort */
    }
    // Record the git anchor once per session (SessionStart/SessionEnd) — off the
    // per-tool path, so tool-call hook latency is unaffected. Guarded internally.
    const he = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
    const anchor = he === 'SessionStart' || he === 'SessionEnd' ? sessionAnchor(typeof payload.cwd === 'string' ? payload.cwd : null) : null;
    const { event, blob } = normalizeAndCapture(payload, capturedAt, { captureOutput: opts.captureOutput, anchor });
    const appended = store.append(event, blob);
    scoreAndPersist(appended);
    maybeSign(appended);
  };

  const recordGit = (headers: http.IncomingHttpHeaders, body: string): void => {
    if (configToken && hdr(headers, 'x-bb-token') !== configToken) {
      log('git: token mismatch — dropped');
      return;
    }
    const cwd = hdr(headers, 'x-bb-cwd');
    if (!cwd) {
      log('git: missing cwd header');
      return;
    }
    const repoTop = resolveRepoTop(cwd);
    if (!repoTop) {
      log(`git: cannot resolve repo for ${cwd}`);
      return;
    }
    const now = Date.now();
    const capturedAt = new Date().toISOString();
    for (const delta of parseRefLines(body)) {
      try {
        const cls = classify(repoTop, delta);
        const diff = diffstat(repoTop, delta);
        const commit = cls.is_delete ? null : commitMeta(repoTop, delta.new);
        const correlation = correlator.correlate(repoTop, cls, now);
        scoreAndPersist(store.append(normalizeGit({ repoTop, delta, cls, diff, commit, correlation, rawBody: body, capturedAt })));
      } catch (err) {
        // enrichment failure degrades a column, never drops the collector
        log(`git: enrichment failed for ${delta.ref}: ${(err as Error).message}`);
      }
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? '';
        const path = url.split('?')[0] ?? '';
        // Anti-DNS-rebinding: honor loopback Host names only.
        if (!isLoopbackHost(hdr(req.headers, 'host'))) {
          log(`rejected non-loopback Host: ${hdr(req.headers, 'host')}`);
          sendJson(res, 403, { ok: false, error: 'bad host' });
          return;
        }
        if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
          const meta = store.chainMeta();
          sendJson(res, 200, {
            ok: true,
            pid: process.pid,
            uptime_s: Math.round((Date.now() - startedAt) / 1000),
            count: meta?.count ?? 0,
            head_seq: meta?.head_seq ?? 0,
            port,
            db: opts.db,
          });
          return;
        }
        // The timeline UI (served to the local browser). No framing allowed.
        if (req.method === 'GET' && path === '/') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'x-frame-options': 'DENY',
            'x-content-type-options': 'nosniff',
            'content-security-policy':
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'cache-control': 'no-store',
          });
          res.end(renderPage());
          return;
        }
        // Read API. Reject cross-origin so a website you visit cannot read your
        // forensic data; the same-origin page the daemon serves reaches it fine.
        // No permissive CORS headers are ever sent.
        if (req.method === 'GET' && path.startsWith('/api/')) {
          if (isBrowserForged(req.headers)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' });
            return;
          }
          if (path === '/api/sessions') {
            sendJson(res, 200, sessionCards(store));
            return;
          }
          const ms = path.match(/^\/api\/session\/(.+)\/events$/);
          if (ms) {
            let id: string;
            try {
              id = decodeURIComponent(ms[1]!);
            } catch {
              sendJson(res, 400, { ok: false, error: 'bad session id' });
              return;
            }
            sendJson(res, 200, sessionActions(store, id));
            return;
          }
          const mstory = path.match(/^\/api\/session\/(.+)\/story$/);
          if (mstory) {
            let id: string;
            try {
              id = decodeURIComponent(mstory[1]!);
            } catch {
              sendJson(res, 400, { ok: false, error: 'bad session id' });
              return;
            }
            sendJson(res, 200, sessionStory(store, id));
            return;
          }
          const me = path.match(/^\/api\/event\/(\d+)$/);
          if (me) {
            const d = eventDetail(store, Number(me[1]));
            if (!d) {
              sendJson(res, 404, { ok: false, error: 'no such event' });
              return;
            }
            sendJson(res, 200, d);
            return;
          }
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        // Reject browser-forged writes to both recording routes (CSRF to localhost).
        if (req.method === 'POST' && (path === '/hook' || path === '/git') && isBrowserForged(req.headers)) {
          log(`rejected browser-forged POST ${path}`);
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        if (req.method === 'POST' && path === '/hook') {
          const ct = hdr(req.headers, 'content-type');
          if (!ct.includes('application/json')) {
            // Claude sends application/json; requiring it blocks text/plain CSRF simple-requests.
            log('rejected /hook with non-JSON content-type');
            sendJson(res, 415, { ok: false, error: 'expected application/json' });
            return;
          }
          const { body, truncated } = await readBody(req, maxBody);
          try {
            recordHook(body, truncated);
          } catch (err) {
            // never let an append failure surface as a hook error
            log(`append error: ${(err as Error).message}`);
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && path === '/git') {
          const { body } = await readBody(req, maxBody);
          try {
            recordGit(req.headers, body);
          } catch (err) {
            log(`git error: ${(err as Error).message}`);
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        log(`handler error: ${(err as Error).message}`);
        try {
          sendJson(res, 200, { ok: false });
        } catch {
          /* response may already be sent */
        }
      }
    })();
  });

  // Bound resource use so a local flood can't exhaust memory / event loop.
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 8_000;

  return new Promise<Daemon>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      log(`listening on 127.0.0.1:${port} (db ${opts.db})`);
      // Best-effort: score any sessions recorded before Phase 3 (or while a
      // non-scoring binary ran). Deferred off the startup path.
      setImmediate(() => {
        try {
          const r = backfill(store);
          if (r.sessions) log(`risk backfill: scored ${r.sessions} session(s)`);
        } catch (err) {
          log(`risk backfill failed: ${(err as Error).message}`);
        }
        // R3: checkpoint the current head on startup (catches downtime gaps).
        if (signingKeys) {
          const before = store.latestSignature()?.seq;
          signNow();
          const after = store.latestSignature()?.seq;
          if (after && after !== before) log(`signed chain head at seq ${after}`);
        }
      });
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              store.close();
              res();
            });
            // don't hang on keep-alive sockets
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}
