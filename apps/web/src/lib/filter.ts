import type { SongRecord } from '@karaoke/schema';
import type { Vendor } from '../components/VendorChips.js';

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
