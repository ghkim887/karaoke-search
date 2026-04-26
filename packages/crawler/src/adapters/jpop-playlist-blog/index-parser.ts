import { load } from 'cheerio';

/**
 * Extract per-artist post paths from a j-pop-playlist index page (`/98`,
 * `/417`). Returns paths matching `/^\/\d+$/` (e.g., `/449`, `/215`),
 * deduped, in first-seen order.
 *
 * Spec line 141 specified scanning relative `href` values via cheerio
 * `a[href^="/"]`. Live `/98` markup uses absolute URLs of the form
 * `https://j-pop-playlist.tistory.com/449`, so we accept either form and
 * return the path component. Deviation documented; verified against
 * `index-98.html` fixture.
 */
const RELATIVE_RE = /^\/\d+$/;
const ABSOLUTE_RE = /^https?:\/\/j-pop-playlist\.tistory\.com(\/\d+)$/;

/**
 * Matches anchor visible text that indicates a ranking / chart post rather
 * than an artist-summary post. These include periodic JOYSOUND / karaoke
 * ranking posts (e.g. "/1583 2026년 3월 일본 노래방 순위") that appear in the
 * same index pages as artist posts but contain no useful song data.
 *
 * Korean terms: 랭킹 (ranking), 순위 (rank/chart), 차트 (chart),
 *               월간 (monthly), 연간 (annual), 주간 (weekly),
 *               연말 (year-end), 연초 (new-year).
 * Latin pattern: Top N (e.g. "Top 100").
 */
const RANKING_TEXT_RE = /(랭킹|순위|차트|월간|연간|주간|연말|연초|top\s*\d+)/i;

export function parseIndexPage(html: string): string[] {
  const $ = load(html);
  const seen = new Set<string>();
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (typeof href !== 'string') return;
    let path: string | null = null;
    if (RELATIVE_RE.test(href)) {
      path = href;
    } else {
      const m = ABSOLUTE_RE.exec(href);
      if (m) path = m[1] ?? null;
    }
    if (path === null) return;
    // Skip ranking/chart posts — they share the same numeric-path shape as
    // artist posts but contain no artist song tables.
    const text = $(el).text().trim();
    if (RANKING_TEXT_RE.test(text)) return;
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  });
  return out;
}
