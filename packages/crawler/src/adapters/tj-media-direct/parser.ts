import type { RawSongRecord } from '@karaoke/schema';

/**
 * Parse a TJ Media catalog JSON response into `RawSongRecord`s.
 *
 * Endpoint contract (live-verified 2026-04-27):
 *   POST https://www.tjmedia.com/legacy/api/newSongOfMonth
 *   body: searchYm=200001 (form-urlencoded; "all songs since 2000-01")
 *   response: `{ resultCode, resultData: { itemsTotalCount, items: [...] }, GNB_MENU, resultMsg }`
 *
 * Each `items[i]` entry has the live shape:
 *   { rownumber, thumbnailImg, pro, indexTitle, indexSong,
 *     word, com, icongubun, mv_yn, publishdate }
 *
 * Field mapping:
 *   pro          -> karaoke_numbers.tj (cast to string)
 *   indexTitle   -> title_primary
 *   indexSong    -> artist_primary  (despite the field name, this is the artist)
 *   publishdate  -> release_year via the leading 4 chars of `YYYY-MM-DD`;
 *                   null if parse fails or the year is outside [1900, 2100]
 *
 * Loose-JP filter: a record is "Japanese-relevant" if its `indexTitle` or
 * `indexSong` contains at least ONE of:
 *   - a hiragana char (`/[぀-ゟ]/`)
 *   - a katakana char (`/[゠-ヿ]/`)
 *   - a CJK unified ideograph (`/[一-鿿]/`) AND the same string contains no
 *     Hangul (`/[가-힯]/`).
 *
 * Strings containing Hangul or only Latin script are NOT Japanese-relevant
 * unless they also contain hiragana or katakana. The user accepted ~5%
 * Chinese leak as the tradeoff for ~7,100 JP-relevant records vs ~4,000 with
 * a strict (hira/kata-only) filter.
 *
 * Items missing/empty `pro`, `indexTitle`, or `indexSong` are skipped.
 *
 * Throws if `json` does not have the expected response shape; the pipeline
 * aborts on this error (single request — there is no retry path).
 */
export function parseCatalogResponse(json: unknown, sourceUrl: string): RawSongRecord[] {
  const items = extractItems(json);
  const records: RawSongRecord[] = [];

  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const proRaw = item.pro;
    const title = typeof item.indexTitle === 'string' ? item.indexTitle.trim() : '';
    const artist = typeof item.indexSong === 'string' ? item.indexSong.trim() : '';

    let tj: string | null = null;
    if (typeof proRaw === 'number' && Number.isFinite(proRaw)) {
      tj = String(proRaw);
    } else if (typeof proRaw === 'string' && proRaw.trim() !== '') {
      tj = proRaw.trim();
    }

    if (!tj || !title || !artist) continue;
    if (!isJapaneseRelevant(title) && !isJapaneseRelevant(artist)) continue;

    const release_year = parseReleaseYear(item.publishdate);

    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: null,
      release_year,
      karaoke_numbers: { tj, ky: null, joysound: null },
      categories: ['jpop'],
    });
  }

  return records;
}

function extractItems(json: unknown): unknown[] {
  // Note: the live API returns `resultCode: "99"` for successful catalog
  // responses (not "00" as one might expect). We do not check `resultCode` —
  // only that `resultData.items` is an array.
  if (!isPlainObject(json)) {
    throw new Error('tj-media-direct parser: response is not a JSON object');
  }
  const data = json.resultData;
  if (!isPlainObject(data)) {
    throw new Error('tj-media-direct parser: response.resultData missing or not an object');
  }
  const items = data.items;
  if (!Array.isArray(items)) {
    throw new Error('tj-media-direct parser: response.resultData.items is not an array');
  }
  return items;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const RE_HIRAGANA = /[぀-ゟ]/;
const RE_KATAKANA = /[゠-ヿ]/;
const RE_CJK_HAN = /[一-鿿]/;
const RE_HANGUL = /[가-힯]/;

function isJapaneseRelevant(s: string): boolean {
  if (RE_HIRAGANA.test(s)) return true;
  if (RE_KATAKANA.test(s)) return true;
  if (RE_CJK_HAN.test(s) && !RE_HANGUL.test(s)) return true;
  return false;
}

function parseReleaseYear(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length < 4) return null;
  const head = raw.slice(0, 4);
  if (!/^\d{4}$/.test(head)) return null;
  const year = Number.parseInt(head, 10);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}
