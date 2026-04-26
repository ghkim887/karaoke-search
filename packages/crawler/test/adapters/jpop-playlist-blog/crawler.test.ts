import { describe, expect, it } from 'vitest';
import { BlogCrawler, orderArtists } from '../../../src/adapters/jpop-playlist-blog/crawler.js';
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
