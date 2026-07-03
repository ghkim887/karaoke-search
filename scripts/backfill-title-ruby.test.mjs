import { describe, expect, it } from 'vitest';
import { backfillCorpus, buildRubyMap } from './backfill-title-ruby.mjs';

function song(overrides = {}) {
  return {
    id: 'joysound-1',
    source_url: 'https://www.joysound.com/web/search/song/1',
    title_primary: '○',
    title_ko: null,
    artist_primary: 'いきものがかり',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '622657' },
    crawled_at: '2026-06-12T15:53:24.989Z',
    ...overrides,
  };
}

function logRow(overrides = {}) {
  return {
    selSongNo: '622657',
    decision: 'admit',
    songName: '○',
    songNameRuby: 'マル',
    ...overrides,
  };
}

describe('buildRubyMap', () => {
  it('indexes rows by trimmed selSongNo', () => {
    const { map } = buildRubyMap([
      logRow(),
      logRow({ selSongNo: ' 100 ', songNameRuby: 'テスト' }),
    ]);
    expect(map.get('622657')).toEqual({ songName: '○', ruby: 'マル' });
    expect(map.get('100')).toEqual({ songName: '○', ruby: 'テスト' });
  });

  it('skips rows with an empty selSongNo', () => {
    const { map } = buildRubyMap([logRow({ selSongNo: '' }), logRow({ selSongNo: null })]);
    expect(map.size).toBe(0);
  });

  it('keeps the first of duplicate selSongNo and counts conflicts on differing ruby', () => {
    const { map, duplicateRows, duplicateConflicts } = buildRubyMap([
      logRow({ songNameRuby: 'マル' }),
      logRow({ songNameRuby: 'マル' }), // duplicate, same ruby → no conflict
      logRow({ songNameRuby: 'チガウ' }), // duplicate, different ruby → conflict
    ]);
    expect(map.get('622657').ruby).toBe('マル'); // first wins
    expect(duplicateRows).toBe(2);
    expect(duplicateConflicts).toBe(1);
  });
});

describe('backfillCorpus — matching buckets', () => {
  it('applies on exact songName match and appends title_ruby LAST', () => {
    const records = [song()];
    const { map } = buildRubyMap([logRow()]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0].title_ruby).toBe('マル');
    expect(Object.keys(out[0]).at(-1)).toBe('title_ruby');
    expect(report.buckets.applied_exact).toBe(1);
    expect(report.appliedTotal).toBe(1);
    expect(report.joysoundNumberedSongs).toBe(1);
    // Every pre-existing field is untouched.
    expect({ ...out[0], title_ruby: undefined }).toMatchObject(records[0]);
  });

  it('applies via NFKC fallback and counts it in the nfkc bucket', () => {
    // Half-width vs full-width katakana render the same after NFKC.
    const records = [song({ title_primary: 'ﾏﾙ' })];
    const { map } = buildRubyMap([logRow({ songName: 'マル', songNameRuby: 'マル' })]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0].title_ruby).toBe('マル');
    expect(report.buckets.applied_nfkc).toBe(1);
    expect(report.buckets.applied_exact).toBe(0);
  });

  it('keeps a ruby identical to the title', () => {
    const records = [song({ title_primary: 'レモン' })];
    const { map } = buildRubyMap([logRow({ songName: 'レモン', songNameRuby: 'レモン' })]);
    const { records: out } = backfillCorpus(records, map);
    expect(out[0].title_ruby).toBe('レモン');
  });

  it('skips songs without a joysound number', () => {
    const records = [song({ karaoke_numbers: { tj: '1', ky: null, joysound: null } })];
    const { map } = buildRubyMap([logRow()]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0]).not.toHaveProperty('title_ruby');
    expect(report.buckets.skip_no_joysound_number).toBe(1);
    expect(report.joysoundNumberedSongs).toBe(0);
  });

  it('skips when no ruby record matches the joysound number', () => {
    const records = [song({ karaoke_numbers: { tj: null, ky: null, joysound: '999999' } })];
    const { map } = buildRubyMap([logRow()]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0]).not.toHaveProperty('title_ruby');
    expect(report.buckets.skip_no_ruby_record).toBe(1);
  });

  it('skips when the ruby record has an empty reading', () => {
    const records = [song()];
    const { map } = buildRubyMap([logRow({ songNameRuby: '' })]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0]).not.toHaveProperty('title_ruby');
    expect(report.buckets.skip_empty_ruby).toBe(1);
  });

  it('skips (never rewrites) when songName no longer matches the title', () => {
    const records = [song({ title_primary: '新しいタイトル' })];
    const { map } = buildRubyMap([logRow({ songName: '古いタイトル' })]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0]).not.toHaveProperty('title_ruby');
    expect(report.buckets.skip_title_mismatch).toBe(1);
  });

  it('is a no-op when the song already has the identical ruby', () => {
    const records = [song({ title_ruby: 'マル' })];
    const { map } = buildRubyMap([logRow()]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0].title_ruby).toBe('マル');
    expect(report.buckets.noop_already_present_identical).toBe(1);
    expect(report.appliedTotal).toBe(0);
  });

  it('skips and preserves an existing conflicting ruby', () => {
    const records = [song({ title_ruby: 'チガウ' })];
    const { map } = buildRubyMap([logRow({ songNameRuby: 'マル' })]);
    const { records: out, report } = backfillCorpus(records, map);
    expect(out[0].title_ruby).toBe('チガウ'); // untouched
    expect(report.buckets.skip_already_present_conflict).toBe(1);
  });

  it('buckets partition the corpus (sum === size)', () => {
    const records = [
      song({ id: 'joysound-1', karaoke_numbers: { tj: null, ky: null, joysound: '622657' } }),
      song({ id: 'joysound-2', karaoke_numbers: { tj: null, ky: null, joysound: '999999' } }),
      song({ id: 'tj-3', karaoke_numbers: { tj: '3', ky: null, joysound: null } }),
      song({
        id: 'joysound-4',
        title_primary: 'x',
        karaoke_numbers: { tj: null, ky: null, joysound: '5' },
      }),
    ];
    const { map } = buildRubyMap([
      logRow(),
      logRow({ selSongNo: '5', songName: 'y', songNameRuby: 'z' }),
    ]);
    const { report } = backfillCorpus(records, map);
    const sum = Object.values(report.buckets).reduce((a, b) => a + b, 0);
    expect(sum).toBe(records.length);
    expect(report.totalSongs).toBe(4);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const records = [song()];
    const { map } = buildRubyMap([logRow()]);
    const first = backfillCorpus(records, map);
    const second = backfillCorpus(first.records, map);
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
    expect(second.report.buckets.noop_already_present_identical).toBe(1);
    expect(second.report.appliedTotal).toBe(0);
  });
});
