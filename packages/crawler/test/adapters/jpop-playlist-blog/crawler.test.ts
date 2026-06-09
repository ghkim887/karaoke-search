import { describe, expect, it } from 'vitest';
import { BlogCrawler } from '../../../src/adapters/jpop-playlist-blog/crawler.js';
import type { HttpClient } from '../../../src/http.js';

const BASE = 'https://j-pop-playlist.tistory.com';

function indexHtml(paths: string[]): string {
  // index-parser scrapes anchors whose href matches the tistory blog.
  // Emit absolute links to be safe across any matching strategy.
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

describe('BlogCrawler.crawl — walks both indexes, de-dupes artists', () => {
  it('fetches BOTH /98 and /417, then crawls the de-duped union of artist paths', async () => {
    const index98 = ['/101', '/102', '/103'];
    const index417 = ['/201', '/202', '/103']; // /103 overlaps with /98

    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        fetched.push(url);
        if (url === `${BASE}/98`) return { status: 200, body: indexHtml(index98) };
        if (url === `${BASE}/417`) return { status: 200, body: indexHtml(index417) };
        return { status: 200, body: artistHtml() };
      },
    };

    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl()) records.push(r);

    // Both index pages are fetched for coverage.
    expect(fetched).toContain(`${BASE}/98`);
    expect(fetched).toContain(`${BASE}/417`);

    // Artist fetches are the de-duped union: /103 appears once.
    const artistFetches = fetched.filter((u) => u !== `${BASE}/98` && u !== `${BASE}/417`);
    const artistPaths = artistFetches.map((u) => u.replace(BASE, ''));
    expect(new Set(artistPaths)).toEqual(new Set(['/101', '/102', '/103', '/201', '/202']));
    expect(artistPaths.length).toBe(5);

    // 5 artists × 1 row each ⇒ 5 records.
    expect(records.length).toBe(5);
  });

  it('caps artist-page fetches at the supplied limit', async () => {
    const index98 = ['/101', '/102', '/103', '/104', '/105'];
    const index417 = ['/201', '/202'];

    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        fetched.push(url);
        if (url === `${BASE}/98`) return { status: 200, body: indexHtml(index98) };
        if (url === `${BASE}/417`) return { status: 200, body: indexHtml(index417) };
        return { status: 200, body: artistHtml() };
      },
    };

    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    const records = [];
    for await (const r of crawler.crawl({ limit: 3 })) records.push(r);

    // 2 index requests + 3 artist requests = 5 fetches.
    const artistFetches = fetched.filter((u) => u !== `${BASE}/98` && u !== `${BASE}/417`);
    expect(artistFetches.length).toBe(3);
    expect(records.length).toBe(3);
  });

  it('iterates artist paths in first-seen order across both indexes', async () => {
    const index98 = ['/101', '/102'];
    const index417 = ['/201'];

    const fetched: string[] = [];
    const fakeHttp: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        fetched.push(url);
        if (url === `${BASE}/98`) return { status: 200, body: indexHtml(index98) };
        if (url === `${BASE}/417`) return { status: 200, body: indexHtml(index417) };
        return { status: 200, body: artistHtml() };
      },
    };

    const crawler = new BlogCrawler(fakeHttp as HttpClient);
    for await (const _ of crawler.crawl()) {
      // drain
    }

    const artistPaths = fetched
      .filter((u) => u !== `${BASE}/98` && u !== `${BASE}/417`)
      .map((u) => u.replace(BASE, ''));
    // /98 artists first (in order), then /417 artists.
    expect(artistPaths).toEqual(['/101', '/102', '/201']);
  });
});
