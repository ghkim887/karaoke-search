import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TJDirectCrawler } from '../../../src/adapters/tj-media-direct/crawler.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT);

/**
 * The fixture's loose-JP-relevant subset — drives the expected output count.
 * Hand-built fixture: 31 JP-relevant + 10 Korean + 10 English-only.
 */
const EXPECTED_JP_COUNT = 31;
const CATALOG_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

interface Captured {
  url: string;
  body: Record<string, string>;
}

function buildHttp(opts: {
  status?: number;
  body?: string;
  captured?: Captured[];
  postFormImpl?: HttpClient['postForm'];
}): Pick<HttpClient, 'postForm'> {
  const captured = opts.captured;
  return {
    async postForm(url, body): Promise<FetchResult | null> {
      if (captured) captured.push({ url, body: { ...body } });
      if (opts.postFormImpl) return opts.postFormImpl(url, body);
      return { status: opts.status ?? 200, body: opts.body ?? FIXTURE_TEXT };
    },
  };
}

describe('TJDirectCrawler.crawl — fixture-stub HTTP', () => {
  it('issues a single POST to the catalog endpoint with searchYm=200001', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({ captured });
    const crawler = new TJDirectCrawler(http as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe(CATALOG_URL);
    expect(captured[0]?.body).toEqual({ searchYm: '200001' });
    expect(records.length).toBe(EXPECTED_JP_COUNT);
  });

  it('every emitted record has categories=["jpop"] and TJ number set', async () => {
    const http = buildHttp({});
    const crawler = new TJDirectCrawler(http as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(records.length).toBe(EXPECTED_JP_COUNT);
    for (const r of records) {
      expect(r.categories).toEqual(['jpop']);
      expect(r.karaoke_numbers.tj).toMatch(/^\d+$/);
      expect(r.karaoke_numbers.ky).toBeNull();
      expect(r.karaoke_numbers.joysound).toBeNull();
    }
  });

  it('honors options.limit by capping yielded records', async () => {
    const http = buildHttp({});
    const crawler = new TJDirectCrawler(http as HttpClient);
    const records = [];
    for await (const r of crawler.crawl({ limit: 5 })) records.push(r);
    expect(records.length).toBe(5);
  });

  it('throws when the HTTP layer returns a non-2xx status', async () => {
    const http = buildHttp({ status: 503, body: '<html>Service Unavailable</html>' });
    const crawler = new TJDirectCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the body is not valid JSON', async () => {
    const http = buildHttp({ status: 200, body: 'not json {{{' });
    const crawler = new TJDirectCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the response shape is unexpected (missing resultData)', async () => {
    const http = buildHttp({ status: 200, body: JSON.stringify({ resultCode: '00' }) });
    const crawler = new TJDirectCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/resultData/);
  });

  it('throws when robots.txt disallows the URL (postForm returns null)', async () => {
    const http = buildHttp({
      postFormImpl: async () => null,
    });
    const crawler = new TJDirectCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/robots\.txt/);
  });
});
