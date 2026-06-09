import { beforeAll, describe, expect, it } from 'vitest';
import {
  admitRowToListItem,
  buildJoysoundRecord,
  classifyMutation,
  loadNormalizer,
  looseSameSong,
  normalizeForConflictMatch,
  resolveExistingNumberConflicts,
  stableStringify,
} from './build-joysound-candidate.mjs';

const CRAWLED_AT = '2026-06-09T00:00:00.000Z';

// buildJoysoundRecord delegates to the built crawler normalizer; bind it once.
beforeAll(async () => {
  await loadNormalizer();
});

function blogRecord(overrides = {}) {
  return {
    id: 'blog-1',
    source_url: 'https://example.test/blog/1',
    title_primary: 'さよなら',
    title_ko: '안녕',
    artist_primary: '米津玄師',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('build-joysound-candidate transforms', () => {
  // (a) decision-admit row -> correct SongRecord shape + schema-valid.
  it('maps a decision-admit row to a schema-valid JOYSOUND SongRecord with the exact normalizer shape', () => {
    const entry = {
      selSongNo: '640256',
      selSongNoRaw: '640256',
      naviGroupId: '1122881',
      title: 'IRIS OUT',
      artist: '米津玄師',
      tieupInfo: null,
      decision: 'admit',
      category: 'jpop',
      reason: 'admit-jp-artist',
    };

    const listItem = admitRowToListItem(entry);
    expect(listItem).toEqual({
      naviGroupId: '1122881',
      selSongNo: '640256',
      songName: 'IRIS OUT',
      artistName: '米津玄師',
      artistId: null,
      tieupInfo: null,
      tieupId: null,
    });

    const record = buildJoysoundRecord(entry, CRAWLED_AT);
    expect(record).toEqual({
      id: 'joysound-1122881',
      source_url: 'https://www.joysound.com/web/search/song/1122881',
      title_primary: 'IRIS OUT',
      title_ko: null,
      artist_primary: '米津玄師',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '640256' },
      categories: ['jpop'],
      crawled_at: CRAWLED_AT,
    });
  });

  it('strips hyphens from selSongNoRaw via the normalizer when the dashless number is unavailable', () => {
    const entry = {
      selSongNoRaw: '190-001',
      naviGroupId: '900000',
      title: 'テスト',
      artist: 'アーティスト',
      tieupInfo: null,
      decision: 'admit',
      category: 'anime',
    };
    const record = buildJoysoundRecord(entry, CRAWLED_AT);
    expect(record.karaoke_numbers.joysound).toBe('190001');
    expect(record.categories).toEqual(['anime']);
  });

  // (b) conflict number -> blog record's joysound nulled; benign overlap left intact.
  it('nulls a blog record joysound number on a different-song conflict and leaves benign overlaps intact', () => {
    const conflictBlog = blogRecord({
      id: 'blog-conflict',
      title_primary: '全く違う曲',
      artist_primary: '別のアーティスト',
      karaoke_numbers: { tj: null, ky: null, joysound: '555555' },
    });
    const benignBlog = blogRecord({
      id: 'blog-benign',
      title_primary: 'さよなら',
      artist_primary: '米津玄師',
      karaoke_numbers: { tj: null, ky: null, joysound: '777777' },
    });
    const untouchedBlog = blogRecord({
      id: 'blog-untouched',
      title_primary: '無関係',
      artist_primary: '誰か',
      karaoke_numbers: { tj: null, ky: null, joysound: '999999' },
    });

    const admits = [
      // Different song on the same number -> conflict -> null the blog number.
      {
        selSongNo: '555555',
        naviGroupId: 'n1',
        title: '米津玄師の新曲',
        artist: '米津玄師',
        decision: 'admit',
        category: 'jpop',
      },
      // Same song, same number -> benign overlap -> leave the blog number alone.
      {
        selSongNo: '777777',
        naviGroupId: 'n2',
        title: 'さよなら',
        artist: '米津玄師',
        decision: 'admit',
        category: 'jpop',
      },
    ];

    const { records, conflictsResolved, benignOverlaps } = resolveExistingNumberConflicts(
      [conflictBlog, benignBlog, untouchedBlog],
      admits,
    );

    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get('blog-conflict').karaoke_numbers.joysound).toBe(null);
    expect(byId.get('blog-benign').karaoke_numbers.joysound).toBe('777777');
    expect(byId.get('blog-untouched').karaoke_numbers.joysound).toBe('999999');
    expect(conflictsResolved).toBe(1);
    expect(benignOverlaps).toBe(1);
  });

  it('treats NFKC-equivalent / whitespace / case differences as the same song (benign)', () => {
    const blog = blogRecord({
      id: 'blog-nfkc',
      title_primary: 'ＡＢＣ',
      artist_primary: 'Artist  Name',
      karaoke_numbers: { tj: null, ky: null, joysound: '111111' },
    });
    const admits = [
      {
        selSongNo: '111111',
        naviGroupId: 'n3',
        title: 'abc',
        artist: 'artist name',
        decision: 'admit',
        category: 'jpop',
      },
    ];
    const { records, conflictsResolved, benignOverlaps } = resolveExistingNumberConflicts(
      [blog],
      admits,
    );
    expect(records[0].karaoke_numbers.joysound).toBe('111111');
    expect(conflictsResolved).toBe(0);
    expect(benignOverlaps).toBe(1);
  });

  it('normalizeForConflictMatch matches the audit comparator semantics', () => {
    expect(normalizeForConflictMatch('ＡＢＣ')).toBe(normalizeForConflictMatch('abc'));
    expect(normalizeForConflictMatch('  a  b ')).toBe('a b');
  });
});

describe('mutation classification', () => {
  function rec(overrides = {}) {
    return {
      id: 'blog-1-0',
      source_url: 'u',
      title_primary: 'X',
      title_ko: null,
      artist_primary: 'A',
      artist_ko: null,
      karaoke_numbers: { tj: '100', ky: null, joysound: '200' },
      categories: ['jpop'],
      crawled_at: '2026-05-30T00:00:00.000Z',
      ...overrides,
    };
  }

  // Regression: stableStringify must see NESTED karaoke_numbers changes. The
  // prior `JSON.stringify(r, Object.keys(r).sort())` used the replacer arg as a
  // top-level allowlist, recursively stripping karaoke_numbers' tj/ky/joysound
  // keys -> nested number changes were invisible. This pins the deep behavior.
  it('stableStringify reflects nested karaoke_numbers changes', () => {
    const a = rec();
    const b = rec({ karaoke_numbers: { tj: '100', ky: null, joysound: null } });
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it('stableStringify is key-order independent', () => {
    const a = { x: 1, y: 2, karaoke_numbers: { tj: '1', ky: '2', joysound: '3' } };
    const b = { karaoke_numbers: { joysound: '3', ky: '2', tj: '1' }, y: 2, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('classifies a conflict joysound null-out as expected (conflict-joysound-null)', () => {
    const before = rec();
    const after = rec({ karaoke_numbers: { tj: '100', ky: null, joysound: null } });
    const { expected, reasons, badReasons } = classifyMutation(before, after);
    expect(expected).toBe(true);
    expect(reasons).toContain('conflict-joysound-null');
    expect(badReasons).toEqual([]);
  });

  it('classifies a crawled_at refresh + number add as expected', () => {
    const before = rec({ karaoke_numbers: { tj: '100', ky: null, joysound: null } });
    const after = rec({
      karaoke_numbers: { tj: '100', ky: null, joysound: '999' },
      crawled_at: '2026-06-09T00:00:00.000Z',
    });
    const { expected, reasons } = classifyMutation(before, after);
    expect(expected).toBe(true);
    expect(reasons.sort()).toEqual(['crawled_at-refresh', 'karaoke-number-added']);
  });

  it('classifies a joysound value->value swap as expected (same-song number correction)', () => {
    const before = rec();
    const after = rec({ karaoke_numbers: { tj: '100', ky: null, joysound: '300' } });
    const { expected, reasons } = classifyMutation(before, after);
    expect(expected).toBe(true);
    expect(reasons).toContain('joysound-number-swap');
  });

  it('flags a tj number swap as UNEXPECTED corruption', () => {
    const before = rec();
    const after = rec({ karaoke_numbers: { tj: '777', ky: null, joysound: '200' } });
    const { expected, badReasons } = classifyMutation(before, after);
    expect(expected).toBe(false);
    expect(badReasons).toContain('karaoke-number-corrupted:tj');
  });

  it('flags a title_primary rewrite as UNEXPECTED corruption', () => {
    const before = rec();
    const after = rec({ title_primary: 'DIFFERENT' });
    const { expected, badReasons } = classifyMutation(before, after);
    expect(expected).toBe(false);
    expect(badReasons).toContain('text-field-changed:title_primary');
  });

  it('flags a dropped artist alias as UNEXPECTED corruption', () => {
    const before = rec({ artist_aliases: ['Spitz'] });
    const after = rec({ artist_aliases: [] });
    const { expected, badReasons } = classifyMutation(before, after);
    expect(expected).toBe(false);
    expect(badReasons).toContain('artist-aliases-dropped');
  });
});

describe('looseSameSong (conflict-nulling guard)', () => {
  // Same-song variant classes that strict NFKC does NOT fold — these MUST be
  // treated as the same song so their blog joysound number is NOT nulled (and
  // Tier-A unions the pair). The 旧字/新字 + prolonged-mark cases are the
  // regression that was previously mis-nulled.
  it('folds 旧字体↔新字体 kanji variants', () => {
    expect(looseSameSong('眞夜中は純潔', '椎名林檎', '真夜中は純潔', '椎名林檎')).toBe(true);
    expect(looseSameSong('初戀', 'X', '初恋', 'X')).toBe(true);
    expect(looseSameSong('氣持ち', 'X', '気持ち', 'X')).toBe(true);
  });

  it('folds prolonged-mark / dash codepoint variants (U+FF0D vs U+30FC)', () => {
    expect(looseSameSong('スパイダ－', 'スピッツ', 'スパイダー', 'スピッツ')).toBe(true);
  });

  it('folds trailing subtitle / media-context parentheticals', () => {
    expect(looseSameSong('Longing', 'X', 'Longing ～跡切れたmelody～', 'X')).toBe(true);
    expect(looseSameSong('サクラサク', 'X', 'サクラサク(ラブひな OP)', 'X')).toBe(true);
    expect(looseSameSong('サクラサク', 'X', 'サクラサク（ラブひな OP）', 'X')).toBe(true);
  });

  it('folds artist parenthetical / dash rendering variants', () => {
    expect(looseSameSong('紅', 'X-JAPAN', '紅', 'X JAPAN(X)')).toBe(true);
  });

  it('returns FALSE for genuinely different songs sharing a number', () => {
    expect(looseSameSong('完全に別の曲', 'アーティストA', 'まったく違う歌', 'アーティストB')).toBe(
      false,
    );
  });

  it('returns FALSE when titles match but artists are genuinely different', () => {
    expect(looseSameSong('愛', 'BTS', '愛', '米津玄師')).toBe(false);
  });
});

describe('conservative conflict nulling', () => {
  function blogRec(overrides = {}) {
    return {
      id: 'blog-1-0',
      source_url: 'u',
      title_primary: '真夜中は純潔',
      title_ko: null,
      artist_primary: '椎名林檎',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '26766' },
      categories: ['jpop'],
      crawled_at: '2026-05-30T00:00:00.000Z',
      ...overrides,
    };
  }

  it('does NOT null a same-song 旧字/新字 variant (left benign for Tier-A union)', () => {
    const blog = blogRec(); // 真夜中は純潔 / 椎名林檎, joysound 26766
    const admits = [
      // admit renders the title in 旧字体 — same song, must NOT null.
      { selSongNo: '26766', naviGroupId: 'n1', title: '眞夜中は純潔', artist: '椎名林檎' },
    ];
    const { records, conflictsResolved, benignOverlaps } = resolveExistingNumberConflicts(
      [blog],
      admits,
    );
    expect(records[0].karaoke_numbers.joysound).toBe('26766');
    expect(conflictsResolved).toBe(0);
    expect(benignOverlaps).toBe(1);
  });

  it('does NOT null a same-song prolonged-mark variant', () => {
    const blog = blogRec({
      title_primary: 'スパイダ－',
      artist_primary: 'スピッツ',
      karaoke_numbers: { tj: null, ky: null, joysound: '12591' },
    });
    const admits = [
      { selSongNo: '12591', naviGroupId: 'n2', title: 'スパイダー', artist: 'スピッツ' },
    ];
    const { records, conflictsResolved } = resolveExistingNumberConflicts([blog], admits);
    expect(records[0].karaoke_numbers.joysound).toBe('12591');
    expect(conflictsResolved).toBe(0);
  });

  it('DOES null a confidently-different song sharing a number', () => {
    const blog = blogRec({
      title_primary: '完全に別の曲',
      artist_primary: 'アーティストA',
      karaoke_numbers: { tj: null, ky: null, joysound: '55555' },
    });
    const admits = [
      { selSongNo: '55555', naviGroupId: 'n3', title: 'まったく違う歌', artist: 'アーティストB' },
    ];
    const { records, conflictsResolved } = resolveExistingNumberConflicts([blog], admits);
    expect(records[0].karaoke_numbers.joysound).toBe(null);
    expect(conflictsResolved).toBe(1);
  });
});
