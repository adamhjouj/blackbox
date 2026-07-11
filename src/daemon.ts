import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { normalize } from './normalize';
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
    store.append(normalize(payload, capturedAt, { captureOutput: opts.captureOutput }));
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
