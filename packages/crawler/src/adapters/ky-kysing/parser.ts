import { load } from 'cheerio';
import { normalizeKyNumber } from './normalizeKyNumber.js';

/**
 * A raw KY row as parsed from the karaoke-book index (or a repaired detail row).
 * `truncated` marks that the index render cut the title and/or artist short
 * (see {@link isKyTruncated}); the crawler uses it to decide whether to attempt
 * a detail-page repair before admitting the row.
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
 * Fixed-width truncation sentinel. kysing.kr renders the karaoke-book index and
 * the `category=1` detail with a server-side field-width truncation that appends
 * a literal two-dot marker (`..`) to any title/artist it cut.
 *
 * The truncation WIDTH is deliberately NOT keyed on: measured across the live
 * `city=jp&s_value=あ&s_page=1` fixture, truncated titles span 37–53 display
 * columns (23–37 code points) and truncated artists 46 columns — there is no
 * single stable width to threshold on (the server truncates by an internal
 * byte/charset measure that does not map cleanly to display columns or code
 * points). The appended `..` is therefore the ONLY reliable signal, so we key
 * on it. A genuine title that itself ends in exactly two dots is a rare false
 * positive; it merely triggers a detail-repair fetch that conservatively drops
 * it (matching the design's "never put a truncated title in the corpus" rule),
 * so biasing toward detection here is safe.
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

/**
 * Parse the `category=1` (곡번호) detail page and return the row matching
 * `expectedKy`, or `null` when no matching row is present (0 results / number
 * mismatch — a repair failure the crawler treats as a drop).
 *
 * The detail table is `<ul class="search_chart_list">` rows; the first such
 * `<ul>` is the column HEADER (its `li.search_chart_num` reads `곡번호`, which
 * fails the digit normalization and is skipped like any non-data row). A data
 * row carries:
 *   - `li.search_chart_num` — the catalog number,
 *   - `li.search_chart_tit > span.tit` (first span) — the title,
 *   - `li.search_chart_sng` — the artist.
 *
 * We select the FIRST `span.tit` for the title: the second `span.tit` carries
 * the class `mo-art` and is a mobile-layout artist duplicate, and the
 * `li.search_chart_tit` element also wraps a lyrics popup, so reading the whole
 * cell's text would concatenate title + artist + lyrics. `search_chart_cmp`
 * (composer), `search_chart_wrt` (lyricist), and `search_chart_rel` (release
 * month) are intentionally NOT read (out of scope per the design).
 *
 * NOTE (empirical, 2026-07-16): the detail view applies the SAME width
 * truncation as the index for a given field, so it recovers a full title only
 * for rows the index truncated in one field but not the other (or borderline
 * widths); a row truncated on the detail too is reported with `truncated: true`
 * and the crawler drops it. The detail fetch still serves the design's
 * repair-or-drop contract; it just recovers fewer long titles than the source
 * survey assumed.
 */
export function parseKyDetailRow(html: string, expectedKy: string): KyRawRow | null {
  const $ = load(html);
  let match: KyRawRow | null = null;
  $('ul.search_chart_list').each((_i, ul) => {
    if (match !== null) return;
    const $ul = $(ul);
    const ky = normalizeKyNumber($ul.find('li.search_chart_num').first().text());
    if (ky === null || ky !== expectedKy) return;
    const title = $ul.find('li.search_chart_tit span.tit').first().text().trim();
    const artist = $ul.find('li.search_chart_sng').first().text().trim();
    match = { ky, title, artist, truncated: isKyTruncated(title) || isKyTruncated(artist) };
  });
  return match;
}
