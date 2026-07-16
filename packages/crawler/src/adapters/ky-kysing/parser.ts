import { load } from 'cheerio';
import { normalizeKyNumber } from './normalizeKyNumber.js';

/**
 * A raw KY row as parsed from the karaoke-book index. `truncated` marks that the
 * index render cut the title and/or artist short (see {@link isKyTruncated});
 * the crawler uses it to decide whether to look the row up in the curated
 * title-recovery map before admitting (else drop it as truncation-unrecovered).
 */
export interface KyRawRow {
  /** Canonical KY catalog number (bare digits). */
  ky: string;
  /** Title as rendered (may be truncated when `truncated` is true). */
  title: string;
  /** Artist as rendered (may be truncated when `truncated` is true). */
  artist: string;
  /** True when the title or artist cell was truncated by the index render. */
  truncated: boolean;
}

/**
 * Fixed-width truncation sentinel. kysing.kr renders the karaoke-book index
 * with a server-side field-width truncation that appends a literal two-dot
 * marker (`..`) to any title/artist it cut.
 *
 * The truncation WIDTH is deliberately NOT keyed on: measured across the live
 * `city=jp&s_value=あ&s_page=1` fixture, truncated titles span 37–53 display
 * columns (23–37 code points) and truncated artists 46 columns — there is no
 * single stable width to threshold on (the server truncates by an internal
 * byte/charset measure that does not map cleanly to display columns or code
 * points). The appended `..` is therefore the ONLY reliable signal, so we key
 * on it. A genuine title that itself ends in exactly two dots is a rare false
 * positive; it merely triggers a curated-recovery-map lookup that (on a miss)
 * conservatively drops the row (matching the design's "never put a truncated
 * title in the corpus" rule), so biasing toward detection here is safe.
 */
const TRUNCATION_SENTINEL = '..';

/** True when a rendered cell was truncated (ends with the `..` sentinel). */
export function isKyTruncated(text: string): boolean {
  return text.trimEnd().endsWith(TRUNCATION_SENTINEL);
}

/**
 * Parse the karaoke-book index page into raw rows.
 *
 * Each song is an `<ul class="index_search_list">` with three data cells:
 *   - `li.index_search_num` — the catalog number (never truncated),
 *   - `li.index_search_tit` — the title (may be truncated),
 *   - `li.index_search_sng` — the artist (may be truncated).
 *
 * We read the VISIBLE cell text, NOT the `title=` attribute: the attribute is
 * unreliable — on some rows the server emits an unescaped raw `"` inside it
 * (e.g. `title="* ~アスタリスク~ ("BLEACH"OP)"`), which truncates the attribute
 * at the first quote while the element's text content stays intact. A lenient
 * HTML parser (cheerio) still recovers the full text content of such a row.
 *
 * Rows whose number cell does not normalize to a bare-digit KY number are
 * skipped (defends against any non-data `index_search_list` such as a header).
 * An empty-page walk (0 rows) yields `[]`.
 */
export function parseKyIndexRows(html: string): KyRawRow[] {
  const $ = load(html);
  const rows: KyRawRow[] = [];
  $('ul.index_search_list').each((_i, ul) => {
    const $ul = $(ul);
    const ky = normalizeKyNumber($ul.find('li.index_search_num').first().text());
    if (ky === null) return; // header / non-data row — skip
    const title = $ul.find('li.index_search_tit').first().text().trim();
    const artist = $ul.find('li.index_search_sng').first().text().trim();
    rows.push({ ky, title, artist, truncated: isKyTruncated(title) || isKyTruncated(artist) });
  });
  return rows;
}
