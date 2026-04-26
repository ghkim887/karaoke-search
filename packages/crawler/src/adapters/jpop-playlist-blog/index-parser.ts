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
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  });
  return out;
}
