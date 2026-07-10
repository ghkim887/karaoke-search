import { useState } from 'preact/hooks';
import type { Vendor } from '../components/VendorChips.js';

export interface VendorFilter {
  /** Currently-selected vendors. Empty set means "no vendor filter". */
  selectedVendors: ReadonlySet<Vendor>;
  /** Toggle one vendor in/out of the selection. */
  toggleVendor: (v: Vendor) => void;
  /** Clear the selection back to empty (tab switch). */
  reset: () => void;
}

/**
 * Owns the vendor-chip filter state. The selection is an immutable `Set`
 * replaced on every toggle so downstream `useMemo` deps in the results pipeline
 * see a new reference and recompute.
 */
export function useVendorFilter(): VendorFilter {
  const [selectedVendors, setSelectedVendors] = useState<ReadonlySet<Vendor>>(() => new Set());

  const toggleVendor = (v: Vendor) => {
    setSelectedVendors((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const reset = () => setSelectedVendors(new Set());

  return { selectedVendors, toggleVendor, reset };
}
