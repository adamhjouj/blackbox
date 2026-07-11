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
import { normalize } from './normalize';
import { configPath } from './paths';
import { Store } from './store';

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
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req: http.IncomingMessage, maxBody: number): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        truncated = true;
        return; // stop accumulating; keep draining so the socket closes cleanly
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated }));
    req.on('error', reject);
  });
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

  const recordHook = (body: string, truncated: boolean): void => {
    const capturedAt = new Date().toISOString();
    if (truncated) {
      // Record, don't drop: a marker so the timeline shows a gap, not silence.
      store.append(
        normalize({ hook_event_name: 'OversizedHook', session_id: 'unknown', _truncated: true }, capturedAt),
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
    store.append(normalize(payload, capturedAt, { captureOutput: opts.captureOutput }));
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
        store.append(normalizeGit({ repoTop, delta, cls, diff, commit, correlation, rawBody: body, capturedAt }));
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
        const path = url.split('?')[0];
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
        if (req.method === 'POST' && path === '/hook') {
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

  return new Promise<Daemon>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      log(`listening on 127.0.0.1:${port} (db ${opts.db})`);
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
