import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import robotsParser from 'robots-parser';
import { request } from 'undici';

const USER_AGENT = 'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';
// tistory.com is large enough to handle 4-6 req/sec; bumped from 1 req/sec.
const RATE_LIMIT_BASE_MS = 200;
const RATE_LIMIT_JITTER_MS = 100; // ±50ms uniform → 150–250ms gap
const CACHE_PATH = resolve(process.cwd(), '.cache', 'http.json');

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
 *  - User-Agent fixed to the project's honest UA string.
 *  - ~4-6 req/sec via 200ms base delay + ±50ms uniform jitter, applied per process.
 *  - robots.txt is fetched once per host and consulted BEFORE the rate-limit
 *    timestamp is recorded — disallowed requests do not consume a slot.
 *  - ETag / Last-Modified disk cache at `.cache/http.json` (cwd-relative). On
 *    a 304 response, the cached body is replayed.
 */
export class HttpClient {
  private cache: Record<string, CacheEntry> = {};
  private cacheLoaded = false;
  private lastRequestAt = 0;
  private robotsByHost = new Map<string, Promise<RobotsRules>>();

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const data = await readJsonFile<Record<string, CacheEntry>>(CACHE_PATH);
    this.cache = data ?? {};
    this.cacheLoaded = true;
  }

  private async persistCache(): Promise<void> {
    await writeJsonFileAtomic(CACHE_PATH, this.cache);
  }

  private async getRobots(origin: string): Promise<RobotsRules> {
    const existing = this.robotsByHost.get(origin);
    if (existing) return existing;
    const promise = (async (): Promise<RobotsRules> => {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        const res = await request(robotsUrl, {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT },
        });
        const body = await res.body.text();
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

  private async waitForRateLimit(): Promise<void> {
    const gap = RATE_LIMIT_BASE_MS + (Math.random() - 0.5) * RATE_LIMIT_JITTER_MS;
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
    await this.loadCache();

    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const robots = await this.getRobots(origin);
    const allowed = robots.isAllowed(url, USER_AGENT);
    if (allowed === false) {
      return null;
    }

    await this.waitForRateLimit();

    const cached = this.cache[url];
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
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

    const body = await res.body.text();
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
}

// integration: run locally
