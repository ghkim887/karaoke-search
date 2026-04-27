import { describe, expect, it } from 'vitest';
import { TJDirectCrawler } from '../../../src/adapters/tj-media-direct/crawler.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

/**
 * Build a minimal TJ result-page HTML containing one row per `(tj, title,
 * artist)` triple. Mirrors the fixture's structural pattern at the level
 * the parser cares about (selectors only).
 */
function buildPageHtml(rows: Array<{ tj: string; title: string; artist: string }>): string {
  const cells = rows
    .map(
      (r) => `
      <li>
        <ul class="grid-container list ico">
          <li class="grid-item center pos-type"><p class="count"><span class="num2">${r.tj}</span></p></li>
          <li class="grid-item title3">
            <div class="flex-box ico-flex">
              <p><span>${r.title}</span></p>
            </div>
          </li>
          <li class="grid-item title4 singer"><p><span><span class="highlight">${r.artist}</span></span></p></li>
        </ul>
      </li>`,
    )
    .join('\n');
  return `<!doctype html><html><body>
    <ul class="chart-list-area music">
      <li>
        <ul class="grid-container top music">
          <li class="grid-item">곡 번호</li>
        </ul>
      </li>
      ${cells}
    </ul>
  </body></html>`;
}

const EMPTY_PAGE_HTML = '<html><body>검색 결과를 찾을 수 없습니다.</body></html>';

describe('TJDirectCrawler.crawl — fixture-stub HTTP', () => {
  it('yields one record per row across two artists with distinct TJ#s', async () => {
    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string): Promise<FetchResult | null> {
        fetched.push(url);
        if (url.includes('searchTxt=ArtistA') && url.includes('pageNo=1')) {
          return {
            status: 200,
            body: buildPageHtml([
              { tj: '10001', title: 'Song A1', artist: 'ArtistA' },
              { tj: '10002', title: 'Song A2', artist: 'ArtistA' },
            ]),
          };
        }
        if (url.includes('searchTxt=ArtistB') && url.includes('pageNo=1')) {
          return {
            status: 200,
            body: buildPageHtml([{ tj: '20001', title: 'Song B1', artist: 'ArtistB' }]),
          };
        }
        // Page 2 always empty in this scenario.
        return { status: 200, body: EMPTY_PAGE_HTML };
      },
    };

    const crawler = new TJDirectCrawler(fakeHttp as HttpClient, ['ArtistA', 'ArtistB']);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(records.length).toBe(3);
    expect(records.map((r) => r.karaoke_numbers.tj).sort()).toEqual(['10001', '10002', '20001']);
    expect(records.every((r) => r.categories.length === 1 && r.categories[0] === 'jpop')).toBe(
      true,
    );
  });

  it('dedupes across artist queries — a duet matching two artists is yielded once', async () => {
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string): Promise<FetchResult | null> {
        if (url.includes('pageNo=1') && url.includes('searchTxt=ArtistA')) {
          return {
            status: 200,
            body: buildPageHtml([{ tj: '99999', title: 'Duet Song', artist: 'ArtistA & ArtistB' }]),
          };
        }
        if (url.includes('pageNo=1') && url.includes('searchTxt=ArtistB')) {
          // Same TJ#, different artist-cell rendering — a TJ duet matches
          // both artist searches; the crawler must emit it only once.
          return {
            status: 200,
            body: buildPageHtml([{ tj: '99999', title: 'Duet Song', artist: 'ArtistA & ArtistB' }]),
          };
        }
        return { status: 200, body: EMPTY_PAGE_HTML };
      },
    };

    const crawler = new TJDirectCrawler(fakeHttp as HttpClient, ['ArtistA', 'ArtistB']);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(records.length).toBe(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('99999');
  });

  it('stops paginating early when page 1 returns zero rows', async () => {
    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string): Promise<FetchResult | null> {
        fetched.push(url);
        // Both pages return empty for ArtistA; we expect page 2 to NOT be
        // requested because page 1 returned zero rows.
        return { status: 200, body: EMPTY_PAGE_HTML };
      },
    };

    const crawler = new TJDirectCrawler(fakeHttp as HttpClient, ['ArtistA']);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(records.length).toBe(0);
    // Only page 1 was fetched — the empty-page terminator skipped page 2.
    const pageRequests = fetched.filter((u) => u.includes('pageNo='));
    expect(pageRequests.length).toBe(1);
    expect(pageRequests[0]).toContain('pageNo=1');
  });

  it('walks page 2 when page 1 has results', async () => {
    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string): Promise<FetchResult | null> {
        fetched.push(url);
        if (url.includes('pageNo=1')) {
          return {
            status: 200,
            body: buildPageHtml([{ tj: '30001', title: 'P1 Song', artist: 'ArtistC' }]),
          };
        }
        if (url.includes('pageNo=2')) {
          return {
            status: 200,
            body: buildPageHtml([{ tj: '30002', title: 'P2 Song', artist: 'ArtistC' }]),
          };
        }
        return { status: 200, body: EMPTY_PAGE_HTML };
      },
    };

    const crawler = new TJDirectCrawler(fakeHttp as HttpClient, ['ArtistC']);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    expect(records.length).toBe(2);
    expect(records.map((r) => r.karaoke_numbers.tj).sort()).toEqual(['30001', '30002']);
    // Both pages requested; nothing beyond page 2.
    const pageRequests = fetched.filter((u) => u.includes('pageNo='));
    expect(pageRequests.length).toBe(2);
  });

  it('honors options.limit by capping artist queries', async () => {
    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string): Promise<FetchResult | null> {
        fetched.push(url);
        return { status: 200, body: EMPTY_PAGE_HTML };
      },
    };

    const crawler = new TJDirectCrawler(fakeHttp as HttpClient, ['A1', 'A2', 'A3', 'A4', 'A5']);
    const records = [];
    for await (const r of crawler.crawl({ limit: 2 })) records.push(r);

    // 5 seeds, limit 2 → only 2 artists queried (1 page each, terminator
    // halts page 2 since both empty). Total fetches: 2.
    const distinctArtists = new Set(
      fetched
        .map((u) => new URL(u).searchParams.get('searchTxt'))
        .filter((s): s is string => s !== null),
    );
    expect(distinctArtists.size).toBe(2);
    expect(records.length).toBe(0);
  });
});
