import { describe, expect, it } from 'vitest';
import {
  BlogCrawler,
  getPostCategoryOverride,
  orderArtists,
} from '../../../src/adapters/jpop-playlist-blog/crawler.js';
import type { HttpClient } from '../../../src/http.js';

describe('orderArtists — round-robin balancing', () => {
  it('interleaves jpop-only and vocaloid-only, then appends mixed', () => {
    const m = new Map<string, Set<'jpop' | 'vocaloid'>>([
      ['/101', new Set(['jpop'])],
      ['/102', new Set(['jpop'])],
      ['/103', new Set(['jpop'])],
      ['/104', new Set(['jpop'])],
      ['/105', new Set(['jpop'])],
      ['/201', new Set(['vocaloid'])],
      ['/202', new Set(['vocaloid'])],
      ['/203', new Set(['vocaloid'])],
      ['/204', new Set(['vocaloid'])],
      ['/205', new Set(['vocaloid'])],
      ['/301', new Set(['jpop', 'vocaloid'])],
      ['/302', new Set(['jpop', 'vocaloid'])],
    ]);
    const ordered = orderArtists(m);
    // First 10 are interleaved jpop/vocaloid; last 2 are mixed.
    expect(ordered.map((o) => o.path)).toEqual([
      '/101',
      '/201',
      '/102',
      '/202',
      '/103',
      '/203',
      '/104',
      '/204',
      '/105',
      '/205',
      '/301',
      '/302',
    ]);
  });
});

describe('BlogCrawler.crawl — limit + round-robin balancing', () => {
  it('with limit=4 over (5 jpop-only, 5 vocaloid-only, 2 mixed), fetches 4 distinct artists with first 2 jpop and next 2 vocaloid', async () => {
    // Build a fake HttpClient. Index pages emit absolute URLs; mirror that.
    const BASE = 'https://j-pop-playlist.tistory.com';
    const jpopArtists = ['/101', '/102', '/103', '/104', '/105'];
    const vocaloidArtists = ['/201', '/202', '/203', '/204', '/205'];
    const mixedArtists = ['/301', '/302'];

    function indexHtml(paths: string[]): string {
      // index-parser scrapes anchors whose href matches the tistory blog.
      // We emit absolute links to be safe across any matching strategy.
      const links = paths.map((p) => `<a href="${BASE}${p}">x</a>`).join('\n');
      return `<html><body>${links}</body></html>`;
    }

    function artistHtml(): string {
      // Minimal valid artist body: blockquote with one-line artist name +
      // a single 4-cell row whose number cells are non-header.
      return `
<html><body>
<div class="tt_article_useless_p_margin">
  <blockquote><p>FakeArtist</p></blockquote>
  <table><tbody>
    <tr><td>Song</td><td>1</td><td>2</td><td>3</td></tr>
  </tbody></table>
</div>
</body></html>`;
    }

    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        fetched.push(url);
        if (url === `${BASE}/98`) {
          // jpop index: jpop-only artists + the 2 mixed ones
          return { status: 200, body: indexHtml([...jpopArtists, ...mixedArtists]) };
        }
        if (url === `${BASE}/417`) {
          // vocaloid index: vocaloid-only artists + the 2 mixed ones
          return { status: 200, body: indexHtml([...vocaloidArtists, ...mixedArtists]) };
        }
        return { status: 200, body: artistHtml() };
      },
    };

    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl({ limit: 4 })) records.push(r);

    // 2 index requests + 4 artist requests = 6 fetches.
    expect(fetched.length).toBe(6);
    const artistFetches = fetched.filter((u) => u !== `${BASE}/98` && u !== `${BASE}/417`);
    expect(artistFetches.length).toBe(4);

    // Round-robin: positions 0+2 must be jpop-only, 1+3 vocaloid-only.
    const order = artistFetches.map((u) => u.replace(BASE, ''));
    expect(jpopArtists).toContain(order[0]);
    expect(vocaloidArtists).toContain(order[1]);
    expect(jpopArtists).toContain(order[2]);
    expect(vocaloidArtists).toContain(order[3]);

    // The 4 artists are distinct.
    expect(new Set(order).size).toBe(4);

    // 4 artists × 1 row each ⇒ 4 records.
    expect(records.length).toBe(4);
  });
});

describe('getPostCategoryOverride — per-post category override map', () => {
  it('returns "jpop" for the three audited overridden posts', () => {
    expect(getPostCategoryOverride('/101')).toBe('jpop'); // 米津玄師
    expect(getPostCategoryOverride('/105')).toBe('jpop'); // Zutomayo
    expect(getPostCategoryOverride('/112')).toBe('jpop'); // Aimer
  });

  it('returns null for non-overridden artist paths', () => {
    // Vocaloid catalog (ハチ-era 米津玄師) — must NOT be demoted.
    expect(getPostCategoryOverride('/428')).toBeNull();
    // Random other paths.
    expect(getPostCategoryOverride('/449')).toBeNull();
    expect(getPostCategoryOverride('/215')).toBeNull();
    expect(getPostCategoryOverride('/1')).toBeNull();
  });

  it('returns null for malformed paths (missing leading slash, non-numeric, empty)', () => {
    expect(getPostCategoryOverride('101')).toBeNull(); // no leading slash
    expect(getPostCategoryOverride('/abc')).toBeNull();
    expect(getPostCategoryOverride('')).toBeNull();
    expect(getPostCategoryOverride('/101/extra')).toBeNull();
  });
});

describe('BlogCrawler.crawl — POST_CATEGORY_OVERRIDES enforcement', () => {
  // Shared minimal artist-page HTML (one row, one song).
  function artistHtml(): string {
    return `
<html><body>
<div class="tt_article_useless_p_margin">
  <blockquote><p>FakeArtist</p></blockquote>
  <table><tbody>
    <tr><td>Song</td><td>1</td><td>2</td><td>3</td></tr>
  </tbody></table>
</div>
</body></html>`;
  }

  function indexHtml(paths: string[]): string {
    const BASE = 'https://j-pop-playlist.tistory.com';
    const links = paths.map((p) => `<a href="${BASE}${p}">x</a>`).join('\n');
    return `<html><body>${links}</body></html>`;
  }

  it('overrides /101 (米津玄師-blog-101) from index-derived vocaloid to jpop', async () => {
    const BASE = 'https://j-pop-playlist.tistory.com';
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        if (url === `${BASE}/98`) {
          // jpop index — does NOT include /101 (so the only category signal
          // for /101 comes from the vocaloid index).
          return { status: 200, body: indexHtml(['/999']) };
        }
        if (url === `${BASE}/417`) {
          // vocaloid index — surfaces /101 as a Vocaloid post (this is the
          // bug the override fixes: the index author miscategorized it).
          return { status: 200, body: indexHtml(['/101']) };
        }
        return { status: 200, body: artistHtml() };
      },
    };
    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    const blog101 = records.filter((r) => r.id.startsWith('blog-101-'));
    expect(blog101.length).toBeGreaterThan(0);
    for (const r of blog101) {
      // Override forces jpop, not vocaloid.
      expect(r.categories).toEqual(['jpop']);
    }
  });

  it('does NOT override a non-listed vocaloid post (e.g. /428 ハチ catalog stays vocaloid)', async () => {
    const BASE = 'https://j-pop-playlist.tistory.com';
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        if (url === `${BASE}/98`) return { status: 200, body: indexHtml([]) };
        if (url === `${BASE}/417`) {
          // /428 is the genuinely-Vocaloid ハチ catalog — must stay vocaloid.
          return { status: 200, body: indexHtml(['/428']) };
        }
        return { status: 200, body: artistHtml() };
      },
    };
    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    const blog428 = records.filter((r) => r.id.startsWith('blog-428-'));
    expect(blog428.length).toBeGreaterThan(0);
    for (const r of blog428) {
      expect(r.categories).toEqual(['vocaloid']);
    }
  });

  it('overrides take precedence even when the post appears in BOTH indexes', async () => {
    // Defense-in-depth case: if a future blog-index reshuffle accidentally
    // surfaces /105 in BOTH /98 and /417, the override still wins (no
    // priority rule should re-elevate it back to vocaloid).
    const BASE = 'https://j-pop-playlist.tistory.com';
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        if (url === `${BASE}/98`) return { status: 200, body: indexHtml(['/105']) };
        if (url === `${BASE}/417`) return { status: 200, body: indexHtml(['/105']) };
        return { status: 200, body: artistHtml() };
      },
    };
    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    const blog105 = records.filter((r) => r.id.startsWith('blog-105-'));
    expect(blog105.length).toBeGreaterThan(0);
    for (const r of blog105) {
      expect(r.categories).toEqual(['jpop']);
    }
  });
});
