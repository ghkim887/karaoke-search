import { useRef } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { useLocale } from '../lib/locale-hooks.js';
import type { SearchVendor } from '../lib/search.js';

/**
 * Karaoke-machine vendor keys. UI-only concept (not part of `@karaoke/schema`)
 * — these select which `karaoke_numbers` field a record must have non-null on.
 * Aliases the lib-side owner {@link SearchVendor} so the two unions never drift.
 */
export type Vendor = SearchVendor;

interface VendorChipsProps {
  selected: ReadonlySet<Vendor>;
  onToggle: (vendor: Vendor) => void;
}

/**
 * Three machine-vendor toggle chips (fieldset/legend, arrow-key keyboard nav,
 * `aria-pressed`). When any chips are selected, the OR filter in
 * `filterByVendors` keeps records that have a number on AT LEAST ONE selected
 * vendor. Composes with the search query as AND in `App.tsx`.
 */
const CHIPS: ReadonlyArray<{ value: Vendor; label: string }> = [
  { value: 'tj', label: 'TJ' },
  { value: 'ky', label: 'KY' },
  { value: 'joysound', label: 'JOY' },
];

export function VendorChips({ selected, onToggle }: VendorChipsProps) {
  const locale = useLocale();
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + CHIPS.length) % CHIPS.length;
    buttonsRef.current[next]?.focus();
  };

  return (
    <fieldset class="chip-group chip-group-vendor">
      <legend class="chip-group-legend">{t(locale, 'vendorFilterLegend')}</legend>
      {CHIPS.map((chip, idx) => {
        const isSelected = selected.has(chip.value);
        return (
          <button
            key={chip.value}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            class={`chip ${isSelected ? 'chip-selected' : ''}`}
            aria-pressed={isSelected}
            onClick={() => onToggle(chip.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {chip.label}
          </button>
        );
      })}
    </fieldset>
  );
}
