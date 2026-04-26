import type { RawSongRecord } from '@karaoke/schema';
import { load } from 'cheerio';

/** Minimal structural shape we need from a cheerio child node. */
type CheerioNode = { type: string; name?: string };

/**
 * Header-row labels that appear in the number cells of every j-pop-playlist
 * song table. The spec claims "no thead/header row" but live fixtures
 * (`/449`, `/215`) consistently have one as the first `<tr>`. We filter rows
 * where any number cell equals these literal labels.
 *
 * Deviation from spec line 202 — documented and verified against fixtures.
 */
const HEADER_LABELS = new Set(['TJ', 'KY', 'JOYSOUND']);

/**
 * Cell text classifier for the three karaoke-number columns.
 *
 *  - Hyphen / em-dash / en-dash (alone) → null (missing).
 *  - Empty / whitespace / `&nbsp;`-only (U+00A0) → null.
 *  - Otherwise → trimmed text.
 */
function classifyNumberCell(raw: string): string | null {
  const trimmed = raw.replace(/ /g, ' ').trim();
  if (trimmed === '') return null;
  if (/^[-—–]$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Extract the title cell text by unwrapping inline `<strong>`, `<b>`, and
 * `<span>` elements before splitting on `<br>` (cheerio normalizes both
 * `<br>` and `<br/>` to the same element node).
 *
 * Returns `[title_primary, title_ko]` where `title_ko` is null when the cell
 * has only a single non-empty line.
 */
function parseTitleCell($cell: ReturnType<ReturnType<typeof load>>): [string, string | null] {
  const html = $cell.html() ?? '';
  const $c = load(`<root>${html}</root>`, null, false);
  const root = $c('root');

  // Unwrap strong / b / span in-place so their text content and any nested
  // <br> elements are preserved at the parent level.
  root.find('strong, b, span').each((_i, el) => {
    $c(el).replaceWith($c(el).contents());
  });

  // Walk child nodes, flushing a new segment at every <br>.
  const segments: string[] = [];
  let current = '';
  const flush = (): void => {
    segments.push(current);
    current = '';
  };

  for (const node of root.contents().toArray() as unknown as CheerioNode[]) {
    if (node.type === 'tag' && (node.name ?? '').toLowerCase() === 'br') {
      flush();
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: cheerio AnyNode superset
      current += $c(node as any).text();
    }
  }
  flush();

  const cleaned = segments
    .map((s) => s.replace(/ /g, ' ').trim())
    .filter((s, _i, arr) => (arr.length === 1 ? true : s !== ''));

  const titlePrimary = (cleaned[0] ?? '').trim();
  const raw2 = cleaned.length >= 2 ? (cleaned[1] ?? '').trim() : '';
  return [titlePrimary, raw2 === '' ? null : raw2];
}

/**
 * Extract the artist's primary and Korean name from the post's lead
 * blockquote. Pattern verified across `/449` (Ayase) and `/215` (RADWIMPS):
 *
 *   <blockquote><p>
 *     <span><span>{Korean}</span></span><br/>
 *     <span><span>{Latin/Japanese}</span></span>
 *   </p></blockquote>
 *
 * Two-line blockquote: first line = Korean, second = primary (Latin/Japanese).
 * Single-line blockquote: that line is the primary name, Korean = null.
 * Falls back to `[null, null]` when no blockquote is found.
 */
function parseArtistFromBlockquote(
  $body: ReturnType<ReturnType<typeof load>>,
): [string | null, string | null] {
  const $bq = $body.find('blockquote').first();
  if ($bq.length === 0) return [null, null];
  const $p = $bq.find('p').first();
  if ($p.length === 0) return [null, null];
  const [first, second] = parseTitleCell($p);
  if (!first) return [null, null];
  if (!second) return [first, null];
  return [second, first]; // second = primary (Latin/Japanese), first = Korean
}

/**
 * Parse a j-pop-playlist artist summary post into RawSongRecord rows.
 *
 * Deviations from spec (both verified against live fixtures):
 *  1. Iterates ALL `<table>` descendants of the article body (spec: "first
 *     table"). RADWIMPS `/215` splits its catalog across two tables.
 *  2. Filters header rows whose number cells equal the literal labels
 *     TJ/KY/JOYSOUND (spec claimed no such header row exists, but every
 *     live fixture has one as the first `<tr>`).
 *  3. Index pages use absolute URLs (spec implied relative paths); handled in
 *     index-parser.ts.
 */
export function parseArtistPage(html: string, sourceUrl: string): RawSongRecord[] {
  const $ = load(html);
  const $body = $('div.tt_article_useless_p_margin');
  if ($body.length === 0) {
    console.warn(`[jpop-playlist-blog] no article body found: ${sourceUrl}`);
    return [];
  }

  const [artistPrimary, artistKo] = parseArtistFromBlockquote($body);
  if (!artistPrimary) {
    console.warn(`[jpop-playlist-blog] no artist name found: ${sourceUrl}`);
    return [];
  }

  const records: RawSongRecord[] = [];

  $body.find('table').each((_ti, table) => {
    $(table)
      .find('tbody > tr')
      .each((_ri, tr) => {
        const $tds = $(tr).find('> td');
        if ($tds.length !== 4) {
          console.warn(
            `[jpop-playlist-blog] row has ${$tds.length} cells (expected 4): ${sourceUrl}`,
          );
          return;
        }

        const tj = classifyNumberCell($tds.eq(1).text());
        const ky = classifyNumberCell($tds.eq(2).text());
        const joysound = classifyNumberCell($tds.eq(3).text());

        // Skip header rows — number cells hold literal column labels.
        if (
          (tj !== null && HEADER_LABELS.has(tj)) ||
          (ky !== null && HEADER_LABELS.has(ky)) ||
          (joysound !== null && HEADER_LABELS.has(joysound))
        ) {
          return;
        }

        const [titlePrimary, titleKo] = parseTitleCell($tds.eq(0));
        if (!titlePrimary) return; // empty title row — skip silently

        records.push({
          source_url: sourceUrl,
          title_primary: titlePrimary,
          title_ko: titleKo,
          artist_primary: artistPrimary,
          artist_ko: artistKo,
          release_year: null,
          karaoke_numbers: { tj, ky, joysound },
          categories: [],
        });
      });
  });

  return records;
}
