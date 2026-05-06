import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import robotsParser from 'robots-parser';
import { request } from 'undici';

const DEFAULT_USER_AGENT =
  'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';
// tistory.com is large enough to handle 4-6 req/sec; bumped from 1 req/sec.
const DEFAULT_RATE_LIMIT_BASE_MS = 200;
const DEFAULT_RATE_LIMIT_JITTER_MS = 100; // ±50ms uniform → 150–250ms gap
const CACHE_PATH = resolve(process.cwd(), '.cache', 'http.json');

/**
 * (S2) Exhaustive allowlist of hostnames the crawler is permitted to contact.
 * Derived from every adapter's base-URL constant and every key in HOST_CONFIG:
 *   - j-pop-playlist.tistory.com  → BlogCrawler.BASE
 *   - www.tjmedia.com              → CATALOG_URL / SEARCH_SONG_URL / TOP_AND_HOT_URL
 *                                    + HOST_CONFIG entry
 *
 * Throw on any other host (including RFC1918, link-local, loopback, file://).
 * Do NOT add catch-all entries — every entry must trace to a real call site.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'j-pop-playlist.tistory.com',
  'www.tjmedia.com',
]);

/**
 * (S6) Maximum response body size. Bodies larger than this are rejected before
 * being decoded to a JS string to prevent unbounded memory allocation.
 * 50 MB is well above any real API response in this codebase.
 */
const BODY_SIZE_LIMIT = 50 * 1024 * 1024;

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
 * Validate that `url` uses an allowed scheme and an allowed hostname.
 * Throws `Error` on violations — silently swallowing a misconfigured URL
 * would hide bugs.
 */
function assertUrlAllowed(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Disallowed scheme: ${parsed.protocol} in URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Disallowed host: ${parsed.hostname} in URL: ${url}`);
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
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md
 *       — "Operational discipline" table.
 */
const HOST_CONFIG: Record<string, HostConfig> = {
  'www.tjmedia.com': {
    minIntervalMs: 500,
    jitterMs: 100,
  },
};

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
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/**
 * Polite HTTP client for crawler adapters.
 *
 *  - User-Agent defaults to the project's honest UA string; per-host
 *    overrides may set a different UA (e.g. Chrome spoof for TJ Media).
 *  - ~4-6 req/sec via 200ms base delay + ±50ms uniform jitter, applied per
 *    process. Per-host overrides may slow this down (e.g. 500ms for TJ).
 *  - The rate-limit timestamp is global ("slowest-host wins") rather than
 *    per-host. Project scale doesn't justify the per-host Map; per-host
 *    fairness would only matter under concurrent multi-host crawling.
 *  - robots.txt is fetched once per host and consulted BEFORE the rate-limit
 *    timestamp is recorded — disallowed requests do not consume a slot.
 *  - ETag / Last-Modified disk cache at `.cache/http.json` (cwd-relative). On
 *    a 304 response, the cached body is replayed.
 *  - First contact with each host logs the resolved UA + rate-limit values
 *    once for run-log auditability.
 */
export class HttpClient {
  private cache: Record<string, CacheEntry> = {};
  private cacheLoaded = false;
  private lastRequestAt = 0;
  private robotsByHost = new Map<string, Promise<RobotsRules>>();
  private loggedHosts = new Set<string>();

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const data = await readJsonFile<Record<string, CacheEntry>>(CACHE_PATH);
    this.cache = data ?? {};
    this.cacheLoaded = true;
  }

  private async persistCache(): Promise<void> {
    await writeJsonFileAtomic(CACHE_PATH, this.cache);
  }

  private resolveHostConfig(host: string): Required<HostConfig> {
    const cfg = HOST_CONFIG[host] ?? {};
    return {
      userAgent: cfg.userAgent ?? DEFAULT_USER_AGENT,
      minIntervalMs: cfg.minIntervalMs ?? DEFAULT_RATE_LIMIT_BASE_MS,
      jitterMs: cfg.jitterMs ?? DEFAULT_RATE_LIMIT_JITTER_MS,
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
        });
        const body = await readBodyCapped(res.body);
        const status = res.statusCode;
        // Per RFC: 4xx means no rules apply (allow all); 5xx pessimistically
        // disallows. We follow common crawler convention: treat non-2xx as
        // empty rules (allow all) to avoid blocking on stale errors.
        const text = status >= 200 && status < 300 ? body : '';
        return robotsParser(robotsUrl, text);
      } catch {
        return robotsParser(robotsUrl, '');
      }
    })();
    this.robotsByHost.set(origin, promise);
    return promise;
  }

  private async waitForRateLimit(minIntervalMs: number, jitterMs: number): Promise<void> {
    const gap = minIntervalMs + (Math.random() - 0.5) * jitterMs;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < gap) {
      await sleep(gap - elapsed);
    }
    this.lastRequestAt = Date.now();
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

    await this.waitForRateLimit(hostCfg.minIntervalMs, hostCfg.jitterMs);

    const cached = this.cache[url];
    const headers: Record<string, string> = { 'user-agent': hostCfg.userAgent };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

    const res = await request(url, { method: 'GET', headers });
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

    if (status >= 200 && status < 300) {
      const entry: CacheEntry = { body };
      if (etag !== undefined) entry.etag = etag;
      if (lastModified !== undefined) entry.lastModified = lastModified;
      this.cache[url] = entry;
      await this.persistCache();
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

    const res = await request(url, { method: 'POST', headers, body: encoded });
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
