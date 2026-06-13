import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { type D1DatabaseLike, handleRequest } from './index.js';
import { openSqliteD1Database } from './sqlite-adapter.js';

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  now?: () => number;
}

export interface NodeServerOptions {
  db: D1DatabaseLike;
  corsOrigin?: string;
  rateLimit?: RateLimitOptions;
  trustProxyHeaders?: boolean;
}

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

export function createKaraokeSearchNodeServer(options: NodeServerOptions): Server {
  const buckets = new Map<string, RateLimitBucket>();
  return createServer(async (req, res) => {
    try {
      const request = toWebRequest(req);
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname === '/healthz') {
        response = json({ ok: true });
      } else {
        const limited = checkRateLimit(
          req,
          options.rateLimit,
          buckets,
          options.trustProxyHeaders === true,
        );
        if (limited) {
          response = json({ error: 'Rate limit exceeded' }, 429);
        } else {
          response = await handleRequest(request, { DB: options.db });
        }
      }
      await writeWebResponse(res, withCors(response, options.corsOrigin));
    } catch {
      await writeWebResponse(
        res,
        withCors(json({ error: 'Internal server error' }, 500), options.corsOrigin),
      );
    }
  });
}

function startFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
  const dbPath = env.KARAOKE_SQLITE_DB_PATH;
  if (dbPath === undefined || dbPath.trim() === '') {
    throw new Error('KARAOKE_SQLITE_DB_PATH is required');
  }
  const host = env.HOST ?? '127.0.0.1';
  const port = parsePort(env.PORT ?? '8787');
  const corsOrigin = env.KARAOKE_CORS_ORIGIN;
  const rateLimit = parseRateLimit(env);
  const db = openSqliteD1Database(dbPath);
  const serverOptions: NodeServerOptions = { db };
  if (corsOrigin !== undefined) serverOptions.corsOrigin = corsOrigin;
  if (rateLimit !== undefined) serverOptions.rateLimit = rateLimit;
  if (parseBooleanEnv(env.KARAOKE_TRUST_PROXY_HEADERS)) serverOptions.trustProxyHeaders = true;
  const server = createKaraokeSearchNodeServer(serverOptions);
  server.listen(port, host, () => {
    console.log(`karaoke-search API listening on http://${host}:${port}`);
  });
  const close = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

function toWebRequest(req: IncomingMessage): Request {
  const host = headerValue(req.headers.host) ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = new Uint8Array(await response.arrayBuffer());
  res.end(body);
}

function withCors(response: Response, corsOrigin: string | undefined): Response {
  if (corsOrigin === undefined || corsOrigin.trim() === '') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', corsOrigin);
  // Chrome's Private Network Access preflight can trigger when a public page
  // talks to an origin that resolves to a local/private address for tailnet
  // users. The origin is still pinned above, so granting PNA keeps those
  // browsers working without widening CORS to arbitrary sites.
  headers.set('access-control-allow-private-network', 'true');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function checkRateLimit(
  req: IncomingMessage,
  options: RateLimitOptions | undefined,
  buckets: Map<string, RateLimitBucket>,
  trustProxyHeaders: boolean,
): boolean {
  if (options === undefined) {
    return false;
  }
  const now = options.now?.() ?? Date.now();
  const key = clientKey(req, trustProxyHeaders);
  const existing = buckets.get(key);
  if (existing === undefined || now - existing.windowStart >= options.windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return false;
  }
  existing.count += 1;
  return existing.count > options.maxRequests;
}

function clientKey(req: IncomingMessage, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const cfIp = headerValue(req.headers['cf-connecting-ip']);
    if (cfIp !== undefined && cfIp.trim() !== '') return cfIp.trim();
    const forwardedFor = headerValue(req.headers['x-forwarded-for']);
    if (forwardedFor !== undefined && forwardedFor.trim() !== '') {
      return forwardedFor.split(',')[0]?.trim() || 'unknown';
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}
function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseRateLimit(env: NodeJS.ProcessEnv): RateLimitOptions | undefined {
  const max = env.KARAOKE_RATE_LIMIT_PER_MINUTE;
  if (max === undefined || max.trim() === '') {
    return undefined;
  }
  const maxRequests = Number.parseInt(max, 10);
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
    throw new Error(`Invalid KARAOKE_RATE_LIMIT_PER_MINUTE: ${max}`);
  }
  return { windowMs: 60_000, maxRequests };
}

export function isCliEntrypoint(moduleUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}

if (isCliEntrypoint()) {
  startFromEnv();
}
