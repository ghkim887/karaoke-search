import type { Category } from '@karaoke/schema';

/**
 * Priority order for category mutual-exclusivity. First entry wins.
 *
 * Exported so that `scripts/export-category-priority.mjs` can write a JSON
 * sidecar consumed by Python scripts (same mechanical-sync pattern as
 * `SPLIT_RE_SOURCE` / `clustering-rules.json`). The Python side reads this
 * sidecar at import time and falls back to a hardcoded copy if the sidecar is
 * absent (partial-build graceful degradation).
 */
export const CATEGORY_PRIORITY: readonly Category[] = ['vocaloid', 'anime', 'jpop'];

/**
 * Category mutual-exclusivity rule (priority: vocaloid > anime > jpop).
 *
 * After this rule is applied, every record has AT MOST one of
 * `{jpop, vocaloid, anime}`. The priority encodes specificity: PDF section
 * signal (vocaloid) is the most specific, blog index keyword (anime) is next,
 * and jpop is the catch-all. Mutates `cats` in-place.
 *
 *   ['jpop']                       -> ['jpop']      (unchanged)
 *   ['jpop', 'anime']              -> ['anime']
 *   ['jpop', 'vocaloid']           -> ['vocaloid']
 *   ['anime', 'vocaloid']          -> ['vocaloid']  (vocaloid wins)
 *   ['jpop', 'anime', 'vocaloid']  -> ['vocaloid']
 *
 * Defense-in-depth alongside the JSON Schema's `categories` constraint, which
 * also rejects any combination of two-or-more values from the live enum.
 */
export function applyCategoryExclusivity(cats: Set<Category>): void {
  // Iterate CATEGORY_PRIORITY in order; the first match wins and all lower-
  // priority categories are removed. This keeps the logic data-driven so a
  // change to CATEGORY_PRIORITY automatically propagates here.
  for (const winner of CATEGORY_PRIORITY) {
    if (cats.has(winner)) {
      for (const cat of CATEGORY_PRIORITY) {
        if (cat !== winner) cats.delete(cat);
      }
      return;
    }
  }
  // No category matched (empty set or unknown values) — leave cats unchanged.
}
