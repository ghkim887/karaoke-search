import type { RawSongRecord } from '@karaoke/schema';
import { load } from 'cheerio';

/**
 * Parse a TJ Media accompaniment-search results page into `RawSongRecord`s.
 *
 * Selectors are pinned per the v2 spec ("Source: TJ Media direct" / "HTML
 * structure" table). Verified against the captured fixture
 * `test/fixtures/tj-media-direct/jpop-page-1.html` (sha256
 * `d48f53d7…`).
 *
 *  - Row container: `ul.chart-list-area li ul.grid-container.list`. Pinning
 *    on `.list` automatically excludes the header row whose container is
 *    `<ul class="grid-container top music">`.
 *  - TJ#: `.grid-item.center.pos-type span.num2` text.
 *  - Title: `.grid-item.title3 .flex-box p span` text.
 *  - Artist: `.grid-item.title4.singer p span span.highlight` if present
 *    (TJ's search-match wrapper is conditional on the artist field matching
 *    the query); fall back to `.grid-item.title4.singer p span` otherwise.
 *
 * Rows missing TJ#, title, or artist are skipped (they would fail downstream
 * schema validation). Empty pages — i.e. when TJ returns
 * "검색 결과를 찾을 수 없습니다" — produce an empty array, not an error.
 *
 * Categorization is uniform `["jpop"]` for every row at the parser level;
 * the normalizer preserves that. NamuWiki Tier A merges supply
 * `[anime]` / `[vocaloid]` later in the pipeline.
 */
export function parseListingPage(html: string, sourceUrl: string): RawSongRecord[] {
  const $ = load(html);
  const records: RawSongRecord[] = [];

  $('ul.chart-list-area li ul.grid-container.list').each((_i, row) => {
    const $row = $(row);
    const tj = $row.find('.grid-item.center.pos-type span.num2').first().text().trim();
    const title = $row.find('.grid-item.title3 .flex-box p span').first().text().trim();
    const $artistCell = $row.find('.grid-item.title4.singer p span').first();
    const $highlight = $artistCell.find('span.highlight').first();
    const artist = ($highlight.length > 0 ? $highlight.text() : $artistCell.text()).trim();

    if (!tj || !title || !artist) return;

    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: null,
      release_year: null,
      karaoke_numbers: { tj, ky: null, joysound: null },
      categories: ['jpop'],
    });
  });

  return records;
}
