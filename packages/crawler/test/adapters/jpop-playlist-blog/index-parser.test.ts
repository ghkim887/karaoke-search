import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIndexPage } from '../../../src/adapters/jpop-playlist-blog/index-parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = resolve(HERE, '../../fixtures/blog');

describe('parseIndexPage — /98 (J-POP)', () => {
  const html = readFileSync(resolve(FIXTURES, 'index-98.html'), 'utf8');
  const paths = parseIndexPage(html);

  it('extracts at least 20 distinct artist paths', () => {
    expect(paths.length).toBeGreaterThanOrEqual(20);
  });

  it('every path matches /^\\/\\d+$/', () => {
    for (const p of paths) {
      expect(p).toMatch(/^\/\d+$/);
    }
  });

  it('paths are unique', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('parseIndexPage — synthetic', () => {
  it('dedupes repeated hrefs, accepts absolute j-pop-playlist URLs, rejects non-numeric paths', () => {
    const html = `<html><body>
      <a href="/449">relative</a>
      <a href="/449">duplicate</a>
      <a href="https://j-pop-playlist.tistory.com/215">absolute</a>
      <a href="/about">no — non-numeric</a>
      <a href="/98#frag">no — fragment</a>
      <a href="https://other.test/123">no — wrong host</a>
    </body></html>`;
    expect(parseIndexPage(html)).toEqual(['/449', '/215']);
  });
});
