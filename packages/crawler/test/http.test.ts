import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';

// ---------------------------------------------------------------------------
// Mock undici so tests never hit the network.
// ---------------------------------------------------------------------------
vi.mock('undici', () => ({
  request: vi.fn(),
}));

import { request as mockRequest } from 'undici';
const mockedRequest = vi.mocked(mockRequest);

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
