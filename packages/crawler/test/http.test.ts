import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';

// ---------------------------------------------------------------------------
// Mock undici so tests never hit the network.
// ---------------------------------------------------------------------------
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises so tests never touch the real `.cache/http.json` and
// so cache-persist frequency can be observed (one `rename` per atomic persist).
// `readFile` rejects → loadCache starts from an empty cache in every test.
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => {
    throw new Error('no cache file');
  }),
  rename: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

import { rename as mockRename } from 'node:fs/promises';
import { request as mockRequest } from 'undici';
const mockedRequest = vi.mocked(mockRequest);
const mockedRename = vi.mocked(mockRename);

// ---------------------------------------------------------------------------
// Helper: build a fake undici response whose body is an async-iterable of
// Uint8Array chunks. `chunks` is an array of byte lengths — each entry becomes
// a zero-filled buffer of that size.
// ---------------------------------------------------------------------------
function fakeResponse(statusCode: number, chunks: number[], headers: Record<string, string> = {}) {
  async function* bodyGen() {
    for (const len of chunks) {
      yield new Uint8Array(len);
    }
  }
  return {
    statusCode,
    headers,
    body: bodyGen(),
  };
}

describe('HttpClient — URL allowlist (S2)', () => {
  it('fetch rejects a loopback URL with Disallowed host', async () => {
    const client = new HttpClient();
    await expect(client.fetch('http://127.0.0.1/foo')).rejects.toThrow(/Disallowed host/);
  });

  it('fetch rejects file: scheme with Disallowed scheme', async () => {
    const client = new HttpClient();
    await expect(client.fetch('file:///etc/passwd')).rejects.toThrow(/Disallowed scheme/);
  });

  it('postForm rejects a loopback URL with Disallowed host', async () => {
    const client = new HttpClient();
    await expect(client.postForm('http://127.0.0.1/foo', {})).rejects.toThrow(/Disallowed host/);
  });

  it('postForm rejects file: scheme with Disallowed scheme', async () => {
    const client = new HttpClient();
    await expect(client.postForm('file:///etc/passwd', {})).rejects.toThrow(/Disallowed scheme/);
  });

  it('fetch allows www.joysound.com listing path', async () => {
    mockedRequest.mockReset();
    mockedRequest.mockImplementation(async () => fakeResponse(200, [10]) as never);
    const client = new HttpClient();
    await expect(
      client.fetch('https://www.joysound.com/web/karaoke/contents/new?page=1'),
    ).resolves.toBeDefined();
  });

  it('fetch allows www.joysound.com detail path', async () => {
    mockedRequest.mockReset();
    mockedRequest.mockImplementation(async () => fakeResponse(200, [10]) as never);
    const client = new HttpClient();
    await expect(
      client.fetch(
        'https://www.joysound.com/apis/v1/ise/fetchContentsDetail?kind=naviGroupId&id=1',
      ),
    ).resolves.toBeDefined();
  });

  it('fetch allows www.joysound.com full songlist path', async () => {
    mockedRequest.mockReset();
    mockedRequest.mockImplementation(async () => fakeResponse(200, [10]) as never);
    const client = new HttpClient();
    await expect(
      client.fetch('https://www.joysound.com/web/search/songlist/%E3%82%A2?page=1'),
    ).resolves.toBeDefined();
  });

  it('fetch rejects a disallowed path on www.joysound.com', async () => {
    const client = new HttpClient();
    await expect(client.fetch('https://www.joysound.com/web/search/song/12345')).rejects.toThrow(
      /Disallowed path/,
    );
  });
});

describe('HttpClient — response body size cap (S6)', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('fetch rejects a response body exceeding 50 MB', async () => {
    // Two chunks: 40 MB + 11 MB = 51 MB total, which exceeds the 50 MB cap.
    const fortyMB = 40 * 1024 * 1024;
    const elevenMB = 11 * 1024 * 1024;

    // First undici call is robots.txt (small OK body so it passes through).
    // Second call is the actual URL with the oversized body.
    // Each call must return a fresh response object with a fresh async iterator.
    let callCount = 0;
    mockedRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // robots.txt — tiny body, passes the cap
        return fakeResponse(200, [10]) as never;
      }
      // actual URL — oversized body
      return fakeResponse(200, [fortyMB, elevenMB]) as never;
    });

    const client = new HttpClient();
    await expect(client.fetch('https://j-pop-playlist.tistory.com/test')).rejects.toThrow(
      /exceeds size limit/,
    );
  });

  it('postForm rejects a response body exceeding 50 MB', async () => {
    const fortyMB = 40 * 1024 * 1024;
    const elevenMB = 11 * 1024 * 1024;

    // postForm calls robots.txt first, then the POST itself.
    // We want the POST response to be the oversized one.
    // Give robots.txt a tiny OK body so it passes, then overflow on the POST.
    let callCount = 0;
    mockedRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // robots.txt — small OK body
        return fakeResponse(200, [10]) as never;
      }
      // POST response — oversized
      return fakeResponse(200, [fortyMB, elevenMB]) as never;
    });

    const client = new HttpClient();
    await expect(
      client.postForm('https://www.tjmedia.com/legacy/api/newSongOfMonth', {
        searchYm: '200001',
      }),
    ).rejects.toThrow(/exceeds size limit/);
  });
});

// ---------------------------------------------------------------------------
// Helper: fake undici response with a UTF-8 text body (single chunk).
// ---------------------------------------------------------------------------
function fakeTextResponse(statusCode: number, text: string, headers: Record<string, string> = {}) {
  async function* bodyGen() {
    yield new TextEncoder().encode(text);
  }
  return {
    statusCode,
    headers,
    body: bodyGen(),
  };
}

/** Zero rate-limit override for the blog host so cache tests run fast. */
const FAST_BLOG_HOST = { minIntervalMs: 0, jitterMs: 0 };

describe('HttpClient — cache persist batching', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    mockedRename.mockClear();
    mockedRequest.mockImplementation(async () => fakeTextResponse(200, 'ok') as never);
  });

  it('persists at most once per batch instead of once per store', async () => {
    const client = new HttpClient({
      cachePersistEvery: 3,
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });
    for (let i = 0; i < 7; i++) {
      await client.fetch(`https://j-pop-playlist.tistory.com/batch-${i}`);
    }
    // 7 stores with batch size 3 → persists after stores 3 and 6 only.
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });

  it('flush persists pending stores exactly once and is a no-op when clean', async () => {
    const client = new HttpClient({
      cachePersistEvery: 100,
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });
    await client.fetch('https://j-pop-playlist.tistory.com/flush-1');
    await client.fetch('https://j-pop-playlist.tistory.com/flush-2');
    expect(mockedRename).toHaveBeenCalledTimes(0);

    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(1);

    // Nothing pending → no extra write.
    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('a failed persist leaves stores pending; a subsequent flush retries and succeeds', async () => {
    const client = new HttpClient({
      cachePersistEvery: 100,
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });
    await client.fetch('https://j-pop-playlist.tistory.com/retry-1');

    // First flush attempt fails at the atomic rename (e.g. ENOSPC / AV lock).
    mockedRename.mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    await expect(client.flush()).rejects.toThrow(/EBUSY/);

    // The batch must still be pending: the retry persists it.
    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(2);

    // And the retry actually drained the batch — no further writes.
    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });

  it('concurrent flush calls are serialized into a single persist', async () => {
    const client = new HttpClient({
      cachePersistEvery: 100,
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });
    await client.fetch('https://j-pop-playlist.tistory.com/concurrent-1');

    // Two overlapping flushes: the second must join the in-flight persist
    // rather than start a second write (which would double-subtract the
    // batch and drive the pending counter negative). Both must resolve.
    await Promise.all([client.flush(), client.flush()]);
    expect(mockedRename).toHaveBeenCalledTimes(1);

    // The counter must not have gone negative: a fresh store still flushes
    // (a negative counter would absorb the new store and skip the persist).
    await client.fetch('https://j-pop-playlist.tistory.com/concurrent-2');
    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });

  it('persists when the time threshold elapses even below the batch size', async () => {
    const client = new HttpClient({
      cachePersistEvery: 1000,
      cachePersistMaxAgeMs: 0, // always elapsed → every store persists
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });
    await client.fetch('https://j-pop-playlist.tistory.com/age-1');
    await client.fetch('https://j-pop-playlist.tistory.com/age-2');
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });
});

describe('HttpClient — per-host cache opt-out', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    mockedRename.mockClear();
  });

  /** Headers undici saw for the GET of `url` (skips the robots.txt call). */
  function headersSentFor(url: string): Array<Record<string, string>> {
    return mockedRequest.mock.calls
      .filter(([target]) => target === url)
      .map(([, opts]) => (opts as { headers: Record<string, string> }).headers);
  }

  it('a host with cache: false neither stores nor serves from cache', async () => {
    mockedRequest.mockImplementation(
      async () => fakeTextResponse(200, 'fresh', { etag: '"v1"' }) as never,
    );
    const client = new HttpClient({
      hostConfigOverrides: {
        'j-pop-playlist.tistory.com': { ...FAST_BLOG_HOST, cache: false },
      },
    });
    const url = 'https://j-pop-playlist.tistory.com/no-cache';
    await client.fetch(url);
    await client.fetch(url);

    // Second GET must NOT carry conditional headers (nothing was cached).
    const sent = headersSentFor(url);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('if-none-match');
    expect(sent[1]).not.toHaveProperty('if-modified-since');

    // Nothing stored → flush writes nothing.
    await client.flush();
    expect(mockedRename).toHaveBeenCalledTimes(0);
  });

  it('default hosts still cache: conditional revalidation replays the cached body on 304', async () => {
    const url = 'https://j-pop-playlist.tistory.com/cached';
    let getCount = 0;
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) {
        return fakeTextResponse(200, '') as never;
      }
      getCount++;
      if (getCount === 1) {
        return fakeTextResponse(200, 'cached-body', { etag: '"v1"' }) as never;
      }
      return fakeTextResponse(304, '') as never;
    });
    const client = new HttpClient({
      hostConfigOverrides: { 'j-pop-playlist.tistory.com': FAST_BLOG_HOST },
    });

    const first = await client.fetch(url);
    expect(first?.body).toBe('cached-body');

    const second = await client.fetch(url);
    const sent = headersSentFor(url);
    expect(sent[1]).toHaveProperty('if-none-match', '"v1"');
    expect(second?.status).toBe(200);
    expect(second?.body).toBe('cached-body');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit reservation: concurrent callers must be staggered, not fired
// together after one shared gap. Sequential cadence must stay ~minInterval.
// ---------------------------------------------------------------------------
describe('HttpClient — rate-limit reservation', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('staggers concurrent GETs by the per-host interval instead of firing together', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const getTimes: number[] = [];
      mockedRequest.mockImplementation(async (target) => {
        if (String(target).endsWith('/robots.txt')) {
          return fakeTextResponse(200, '') as never;
        }
        getTimes.push(Date.now());
        return fakeTextResponse(200, 'ok') as never;
      });

      // jitter 0 → gap is exactly minIntervalMs so timings are deterministic.
      const client = new HttpClient({
        maxRetries: 0,
        hostConfigOverrides: {
          'j-pop-playlist.tistory.com': { minIntervalMs: 100, jitterMs: 0 },
        },
      });

      const all = Promise.all([0, 1, 2].map((i) => client.fetch(`https://j-pop-playlist.tistory.com/c-${i}`)));
      await vi.advanceTimersByTimeAsync(1000);
      await all;

      // Reserved slots: 0ms, 100ms, 200ms. Without reservation all three would
      // have fired at ~0ms (one shared gap read).
      expect(getTimes).toEqual([0, 100, 200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spaces sequential GETs by the per-host interval; first request is immediate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const getTimes: number[] = [];
      mockedRequest.mockImplementation(async (target) => {
        if (String(target).endsWith('/robots.txt')) {
          return fakeTextResponse(200, '') as never;
        }
        getTimes.push(Date.now());
        return fakeTextResponse(200, 'ok') as never;
      });
      const client = new HttpClient({
        maxRetries: 0,
        hostConfigOverrides: {
          'j-pop-playlist.tistory.com': { minIntervalMs: 200, jitterMs: 0 },
        },
      });

      const p1 = client.fetch('https://j-pop-playlist.tistory.com/s-1');
      await vi.advanceTimersByTimeAsync(0);
      await p1;
      const p2 = client.fetch('https://j-pop-playlist.tistory.com/s-2');
      await vi.advanceTimersByTimeAsync(500);
      await p2;

      expect(getTimes[0]).toBe(0); // first request: no wait
      expect(getTimes[1]).toBe(200); // second request: one full interval later
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Transient-failure retry on the idempotent GET path.
// retryBaseDelayMs:0 + minIntervalMs:0 → no real waiting, so real timers are
// fine and each test resolves promptly.
// ---------------------------------------------------------------------------
describe('HttpClient — GET retry', () => {
  const FAST_RETRY = {
    maxRetries: 2,
    retryBaseDelayMs: 0,
    hostConfigOverrides: {
      'j-pop-playlist.tistory.com': { minIntervalMs: 0, jitterMs: 0 },
    },
  } as const;

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  /** Count of non-robots (i.e. actual target) requests seen by the mock. */
  function targetCalls(url: string): number {
    return mockedRequest.mock.calls.filter(([target]) => target === url).length;
  }

  it('retries a 5xx and returns the eventual 200', async () => {
    const url = 'https://j-pop-playlist.tistory.com/flaky';
    let n = 0;
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      n++;
      return (n === 1 ? fakeTextResponse(503, 'busy') : fakeTextResponse(200, 'ok')) as never;
    });

    const client = new HttpClient(FAST_RETRY);
    const res = await client.fetch(url);
    expect(res?.status).toBe(200);
    expect(res?.body).toBe('ok');
    expect(targetCalls(url)).toBe(2); // one retry
  });

  it('retries a 429 (rate limited) and returns the eventual 200', async () => {
    const url = 'https://j-pop-playlist.tistory.com/throttled';
    let n = 0;
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      n++;
      return (n === 1
        ? fakeTextResponse(429, 'slow down', { 'retry-after': '0' })
        : fakeTextResponse(200, 'ok')) as never;
    });

    const client = new HttpClient(FAST_RETRY);
    const res = await client.fetch(url);
    expect(res?.status).toBe(200);
    expect(targetCalls(url)).toBe(2);
  });

  it('does NOT retry a 4xx client error', async () => {
    const url = 'https://j-pop-playlist.tistory.com/gone';
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      return fakeTextResponse(404, 'not found') as never;
    });

    const client = new HttpClient(FAST_RETRY);
    const res = await client.fetch(url);
    expect(res?.status).toBe(404);
    expect(targetCalls(url)).toBe(1); // no retry
  });

  it('propagates the final 5xx response after retries are exhausted', async () => {
    const url = 'https://j-pop-playlist.tistory.com/down';
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      return fakeTextResponse(500, 'err') as never;
    });

    const client = new HttpClient(FAST_RETRY);
    const res = await client.fetch(url);
    expect(res?.status).toBe(500);
    expect(targetCalls(url)).toBe(3); // initial + 2 retries
  });

  it('retries a retryable network error and then succeeds', async () => {
    const url = 'https://j-pop-playlist.tistory.com/reset';
    let n = 0;
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      n++;
      if (n === 1) {
        const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw err;
      }
      return fakeTextResponse(200, 'ok') as never;
    });

    const client = new HttpClient(FAST_RETRY);
    const res = await client.fetch(url);
    expect(res?.status).toBe(200);
    expect(targetCalls(url)).toBe(2);
  });

  it('rethrows the network error once retries are exhausted', async () => {
    const url = 'https://j-pop-playlist.tistory.com/dead';
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });

    const client = new HttpClient(FAST_RETRY);
    await expect(client.fetch(url)).rejects.toThrow(/ETIMEDOUT/);
    expect(targetCalls(url)).toBe(3); // initial + 2 retries
  });

  it('does NOT retry a non-retryable network error', async () => {
    const url = 'https://j-pop-playlist.tistory.com/nohost';
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });

    const client = new HttpClient(FAST_RETRY);
    await expect(client.fetch(url)).rejects.toThrow(/ENOTFOUND/);
    expect(targetCalls(url)).toBe(1); // no retry
  });

  it('a successful retry still stores the body in cache', async () => {
    const url = 'https://j-pop-playlist.tistory.com/flaky-cached';
    let n = 0;
    mockedRequest.mockImplementation(async (target) => {
      if (String(target).endsWith('/robots.txt')) return fakeTextResponse(200, '') as never;
      n++;
      return (n === 1
        ? fakeTextResponse(503, 'busy')
        : fakeTextResponse(200, 'final', { etag: '"v9"' })) as never;
    });

    const client = new HttpClient({ ...FAST_RETRY, cachePersistEvery: 1 });
    const first = await client.fetch(url);
    expect(first?.body).toBe('final');
    // Second fetch should carry the conditional header from the cached success.
    await client.fetch(url);
    const conditional = mockedRequest.mock.calls
      .filter(([target]) => target === url)
      .map(([, opts]) => (opts as { headers: Record<string, string> }).headers)
      .some((h) => h['if-none-match'] === '"v9"');
    expect(conditional).toBe(true);
  });
});
