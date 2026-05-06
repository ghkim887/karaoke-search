import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from './retry.js';

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** Flush all microtasks (resolved promises) without advancing wall time. */
async function flushMicrotasks(): Promise<void> {
  // Multiple rounds to handle chained promises
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic jitter: factor = 0.8 + 0.4*0.5 = 1.0 (no jitter offset)
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ─── basic happy path ──────────────────────────────────────────────────────

  it('returns immediately on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://example.com/data.json');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── Retry-After: integer seconds ─────────────────────────────────────────

  it('waits Retry-After seconds (integer form) before second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, { 'Retry-After': '5' }))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/');

    // Flush microtasks: first fetch resolves and schedules sleep(5000)
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance 4999ms — second fetch must NOT have fired yet
    await vi.advanceTimersByTimeAsync(4999);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance the final ms — sleep resolves, second fetch fires
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const res = await promise;
    expect(res.ok).toBe(true);
  });

  // ─── Retry-After: HTTP-date form ───────────────────────────────────────────

  it('waits Retry-After HTTP-date before second attempt', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const retryDate = new Date('2026-01-01T00:00:10.000Z').toUTCString();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': retryDate }))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(9999);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const res = await promise;
    expect(res.ok).toBe(true);
  });

  // ─── exponential backoff doubles between attempts ──────────────────────────

  it('doubles the base delay between consecutive non-2xx attempts', async () => {
    // With Math.random()=0.5: backoffMs(0)=1000ms, backoffMs(1)=2000ms
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/', undefined, 1000, { maxAttempts: 3 });
    await flushMicrotasks();

    // First attempt fired; backoff delay = backoffMs(0) = 1000ms
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    // Second attempt fires after 1000ms
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second backoff delay = backoffMs(1) = 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const res = await promise;
    expect(res.ok).toBe(true);
  });

  // ─── max-attempts cap ─────────────────────────────────────────────────────

  it('throws after exactly maxAttempts attempts when all fail with non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/', undefined, 1000, { maxAttempts: 3 });
    // Attach rejection handler BEFORE advancing timers so it's registered before the
    // promise can settle, preventing an unhandled rejection warning.
    const assertion = expect(promise).rejects.toThrow('fetch failed after retry:');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exactly maxAttempts attempts when all throw (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/', undefined, 1000, { maxAttempts: 3 });
    const assertion = expect(promise).rejects.toThrow('fetch failed after retry:');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // ─── Retry-After clamped to 30s max ───────────────────────────────────────

  it('clamps Retry-After beyond 30s to 30000ms', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, { 'Retry-After': '9999' }))
      .mockResolvedValue(makeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.com/');
    await flushMicrotasks();

    // Must not fire before 30000ms (the clamp ceiling)
    await vi.advanceTimersByTimeAsync(29999);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const res = await promise;
    expect(res.ok).toBe(true);
  });
});
