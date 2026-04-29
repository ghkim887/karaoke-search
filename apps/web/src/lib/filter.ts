import type { SongRecord } from '@karaoke/schema';
import type { CategoryFilter } from '../components/CategoryChips.js';
import type { Vendor } from '../components/VendorChips.js';

/**
 * Single-select category filter. `'all'` is a no-op (returns input unchanged).
 * Otherwise keeps records whose `categories` array contains the selected
 * category. Per the schema's mutual-exclusivity rule, `anime` and `vocaloid`
 * records are not also `jpop`, so the single-category check is unambiguous.
 *
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-design.md, UI section.
 */
export function filterByCategory(records: SongRecord[], selected: CategoryFilter): SongRecord[] {
  if (selected === 'all') return records;
  return records.filter((r) => r.categories.includes(selected));
}

/**
 * OR filter: a record passes when AT LEAST ONE selected vendor has a non-null
 * catalog number on the record. An empty `selected` set is a no-op.
 */
export function filterByVendors(
  records: SongRecord[],
  selected: ReadonlySet<Vendor>,
): SongRecord[] {
  if (selected.size === 0) return records;
  return records.filter((r) => {
    for (const v of selected) {
      if (r.karaoke_numbers[v] !== null) return true;
    }
    return false;
  });
}
