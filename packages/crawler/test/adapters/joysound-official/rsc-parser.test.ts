import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseJoysoundListItems,
  parseJoysoundPagination,
} from '../../../src/adapters/joysound-official/rsc-parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = resolve(HERE, '../../fixtures/joysound-official');

/**
 * Build a Next.js-style RSC chunk push containing the given inner string.
 * The inner string is interpreted as a JS string literal — the helper
 * escapes `"` and `\` so callers can write JSON-ish snippets literally.
 */
function pushChunk(inner: string): string {
  const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `self.__next_f.push([1,"${escaped}"])`;
}

describe('parseJoysoundListItems — happy path', () => {
  it('extracts a single naviGroup row from an RSC chunk', () => {
    const inner = `5:[{"naviGroupId":"123456","selSongNo":"123-45","songName":"夜に駆ける","artistName":"YOASOBI","artistId":"7890","tieupInfo":"$undefined","tieupId":"$undefined"}]`;
    const html = `<html><body><script>${pushChunk(inner)}</script></body></html>`;

    const items = parseJoysoundListItems(html);

    expect(items).toEqual([
      {
        naviGroupId: '123456',
        selSongNo: '123-45',
        songName: '夜に駆ける',
        artistName: 'YOASOBI',
        artistId: '7890',
        tieupInfo: null,
        tieupId: null,
      },
    ]);
  });

  it('extracts multiple naviGroup rows preserving first-seen order', () => {
    const inner = `[
      {"naviGroupId":"100001","selSongNo":"100-01","songName":"A","artistName":"X","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"},
      {"naviGroupId":"100002","selSongNo":"100-02","songName":"B","artistName":"Y","artistId":"1","tieupInfo":"アニメXのOP","tieupId":"T1"},
      {"naviGroupId":"100003","selSongNo":"100-03","songName":"C","artistName":"Z","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"}
    ]`;
    const html = `<script>${pushChunk(inner)}</script>`;
    const items = parseJoysoundListItems(html);

    expect(items.map((i) => i.naviGroupId)).toEqual(['100001', '100002', '100003']);
    expect(items[1]?.tieupInfo).toBe('アニメXのOP');
    expect(items[1]?.tieupId).toBe('T1');
    expect(items[1]?.artistId).toBe('1');
  });

  it('dedupes by naviGroupId, keeping the first occurrence', () => {
    const inner = `[
      {"naviGroupId":"200001","selSongNo":"200-01","songName":"First","artistName":"X","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"},
      {"naviGroupId":"200001","selSongNo":"200-99","songName":"Dup","artistName":"X","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"}
    ]`;
    const html = `<script>${pushChunk(inner)}</script>`;
    const items = parseJoysoundListItems(html);

    expect(items).toHaveLength(1);
    expect(items[0]?.selSongNo).toBe('200-01');
    expect(items[0]?.songName).toBe('First');
  });

  it('normalizes $undefined optional fields to null', () => {
    const inner = `[{"naviGroupId":"300001","selSongNo":"300-01","songName":"Solo","artistName":"X","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"}]`;
    const html = `<script>${pushChunk(inner)}</script>`;
    const items = parseJoysoundListItems(html);

    expect(items[0]).toMatchObject({
      artistId: null,
      tieupInfo: null,
      tieupId: null,
    });
  });

  it('returns an empty array when the page has no naviGroup objects', () => {
    const html = '<html><body><div>no items here</div></body></html>';
    expect(parseJoysoundListItems(html)).toEqual([]);
  });

  it('drops fragments missing required fields (e.g. only naviGroupId+songName)', () => {
    const inner = `[
      {"naviGroupId":"400001","songName":"Missing artist/selSongNo","other":"x"},
      {"naviGroupId":"400002","selSongNo":"400-02","songName":"Ok","artistName":"X","artistId":"$undefined","tieupInfo":"$undefined","tieupId":"$undefined"}
    ]`;
    const html = `<script>${pushChunk(inner)}</script>`;
    const items = parseJoysoundListItems(html);

    expect(items.map((i) => i.naviGroupId)).toEqual(['400002']);
  });

  it('accepts numeric ids coerced to strings (e.g. naviGroupId rendered as a JSON number)', () => {
    const inner = `[{"naviGroupId":500001,"selSongNo":"500-01","songName":"NumId","artistName":"X","artistId":12345,"tieupInfo":"$undefined","tieupId":"$undefined"}]`;
    const html = `<script>${pushChunk(inner)}</script>`;
    const items = parseJoysoundListItems(html);

    expect(items).toHaveLength(1);
    expect(items[0]?.naviGroupId).toBe('500001');
    expect(items[0]?.artistId).toBe('12345');
  });
});

describe('parseJoysoundListItems — fixture: listing-page-sample.html', () => {
  it('extracts 3 deduped naviGroup rows in the documented order with $undefined→null', () => {
    const html = readFileSync(resolve(FIXTURES, 'listing-page-sample.html'), 'utf8');
    const items = parseJoysoundListItems(html);
    expect(items.map((i) => i.naviGroupId)).toEqual(['190001', '190002', '190003']);
    expect(items[0]?.tieupInfo).toBeNull();
    expect(items[1]?.tieupInfo).toBe('アニメ「【推しの子】」OP');
    expect(items[2]?.artistId).toBeNull();
  });
});

describe('parseJoysoundPagination', () => {
  it('returns totalPages from a totalPage RSC field', () => {
    const inner = `{"items":[],"totalPage":42,"page":1}`;
    const html = `<script>${pushChunk(inner)}</script>`;
    expect(parseJoysoundPagination(html)).toEqual({ totalPages: 42 });
  });

  it('also accepts the alternate totalPages key', () => {
    const inner = `{"items":[],"totalPages":17}`;
    const html = `<script>${pushChunk(inner)}</script>`;
    expect(parseJoysoundPagination(html)).toEqual({ totalPages: 17 });
  });

  it('returns totalPages=null when no totalPage field is present', () => {
    const html = '<html><body>no pagination data</body></html>';
    expect(parseJoysoundPagination(html)).toEqual({ totalPages: null });
  });

  it('returns totalPages=null when totalPage is zero or non-positive', () => {
    const inner = `{"totalPage":0}`;
    const html = `<script>${pushChunk(inner)}</script>`;
    expect(parseJoysoundPagination(html)).toEqual({ totalPages: null });
  });

  it('reads totalPage=12 from the listing-page fixture', () => {
    const html = readFileSync(resolve(FIXTURES, 'listing-page-sample.html'), 'utf8');
    expect(parseJoysoundPagination(html)).toEqual({ totalPages: 12 });
  });
});
