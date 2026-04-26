import type { Category, SongRecord } from '@karaoke/schema';
import type { Vendor } from '../components/VendorChips.js';

/**
 * AND filter: a record passes only when every selected category is present in
 * its `categories` array. An empty `selected` set is a no-op (returns input).
 *
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-design.md, UI section.
 */
export function filterByCategories(
  records: SongRecord[],
  selected: ReadonlySet<Category>,
): SongRecord[] {
  if (selected.size === 0) return records;
  return records.filter((r) => {
    for (const c of selected) {
      if (!r.categories.includes(c)) return false;
    }
    return true;
  });
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
