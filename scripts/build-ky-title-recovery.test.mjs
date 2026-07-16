import { describe, expect, it } from 'vitest';
import {
  MANUAL_ENTRIES,
  buildRecoveryMap,
  parseAnisongBook,
  parseArgs,
} from './build-ky-title-recovery.mjs';

// A tiny, hand-built anisong-book fragment exercising the three row shapes:
// a clean row, an empty-artist row (Korean-dub, skipped), and an entity-encoded
// title that must be decoded.
const SAMPLE_HTML = `<!doctype html><html><body>
<article class="song-card" data-search="x 76519 Burning 버닝 羊文学 히츠지분가쿠">
<div class="song-no">76519</div>
<div class="song-title-block"><div class="song-title">Burning</div><div class="song-reading">버닝</div></div>
<div class="song-artist-block"><div class="artist-name">羊文学</div><div class="artist-reading">히츠지분가쿠</div></div>
</article>
<article class="song-card" data-search="x 60116 골드런">
<div class="song-no">60116</div>
<div class="song-title-block"><div class="song-title">골드런</div></div>
<div class="song-artist-block"><div class="artist-name"></div></div>
</article>
<article class="song-card" data-search="x 12345">
<div class="song-no">12345</div>
<div class="song-title-block"><div class="song-title">A &amp; B (&quot;OVA&quot;)</div></div>
<div class="song-artist-block"><div class="artist-name">Foo &amp; Bar</div></div>
</article>
</body></html>`;

describe('parseAnisongBook', () => {
  it('extracts clean rows and decodes HTML entities', () => {
    const parsed = parseAnisongBook(SAMPLE_HTML);
    expect(parsed['76519']).toEqual({
      title: 'Burning',
      artist: '羊文学',
      source: 'anisong-book-42',
    });
    expect(parsed['12345']).toEqual({
      title: 'A & B ("OVA")',
      artist: 'Foo & Bar',
      source: 'anisong-book-42',
    });
  });

  it('skips a card with an empty artist-name (Korean-dub entry, kr-tab noise)', () => {
    const warnings = [];
    const parsed = parseAnisongBook(SAMPLE_HTML, (m) => warnings.push(m));
    expect(parsed['60116']).toBeUndefined();
    expect(warnings.some((w) => w.includes('60116') && /artist/.test(w))).toBe(true);
  });

  it('skips a truncated title (trailing ..)', () => {
    const html = `<article class="song-card"><div class="song-no">99</div>
<div class="song-title-block"><div class="song-title">Long title cut here..</div></div>
<div class="song-artist-block"><div class="artist-name">Someone</div></div></article>`;
    const warnings = [];
    const parsed = parseAnisongBook(html, (m) => warnings.push(m));
    expect(parsed['99']).toBeUndefined();
    expect(warnings.some((w) => w.includes('99') && /title/.test(w))).toBe(true);
  });
});

describe('buildRecoveryMap', () => {
  it('merges manual entries and sorts keys numerically', () => {
    const parsed = { 900: { title: 'Z', artist: 'A', source: 'anisong-book-42' } };
    const map = buildRecoveryMap(parsed);
    // Manual ky 44092 present, and keys sorted numerically (900 before 44092).
    expect(map['44092']).toEqual(MANUAL_ENTRIES['44092']);
    expect(Object.keys(map)).toEqual(['900', '44092']);
  });

  it('manual entry wins over a colliding parsed entry', () => {
    const parsed = { 44092: { title: 'wrong', artist: 'wrong', source: 'anisong-book-42' } };
    const map = buildRecoveryMap(parsed);
    expect(map['44092']).toEqual(MANUAL_ENTRIES['44092']);
  });
});

describe('parseArgs', () => {
  it('parses --html and --out', () => {
    expect(parseArgs(['--html', 'a.html', '--out', 'b.json'])).toEqual({
      htmlPath: 'a.html',
      outPath: 'b.json',
      help: false,
    });
  });
  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});
