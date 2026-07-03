const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Derive the footer's DB-update date from the bundled corpus' crawl timestamps.
 *
 * Takes the `crawled_at` values (ISO-8601 UTC timestamp strings) of every record
 * in the corpus and returns the most recent one truncated to a `YYYY-MM-DD`
 * calendar date. ISO-8601 UTC strings sort lexicographically in chronological
 * order, so the maximum leading `YYYY-MM-DD` prefix is the latest date. Values
 * that are missing or not a `YYYY-MM-DD…` prefix are ignored.
 *
 * Returns '' when the corpus is empty or carries no usable timestamp; the Footer
 * then renders no date token and no leading separator.
 */
export function maxCrawledDate(crawledAts: Iterable<string | null | undefined>): string {
  let max = '';
  for (const value of crawledAts) {
    if (typeof value !== 'string') continue;
    const date = value.slice(0, 10);
    if (!ISO_DATE_PATTERN.test(date)) continue;
    if (date > max) max = date;
  }
  return max;
}
