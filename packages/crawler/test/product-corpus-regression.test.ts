import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(HERE, '../../../apps/web/public/data/songs.json');
const TJ_DIRECT_SOURCE = 'tjmedia.com/legacy/api/newSongOfMonth';
const RE_HANGUL = /[가-힣]/;
const RE_JAPANESE = /[぀-ヿ㐀-鿿]/;

function loadCorpus(): SongRecord[] {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as SongRecord[];
}

describe('tracked product corpus regressions', () => {
  it('does not retain TJ-direct Korean-script leakage rows in the J-pop corpus', () => {
    const leaked = loadCorpus()
      .filter((record) => record.source_url.includes(TJ_DIRECT_SOURCE))
      .filter((record) => {
        const text = `${record.title_primary} ${record.artist_primary}`;
        return RE_HANGUL.test(text) && !RE_JAPANESE.test(text);
      })
      .map((record) => ({
        id: record.id,
        title_primary: record.title_primary,
        artist_primary: record.artist_primary,
        tj: record.karaoke_numbers.tj,
      }));

    expect(leaked).toEqual([]);
  });

  it('does not contain the known Hanroro / Pororo / CUTIE STREET TJ-direct leakage examples', () => {
    const ids = new Set(loadCorpus().map((record) => record.id));

    expect(ids.has('tj-43796')).toBe(false);
    expect(ids.has('tj-98158')).toBe(false);
    // tj-70438 = "프리큐큐" / CUTIE STREET — the 2026-07-11 weekly-crawl leak:
    // a Korean-language row by a Japanese act. Dropped per-song at crawl time
    // (reviewed-song-drop) and in the corpus-cleanup path
    // (KOREAN_CATALOG_ANOMALY_IDS); the artist stays admittable for JP rows.
    expect(ids.has('tj-70438')).toBe(false);
  });
});
