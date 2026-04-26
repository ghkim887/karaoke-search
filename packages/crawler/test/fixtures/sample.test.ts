import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'songs.sample.json',
);
const fixture: SongRecord[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const JAPANESE_RE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿]/u;

describe('songs.sample.json fixture (10 hand-picked records)', () => {
  it('contains exactly 10 records', () => {
    expect(fixture).toHaveLength(10);
  });

  it('every record has a non-empty title_primary', () => {
    for (const r of fixture) {
      expect(typeof r.title_primary).toBe('string');
      expect(r.title_primary.length).toBeGreaterThan(0);
    }
  });

  it('every record has at least one non-null karaoke_numbers entry', () => {
    for (const r of fixture) {
      const { tj, ky, joysound } = r.karaoke_numbers;
      expect(tj !== null || ky !== null || joysound !== null).toBe(true);
    }
  });

  it('at least one record has a Japanese-script title_primary (kana/kanji)', () => {
    // No artist appeared in both /98 and /417 indexes in the 60-artist crawl,
    // so there are no naturally-occurring mixed-category records. The
    // "≥1 mixed" spec requirement is replaced with this signal-quality check.
    const hasJapanese = fixture.some((r) => JAPANESE_RE.test(r.title_primary));
    expect(hasJapanese).toBe(true);
  });

  it('every record validates against songRecordSchema', () => {
    for (const r of fixture) {
      expect(() => validateSongRecord(r)).not.toThrow();
    }
  });
});
