import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseArtistPage } from '../../../src/adapters/jpop-playlist-blog/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = resolve(HERE, '../../fixtures/blog');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

describe('parseArtistPage — Ayase /449', () => {
  const html = loadFixture('ayase-449.html');
  const url = 'https://j-pop-playlist.tistory.com/449';
  const records = parseArtistPage(html, url);

  it('extracts at least 10 records', () => {
    expect(records.length).toBeGreaterThanOrEqual(10);
  });

  it('every record has a non-empty title_primary', () => {
    for (const r of records) {
      expect(r.title_primary.length).toBeGreaterThan(0);
    }
  });

  it('at least 80% of records have a non-null title_ko', () => {
    const withKo = records.filter((r) => r.title_ko !== null).length;
    expect(withKo / records.length).toBeGreaterThanOrEqual(0.8);
  });

  it('every record has at least one non-null karaoke number', () => {
    for (const r of records) {
      const { tj, ky, joysound } = r.karaoke_numbers;
      expect(tj !== null || ky !== null || joysound !== null).toBe(true);
    }
  });

  it('every record carries the source_url passed in', () => {
    for (const r of records) {
      expect(r.source_url).toBe(url);
    }
  });

  it('extracts an artist_primary from the lead blockquote', () => {
    expect(records[0]?.artist_primary).toBe('Ayase');
  });

  it('parser leaves categories empty (the crawler tags them)', () => {
    for (const r of records) {
      expect(r.categories).toEqual([]);
    }
  });
});

describe('parseArtistPage — RADWIMPS /215', () => {
  const html = loadFixture('radwimps-215.html');
  const url = 'https://j-pop-playlist.tistory.com/215';
  const records = parseArtistPage(html, url);

  it('extracts at least 10 records', () => {
    expect(records.length).toBeGreaterThanOrEqual(10);
  });

  it('every record has a non-empty title_primary', () => {
    for (const r of records) {
      expect(r.title_primary.length).toBeGreaterThan(0);
    }
  });

  it('at least 80% of records have a non-null title_ko', () => {
    const withKo = records.filter((r) => r.title_ko !== null).length;
    expect(withKo / records.length).toBeGreaterThanOrEqual(0.8);
  });

  it('every record has at least one non-null karaoke number', () => {
    for (const r of records) {
      const { tj, ky, joysound } = r.karaoke_numbers;
      expect(tj !== null || ky !== null || joysound !== null).toBe(true);
    }
  });

  it('artist_primary is RADWIMPS', () => {
    expect(records[0]?.artist_primary).toBe('RADWIMPS');
  });
});

describe('parseArtistPage — unit cases', () => {
  function buildHtml(rowHtml: string): string {
    return `<!doctype html><html><body>
<div class="tt_article_useless_p_margin">
  <blockquote><p><span><span>아티스트</span></span><br/><span><span>Artist</span></span></p></blockquote>
  <table><tbody>${rowHtml}</tbody></table>
</div>
</body></html>`;
  }

  it('handles <br> and <br/> interchangeably', () => {
    const slash = buildHtml('<tr><td>正解<br/>정답</td><td>1</td><td>2</td><td>3</td></tr>');
    const noslash = buildHtml('<tr><td>正解<br>정답</td><td>1</td><td>2</td><td>3</td></tr>');
    const a = parseArtistPage(slash, 'https://x.test/1');
    const b = parseArtistPage(noslash, 'https://x.test/1');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.title_primary).toBe('正解');
    expect(a[0]?.title_ko).toBe('정답');
    expect(b[0]?.title_primary).toBe('正解');
    expect(b[0]?.title_ko).toBe('정답');
  });

  it('hyphen, en-dash, and em-dash all map number cells to null', () => {
    const html = buildHtml('<tr><td>Title A<br/>제목 A</td><td>-</td><td>–</td><td>—</td></tr>');
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: null });
  });

  it('unwraps <strong>, <b>, and <span> wrapping the title text', () => {
    const html = buildHtml(
      '<tr><td><strong>正解</strong><br/><b>정답</b></td><td>1</td><td>2</td><td>3</td></tr>' +
        '<tr><td><span style="color:red">夜に駆ける</span><br/><span>밤에 달리다</span></td><td>4</td><td>5</td><td>6</td></tr>',
    );
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(2);
    expect(recs[0]?.title_primary).toBe('正解');
    expect(recs[0]?.title_ko).toBe('정답');
    expect(recs[1]?.title_primary).toBe('夜に駆ける');
    expect(recs[1]?.title_ko).toBe('밤에 달리다');
  });

  it('treats &nbsp;-only and whitespace-only number cells as null', () => {
    const html = buildHtml(
      '<tr><td>Title<br/>제목</td><td>&nbsp;</td><td>   </td><td>123</td></tr>',
    );
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: '123' });
  });

  it('skips header rows that label the number columns TJ/KY/JOYSOUND', () => {
    const html = buildHtml(
      '<tr><td>곡명</td><td>TJ</td><td>KY</td><td>JOYSOUND</td></tr>' +
        '<tr><td>Title<br/>제목</td><td>1</td><td>2</td><td>3</td></tr>',
    );
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.title_primary).toBe('Title');
  });
});

describe('parseArtistPage — number-cell defensive guards', () => {
  function buildHtml(rowHtml: string): string {
    return `<!doctype html><html><body>
<div class="tt_article_useless_p_margin">
  <blockquote><p><span><span>아티스트</span></span><br/><span><span>Artist</span></span></p></blockquote>
  <table><tbody>${rowHtml}</tbody></table>
</div>
</body></html>`;
  }

  // Mirrors the live /523 中島美嘉 row — `25627<br>62161` previously fused
  // into the 10-digit value `2562762161` because the parser called .text()
  // on the <td> directly. Regression for the bug fixed in this commit.
  it('returns null (and warns) for TJ cells listing two codes via <br>', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = buildHtml(
        '<tr><td><b><span style="font-size: 12px;">雪の華</span></b><br /><span><span>눈의 꽃</span></span></td>' +
          '<td style="font-size: 11px;">25627<br>62161</td>' +
          '<td>41637</td><td>31783</td></tr>',
      );
      const recs = parseArtistPage(html, 'https://j-pop-playlist.tistory.com/523');
      expect(recs).toHaveLength(1);
      expect(recs[0]?.title_primary).toBe('雪の華');
      expect(recs[0]?.karaoke_numbers).toEqual({ tj: null, ky: '41637', joysound: '31783' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/dropping multi-value TJ cell/);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/雪の華/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Same bug in the second-half-is-canonical orientation (live /523 ALWAYS
  // row); proves the fix doesn't depend on which half is the "real" code.
  it('also nullifies multi-value cells where the canonical code is the second half', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = buildHtml(
        '<tr><td><span>ALWAYS</span></td>' +
          '<td>27098<br>27011</td>' +
          '<td>43189</td><td>91999</td></tr>',
      );
      const recs = parseArtistPage(html, 'https://j-pop-playlist.tistory.com/523');
      expect(recs).toHaveLength(1);
      expect(recs[0]?.karaoke_numbers.tj).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Defensive length-cap fallback: even if a future regression fuses two
  // codes without a <br> between them (no structural delimiter to split on),
  // the cap rejects the impossible 12-digit value.
  it('length-cap drops a TJ value over 6 digits and emits a console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = buildHtml('<tr><td>Title</td><td>25627123456</td><td>1</td><td>2</td></tr>');
      const recs = parseArtistPage(html, 'https://x.test/1');
      expect(recs).toHaveLength(1);
      expect(recs[0]?.karaoke_numbers.tj).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/dropping malformed TJ#/);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/exceeds digit cap 6/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Regular single-line numeric rows must continue to parse unchanged. The
  // length cap is only a sanity check, not a format validator.
  it('does not affect ordinary single-value number cells', () => {
    const html = buildHtml('<tr><td>Title</td><td>25627</td><td>41637</td><td>31783</td></tr>');
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.karaoke_numbers).toEqual({ tj: '25627', ky: '41637', joysound: '31783' });
  });

  // classifyNumberCell must treat ideographic (full-width JP) space as whitespace.
  it('classifyNumberCell treats ideographic-space-only input as null', () => {
    // Three ideographic spaces (U+3000) — common from blog editor paste.
    const html = buildHtml('<tr><td>Title</td><td>　　　</td><td>1</td><td>2</td></tr>');
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.karaoke_numbers.tj).toBeNull();
  });

  // classifyNumberCell must treat zero-width space as whitespace.
  it('classifyNumberCell treats zero-width-space-only input as null', () => {
    // Three ZWSP characters (U+200B).
    const html = buildHtml('<tr><td>Title</td><td>​​​</td><td>1</td><td>2</td></tr>');
    const recs = parseArtistPage(html, 'https://x.test/1');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.karaoke_numbers.tj).toBeNull();
  });

  // extractNumberCell must bail early (null + warn) on HTML longer than 64 KB.
  it('extractNumberCell returns null and warns when cell HTML exceeds 64KB', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Build a <td> whose innerHTML is >65536 bytes by padding with spaces.
      const padding = ' '.repeat(65537);
      const html = buildHtml(`<tr><td>Title</td><td>${padding}12345</td><td>1</td><td>2</td></tr>`);
      const recs = parseArtistPage(html, 'https://x.test/cap');
      expect(recs).toHaveLength(1);
      expect(recs[0]?.karaoke_numbers.tj).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.find((c) => String(c[0]).includes('64KB'));
      expect(warnMsg).toBeDefined();
      expect(String(warnMsg?.[0])).toMatch(/https:\/\/x\.test\/cap/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
