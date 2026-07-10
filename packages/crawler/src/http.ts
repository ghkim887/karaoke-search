import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import robotsParser from 'robots-parser';
import { request } from 'undici';

const DEFAULT_USER_AGENT =
  'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';
// tistory.com is large enough to handle 4-6 req/sec; bumped from 1 req/sec.
const DEFAULT_RATE_LIMIT_BASE_MS = 200;
const DEFAULT_RATE_LIMIT_JITTER_MS = 100; // ±50ms uniform → 150–250ms gap
const CACHE_PATH = resolve(process.cwd(), '.cache', 'http.json');

/** Per-host allowlist rule. `pathPrefixes` restricts which pathnames are reachable. */
interface HostRule {
  /**
   * If set, the request pathname must exactly equal one of these values or
   * start with `<prefix>/`. Omit for hosts where all paths are permitted.
   */
  pathPrefixes?: readonly string[];
}

/**
 * (S2) Exhaustive allowlist of hostnames (and, where applicable, pathname
 * prefixes) the crawler is permitted to contact. Derived from every adapter's
 * base-URL constant and every key in HOST_CONFIG:
 *   - j-pop-playlist.tistory.com  → BlogCrawler.BASE (all paths)
 *   - www.tjmedia.com              → CATALOG_URL / SEARCH_SONG_URL / TOP_AND_HOT_URL
 *                                    + HOST_CONFIG entry (all paths)
 *   - www.joysound.com             → listing `/web/karaoke/contents/new`,
 *                                    full songlist `/web/search/songlist/{kana}`,
 *                                    and detail `/apis/v1/ise/fetchContentsDetail` only
 *
 * Throw on any other host or (for path-restricted hosts) any other path.
 * Do NOT add catch-all entries — every entry must trace to a real call site.
 */
const ALLOWED_HOSTS: ReadonlyMap<string, HostRule> = new Map<string, HostRule>([
  ['j-pop-playlist.tistory.com', {}],
  ['www.tjmedia.com', {}],
  [
    'www.joysound.com',
    {
      pathPrefixes: [
        '/web/karaoke/contents/new',
        '/web/search/songlist',
        '/apis/v1/ise/fetchContentsDetail',
      ],
    },
  ],
]);

/**
 * (S6) Maximum response body size. Bodies larger than this are rejected before
 * being decoded to a JS string to prevent unbounded memory allocation.
 * 50 MB is well above any real API response in this codebase.
 */
const BODY_SIZE_LIMIT = 50 * 1024 * 1024;
// Large finite provider request timeouts: long crawls should not fail just
// because JOYSOUND/TJ/KY is temporarily slow. Keep a bound so truly hung
// requests still surface and resume logic can take over.
const REQUEST_HEADERS_TIMEOUT_MS = 600_000;
const REQUEST_BODY_TIMEOUT_MS = 600_000;

/**
 * Retry defaults for the idempotent GET path. A long catalog sweep issues
 * hundreds of thousands of GETs; a single transient 5xx / connection reset /
 * timeout should not abort the run. We retry only conditions that are safe to
 * repeat on an idempotent request:
 *   - HTTP 429 (rate limited) and 5xx (server-side transient), and
 *   - network-level errors whose code is in RETRYABLE_ERROR_CODES.
 * 4xx (except 429) are NOT retried — they are deterministic client errors.
 * Backoff is exponential with equal jitter and honors a server `Retry-After`
 * header when present. The POST path (`postForm`) is intentionally NOT retried:
 * it is the only non-GET call site and POSTs are not assumed idempotent.
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Network-error codes considered transient and therefore safe to retry on an
 * idempotent GET. Covers both Node system-call errors and undici's own timeout
 * / socket error codes.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** True for HTTP statuses that a retry might resolve (429 + 5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** True for thrown errors whose `code` marks a transient network failure. */
function isRetryableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (`"120"`) and the HTTP-date form. Returns `undefined`
 * when absent or unparseable so the caller falls back to exponential backoff.
 */
function parseRetryAfter(headerVal: string | string[] | undefined): number | undefined {
  if (headerVal === undefined) return undefined;
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * Drain and discard a response body to release the underlying socket before a
 * retry. Errors while draining are swallowed — we are about to retry anyway.
 */
async function drainBody(body: {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  try {
    // Pull and discard every chunk to release the socket before retrying.
    while (!(await iterator.next()).done) {
      /* discard */
    }
  } catch {
    // ignore — the response is being abandoned
  }
}

/**
 * Read a response body with a hard size cap. Uses the streaming `res.body`
 * iterator so we can abort early without buffering the full payload.
 *
 * Throws if the accumulated byte length exceeds `BODY_SIZE_LIMIT`.
 */
async function readBodyCapped(body: {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > BODY_SIZE_LIMIT) {
      throw new Error(`Response body exceeds size limit (${BODY_SIZE_LIMIT} bytes)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validate that `url` uses an allowed scheme, an allowed hostname, and (for
 * path-restricted hosts) an allowed pathname prefix. Throws on violations.
 */
function assertUrlAllowed(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Disallowed scheme: ${parsed.protocol} in URL: ${url}`);
  }
  const rule = ALLOWED_HOSTS.get(parsed.hostname);
  if (!rule) {
    throw new Error(`Disallowed host: ${parsed.hostname} in URL: ${url}`);
  }
  if (rule.pathPrefixes) {
    const ok = rule.pathPrefixes.some(
      (p) => parsed.pathname === p || parsed.pathname.startsWith(`${p}/`),
    );
    if (!ok) {
      throw new Error(`Disallowed path: ${parsed.pathname} on ${parsed.hostname}`);
    }
  }
}

/**
 * Per-host override for HTTP client behaviour. Any field left undefined
 * falls back to the project default. Keyed by `URL.host` (e.g.
 * `www.tjmedia.com`, lowercase, no port unless non-default).
 */
export interface HostConfig {
  /** Overrides DEFAULT_USER_AGENT for both the live request and robots.txt. */
  userAgent?: string;
  /** Overrides DEFAULT_RATE_LIMIT_BASE_MS. */
  minIntervalMs?: number;
  /** Overrides DEFAULT_RATE_LIMIT_JITTER_MS. */
  jitterMs?: number;
  /**
   * When `false`, GET responses from this host are neither stored in nor
   * served from the on-disk conditional-request cache. Defaults to `true`.
   * Intended for hosts where the response volume makes the cache file a
   * liability (e.g. a full-catalog sweep) — opt out per host only when
   * evidence supports it.
   *
   * NOTE: opting a host out does NOT prune its already-cached entries from
   * `.cache/http.json` — they are retained and re-serialized on every
   * persist. A one-time manual prune of the file is the operational
   * follow-up when flipping this off for a host with existing entries.
   */
  cache?: boolean;
}

/**
 * Per-host config table. Hosts not listed here use the project defaults.
 *
 * - `www.tjmedia.com`: the v2 TJ adapter hits the legacy catalog JSON API
 *   (`/legacy/api/newSongOfMonth`), which has NO UA gating — confirmed live
 *   2026-04-27 with default UA, bot UA, and Chrome UA all returning 200. The
 *   conservative 500ms+100ms cadence is retained as a politeness choice; the
 *   adapter only issues one POST per crawl run, so the cadence almost never
 *   actually applies, but the entry documents the per-host posture.
 *
 * Design notes: docs/PROJECT-KNOWLEDGE.md (HTTP client).
 */
const HOST_CONFIG: Record<string, HostConfig> = {
  'www.tjmedia.com': {
    minIntervalMs: 500,
    jitterMs: 100,
  },
};

/**
 * Cache-persist batching defaults. Persisting rewrites the ENTIRE cache file
 * atomically, so persist-per-store is O(n²) total IO over a long crawl (the
 * JOYSOUND full-catalog sweep performs hundreds of thousands of GETs against
 * an ever-growing multi-MB JSON file). Instead we persist at most once per
 * `DEFAULT_CACHE_PERSIST_EVERY` stores or once per
 * `DEFAULT_CACHE_PERSIST_MAX_AGE_MS`, whichever comes first, plus a final
 * `flush()` at end-of-run. Trade-off: a crash loses at most the last
 * un-flushed batch — acceptable because this is a cache, and those URLs are
 * simply re-fetched on the next run.
 */
const DEFAULT_CACHE_PERSIST_EVERY = 200;
const DEFAULT_CACHE_PERSIST_MAX_AGE_MS = 30_000;

/** Construction-time tuning knobs for `HttpClient`. All optional. */
export interface HttpClientOptions {
  /**
   * Client-wide on-disk conditional-request cache mode. Default `'persistent'`.
   *
   * - `'persistent'`: current behaviour — load/write `.cache/http.json`, send
   *   ETag/Last-Modified validators, replay cached bodies on 304, honoring the
   *   per-host `cache` opt-out in `HOST_CONFIG` / `hostConfigOverrides`.
   * - `'off'`: fully disables caching for THIS client. `.cache/http.json` is
   *   never read or written, no response is stored in memory, and no
   *   conditional validators are sent (so no 304 replay); `flush()` is a
   *   no-op. Intended for bulk one-shot enumerations that never refetch a URL
   *   in-run, where the whole-object cache — re-serialized in full on every
   *   persist — grows unboundedly and can blow the V8 string-length cap.
   *
   * Independent of the per-host `cache` boolean: `'off'` forces every host off;
   * `'persistent'` leaves per-host opt-outs in effect. Existing callers omit
   * this and get byte-identical `'persistent'` behaviour.
   */
  cache?: 'persistent' | 'off';
  /** Persist the cache at most once per this many stores. Default 200. */
  cachePersistEvery?: number;
  /**
   * Also persist when this much time has passed since the last persist and a
   * store arrives. Default 30s.
   */
  cachePersistMaxAgeMs?: number;
  /**
   * Per-host config overrides merged over the static `HOST_CONFIG` table
   * (field-level, override wins). Lets a one-off run (or a test) adjust
   * rate-limits or disable caching for a host without editing the table.
   */
  hostConfigOverrides?: Record<string, HostConfig>;
  /**
   * Max retry attempts (beyond the first) for transient GET failures.
   * Default 2 → up to 3 total attempts. Set 0 to disable retries.
   */
  maxRetries?: number;
  /** Base backoff delay in ms; doubles per attempt. Default 500. */
  retryBaseDelayMs?: number;
  /** Upper bound on any single backoff (and on honored Retry-After). Default 30s. */
  retryMaxDelayMs?: number;
}

interface CacheEntry {
  body: string;
  etag?: string;
  lastModified?: string;
}

interface RobotsRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

export interface FetchResult {
  status: number;
  body: string;
  etag?: string;
  lastModified?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique tmp name per write: `${path}.tmp` is shared, so two crawler
  // processes (or two overlapping writers) targeting the same cache file would
  // clobber each other's tmp and rename a torn file into place. Namespacing by
  // pid + a random token makes each writer's tmp private; the rename onto the
  // final path stays atomic.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup: a failed writeFile or rename leaves the unique tmp
    // behind (the rename is what makes it disappear on success). Because the
    // tmp name is namespaced by pid + UUID, an interrupted persist would
    // otherwise accumulate orphan `.tmp` files next to the cache. Swallow any
    // cleanup error — the original failure is what matters and is rethrown.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Polite HTTP client for crawler adapters.
 *
 *  - User-Agent defaults to the project's honest UA string; per-host
 *    overrides may set a different UA (e.g. Chrome spoof for TJ Media).
 *  - ~4-6 req/sec via 200ms base delay + ±50ms uniform jitter, applied per
 *    process. Per-host overrides may slow this down (e.g. 500ms for TJ).
 *  - The rate limiter is a single global RESERVATION clock ("slowest-host
 *    wins") rather than per-host. On entry each request atomically advances
 *    `nextAllowedAt = max(now, nextAllowedAt) + gap` and sleeps until its
 *    reserved slot, so N concurrent callers (Promise.all) are spaced out
 *    instead of all firing after one shared gap. Sequential single-host
 *    cadence is unchanged (first request immediate, then ~gap apart). Project
 *    scale doesn't justify a per-host clock; per-host fairness would only
 *    matter under concurrent multi-host crawling.
 *  - The idempotent GET path retries transient failures (429 / 5xx / network
 *    errors) with exponential backoff + jitter, re-reserving a rate-limit slot
 *    per attempt and honoring `Retry-After`. POSTs are not retried.
 *  - robots.txt is fetched once per host and consulted BEFORE any rate-limit
 *    slot is reserved — disallowed requests do not consume a slot.
 *  - ETag / Last-Modified disk cache at `.cache/http.json` (cwd-relative). On
 *    a 304 response, the cached body is replayed. Persistence is batched (see
 *    DEFAULT_CACHE_PERSIST_EVERY); callers that own the client lifecycle MUST
 *    call `flush()` at end-of-run or the last batch of stores is lost.
 *  - First contact with each host logs the resolved UA + rate-limit values
 *    once for run-log auditability.
 */
export class HttpClient {
  private cache: Record<string, CacheEntry> = {};
  private cacheLoaded = false;
  /**
   * Global reservation clock: the earliest wall-clock time the next request
   * may fire. Advanced synchronously on entry to `waitForRateLimit` so
   * concurrent callers reserve distinct, staggered slots.
   */
  private nextAllowedAt = 0;
  private robotsByHost = new Map<string, Promise<RobotsRules>>();
  private loggedHosts = new Set<string>();
  private readonly cacheMode: 'persistent' | 'off';
  private readonly cachePersistEvery: number;
  private readonly cachePersistMaxAgeMs: number;
  private readonly hostConfigOverrides: Record<string, HostConfig>;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private pendingCacheStores = 0;
  private lastPersistAt = Date.now();
  private flushInFlight: Promise<void> | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.cacheMode = options.cache ?? 'persistent';
    this.cachePersistEvery = options.cachePersistEvery ?? DEFAULT_CACHE_PERSIST_EVERY;
    this.cachePersistMaxAgeMs = options.cachePersistMaxAgeMs ?? DEFAULT_CACHE_PERSIST_MAX_AGE_MS;
    this.hostConfigOverrides = options.hostConfigOverrides ?? {};
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  private async loadCache(): Promise<void> {
    // Cache off: never read `.cache/http.json`; the in-memory cache stays {}.
    if (this.cacheMode === 'off') return;
    if (this.cacheLoaded) return;
    const data = await readJsonFile<Record<string, CacheEntry>>(CACHE_PATH);
    this.cache = data ?? {};
    this.cacheLoaded = true;
  }

  private async persistCache(): Promise<void> {
    await writeJsonFileAtomic(CACHE_PATH, this.cache);
  }

  /**
   * Record one in-memory cache store and persist if either batching threshold
   * (store count or elapsed time since last persist) has been crossed.
   */
  private async recordCacheStore(): Promise<void> {
    this.pendingCacheStores++;
    if (
      this.pendingCacheStores >= this.cachePersistEvery ||
      Date.now() - this.lastPersistAt >= this.cachePersistMaxAgeMs
    ) {
      await this.flush();
    }
  }

  /**
   * Persist any un-flushed cache stores to disk. No-op when nothing is
   * pending. Callers that own the client lifecycle (the CLI, sweep scripts)
   * must invoke this at end-of-run; a crash before flush loses at most the
   * last batch (acceptable — it's a cache).
   *
   * Concurrent calls are serialized: a flush that arrives while a persist is
   * in flight joins the in-flight promise instead of starting a second write.
   * This keeps the pending counter from going negative (two overlapping
   * flushes would otherwise both subtract the same batch) AND prevents
   * interleaved writes to the shared tmp file inside persistCache.
   */
  flush(): Promise<void> {
    // Cache off: never touch disk. Nothing is ever stored (resolveHostConfig
    // forces every host's cache off), so pendingCacheStores is always 0, but
    // guard explicitly so flush() is a hard no-op regardless.
    if (this.cacheMode === 'off') return Promise.resolve();
    if (this.flushInFlight) return this.flushInFlight;
    if (this.pendingCacheStores === 0) return Promise.resolve();
    this.flushInFlight = (async () => {
      try {
        // Reset the pending counter only AFTER the persist succeeds: if the
        // write throws (ENOSPC, AV-locked tmp rename on Windows), the stores
        // stay pending so a later flush() — e.g. the CLI's finally-flush —
        // retries instead of silently dropping the batch. Subtract the
        // flushed count (rather than zeroing) so stores landing while the
        // write is in flight remain pending.
        const flushed = this.pendingCacheStores;
        await this.persistCache();
        this.pendingCacheStores -= flushed;
        this.lastPersistAt = Date.now();
      } finally {
        this.flushInFlight = undefined;
      }
    })();
    return this.flushInFlight;
  }

  private resolveHostConfig(host: string): Required<HostConfig> {
    const cfg: HostConfig = { ...HOST_CONFIG[host], ...this.hostConfigOverrides[host] };
    return {
      userAgent: cfg.userAgent ?? DEFAULT_USER_AGENT,
      minIntervalMs: cfg.minIntervalMs ?? DEFAULT_RATE_LIMIT_BASE_MS,
      jitterMs: cfg.jitterMs ?? DEFAULT_RATE_LIMIT_JITTER_MS,
      // Client-wide `cache: 'off'` forces every host off, which makes the
      // read/validator path (fetch:576), the 304-replay path, and the store
      // site all inert — they already gate on hostCfg.cache. `'persistent'`
      // preserves the per-host opt-out (defaults true).
      cache: this.cacheMode === 'off' ? false : (cfg.cache ?? true),
    };
  }

  private logHostOnce(host: string, cfg: Required<HostConfig>): void {
    if (this.loggedHosts.has(host)) return;
    this.loggedHosts.add(host);
    const uaShort = cfg.userAgent.length > 40 ? `${cfg.userAgent.slice(0, 40)}...` : cfg.userAgent;
    console.log(
      `[http] host=${host} ua="${uaShort}" minInterval=${cfg.minIntervalMs}ms jitter=${cfg.jitterMs}ms`,
    );
  }

  private async getRobots(origin: string, userAgent: string): Promise<RobotsRules> {
    const existing = this.robotsByHost.get(origin);
    if (existing) return existing;
    const promise = (async (): Promise<RobotsRules> => {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        const res = await request(robotsUrl, {
          method: 'GET',
          headers: { 'user-agent': userAgent },
          headersTimeout: REQUEST_HEADERS_TIMEOUT_MS,
          bodyTimeout: REQUEST_BODY_TIMEOUT_MS,
        });
        const body = await readBodyCapped(res.body);
        const status = res.statusCode;
        // Actual policy (deliberate, not RFC-strict): ANY non-2xx response —
        // 4xx AND 5xx alike — is treated as empty rules (allow-all), so a
        // temporarily broken or missing robots.txt never blocks a crawl. A
        // stricter "5xx ⇒ disallow" posture is a crawl-policy decision owned
        // elsewhere; do not change behavior here without that sign-off.
        const text = status >= 200 && status < 300 ? body : '';
        return robotsParser(robotsUrl, text);
      } catch (err) {
        // Fetch itself failed (DNS, connection, timeout, size cap). Same
        // allow-all fallback as a non-2xx response; log once per host so the
        // run log records that robots.txt was never actually evaluated.
        console.debug(`[http] robots.txt fetch failed for ${origin}; treating as allow-all`, err);
        return robotsParser(robotsUrl, '');
      }
    })();
    this.robotsByHost.set(origin, promise);
    return promise;
  }

  private waitForRateLimit(minIntervalMs: number, jitterMs: number): Promise<void> {
    const gap = minIntervalMs + (Math.random() - 0.5) * jitterMs;
    const now = Date.now();
    // Reserve this request's slot atomically (synchronously, before any await)
    // so concurrent callers each claim a distinct slot instead of all reading
    // the same timestamp and firing together. First request (nextAllowedAt in
    // the past) fires immediately; each subsequent one is pushed `gap` later.
    const scheduledAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = scheduledAt + gap;
    const wait = scheduledAt - now;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  }

  /** Backoff for retry `attempt` (0-based): honored Retry-After, else equal jitter. */
  private retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.retryMaxDelayMs);
    }
    const ceiling = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** attempt);
    // Equal jitter: half fixed + half random, so backoff is never zero (unless
    // the base delay is configured to 0) yet still spreads out retry storms.
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  /**
   * Perform an idempotent GET with rate-limit reservation and transient-failure
   * retry. Each attempt re-reserves a rate-limit slot. Retries 429/5xx (after
   * draining the abandoned body) and retryable network errors with exponential
   * backoff; a non-retryable status is returned as-is, and once retries are
   * exhausted the final response is returned (5xx) or the final error rethrown.
   */
  private async getWithRetry(
    url: string,
    headers: Record<string, string>,
    minIntervalMs: number,
    jitterMs: number,
  ): Promise<Awaited<ReturnType<typeof request>>> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForRateLimit(minIntervalMs, jitterMs);
      try {
        const res = await request(url, {
          method: 'GET',
          headers,
          headersTimeout: REQUEST_HEADERS_TIMEOUT_MS,
          bodyTimeout: REQUEST_BODY_TIMEOUT_MS,
        });
        if (attempt < this.maxRetries && isRetryableStatus(res.statusCode)) {
          const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
          await drainBody(res.body);
          await sleep(this.retryDelayMs(attempt, retryAfterMs));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < this.maxRetries && isRetryableError(err)) {
          await sleep(this.retryDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Fetch `url` honoring robots.txt, the rate-limit, and the on-disk
   * conditional-request cache. Returns `null` iff robots disallows the URL.
   */
  async fetch(url: string): Promise<FetchResult | null> {
    assertUrlAllowed(url);
    await this.loadCache();

    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const hostCfg = this.resolveHostConfig(parsed.host);
    this.logHostOnce(parsed.host, hostCfg);

    const robots = await this.getRobots(origin, hostCfg.userAgent);
    const allowed = robots.isAllowed(url, hostCfg.userAgent);
    if (allowed === false) {
      return null;
    }

    const cached = hostCfg.cache ? this.cache[url] : undefined;
    const headers: Record<string, string> = { 'user-agent': hostCfg.userAgent };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

    // Rate-limit reservation happens per attempt inside getWithRetry.
    const res = await this.getWithRetry(url, headers, hostCfg.minIntervalMs, hostCfg.jitterMs);
    const status = res.statusCode;

    if (status === 304 && cached) {
      const out: FetchResult = { status: 200, body: cached.body };
      if (cached.etag !== undefined) out.etag = cached.etag;
      if (cached.lastModified !== undefined) out.lastModified = cached.lastModified;
      return out;
    }

    const body = await readBodyCapped(res.body);
    const etagHeader = res.headers.etag;
    const lastModifiedHeader = res.headers['last-modified'];
    const etag = typeof etagHeader === 'string' ? etagHeader : undefined;
    const lastModified = typeof lastModifiedHeader === 'string' ? lastModifiedHeader : undefined;

    if (status >= 200 && status < 300 && hostCfg.cache) {
      const entry: CacheEntry = { body };
      if (etag !== undefined) entry.etag = etag;
      if (lastModified !== undefined) entry.lastModified = lastModified;
      this.cache[url] = entry;
      await this.recordCacheStore();
    }

    const result: FetchResult = { status, body };
    if (etag !== undefined) result.etag = etag;
    if (lastModified !== undefined) result.lastModified = lastModified;
    return result;
  }

  /**
   * POST `url` with a form-urlencoded `body`, honoring robots.txt and the
   * per-host rate limit. Returns `null` iff robots disallows the URL.
   *
   * Intentionally bypasses the on-disk conditional-request cache: the legacy
   * APIs we POST to (e.g., TJ Media's `newSongOfMonth`) do not honor ETag
   * or Last-Modified, and stuffing 19MB JSON blobs into `.cache/http.json`
   * would thrash the cache file for no benefit.
   */
  async postForm(url: string, body: Record<string, string>): Promise<FetchResult | null> {
    assertUrlAllowed(url);
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const hostCfg = this.resolveHostConfig(parsed.host);
    this.logHostOnce(parsed.host, hostCfg);

    const robots = await this.getRobots(origin, hostCfg.userAgent);
    const allowed = robots.isAllowed(url, hostCfg.userAgent);
    if (allowed === false) {
      return null;
    }

    await this.waitForRateLimit(hostCfg.minIntervalMs, hostCfg.jitterMs);

    const encoded = new URLSearchParams(body).toString();
    const headers: Record<string, string> = {
      'user-agent': hostCfg.userAgent,
      'content-type': 'application/x-www-form-urlencoded',
    };

    const res = await request(url, {
      method: 'POST',
      headers,
      body: encoded,
      headersTimeout: REQUEST_HEADERS_TIMEOUT_MS,
      bodyTimeout: REQUEST_BODY_TIMEOUT_MS,
    });
    const status = res.statusCode;
    const respBody = await readBodyCapped(res.body);
    const etagHeader = res.headers.etag;
    const lastModifiedHeader = res.headers['last-modified'];
    const etag = typeof etagHeader === 'string' ? etagHeader : undefined;
    const lastModified = typeof lastModifiedHeader === 'string' ? lastModifiedHeader : undefined;

    const result: FetchResult = { status, body: respBody };
    if (etag !== undefined) result.etag = etag;
    if (lastModified !== undefined) result.lastModified = lastModified;
    return result;
  }
}
