import type { SongRecord } from '@karaoke/schema';

/**
 * Reverse lookup for claimed-but-unmatched vendor numbers on standalone blog
 * records (blog stable-identity design, 2026-07-14 §3).
 *
 * Computed AFTER merge: a merged record whose id still starts with `blog-` is a
 * blog row that unioned with no vendor record (a matching vendor record would
 * have won the id under `SOURCE_RANK`, graduating the cluster to `tj-*` /
 * `tjpdf-*` / `joysound-*`). Its claimed vendor numbers therefore point nowhere
 * yet:
 *
 *  - TJ  — the blog claims a TJ number no crawled TJ record carries. These feed
 *    the TJ number probe as a seed: a successful probe creates the TJ record and
 *    the next merge unions it, graduating the record to `tj-*`.
 *  - JOYSOUND — the fullCatalog enumeration is exhaustive by construction, so an
 *    unmatched claimed JOYSOUND number means a delisted song or a blog typo.
 *    Report-only (no probe).
 *  - KY — no KY source exists until R5; KY claims stay in `karaoke_numbers` and
 *    in the residual id, untouched here.
 */
export interface BlogReverseLookup {
  /** Claimed TJ numbers on standalone blog records — the TJ probe seed. */
  tjProbeSeed: string[];
  /** Claimed JOYSOUND numbers on standalone blog records — delisted/typo report. */
  joysoundDelistedReport: string[];
}

/**
 * Collect the reverse-lookup sets from a MERGED record list. Pure and
 * order-independent: numbers are de-duplicated and returned sorted. A record is
 * "standalone blog" iff its id starts with `blog-` (post-merge); anything that
 * merged with a vendor already carries a vendor id and is skipped.
 */
export function computeBlogReverseLookup(records: readonly SongRecord[]): BlogReverseLookup {
  const tj = new Set<string>();
  const joysound = new Set<string>();
  for (const r of records) {
    if (!r.id.startsWith('blog-')) continue;
    if (r.karaoke_numbers.tj !== null) tj.add(r.karaoke_numbers.tj);
    if (r.karaoke_numbers.joysound !== null) joysound.add(r.karaoke_numbers.joysound);
  }
  return {
    tjProbeSeed: [...tj].sort(),
    joysoundDelistedReport: [...joysound].sort(),
  };
}
