import type { Category } from '@karaoke/schema';
import { useRef } from 'preact/hooks';

/**
 * Single-select category filter value. `'all'` means "no category filter
 * applied" — the default on first render. Owned here because both the App
 * state and `filterByCategory` consume it.
 */
export type CategoryFilter = Category | 'all';

interface CategoryChipsProps {
  selected: CategoryFilter;
  onChange: (next: CategoryFilter) => void;
}

/**
 * Single-select category radiogroup with a leading 전체 (All) chip. Clicking
 * any chip activates that one and deactivates the others. The 전체 chip is
 * active by default and means "no filter".
 *
 * Per Phase 6 plan, `proseka` is intentionally excluded from the chip set
 * even though it is a valid `Category` value.
 *
 * Accessibility: `role="radiogroup"` with each chip as `role="radio"` and
 * `aria-checked={isActive}`. Arrow-Left / Arrow-Right cycle focus among the
 * chips and select the focused chip (focus follows selection — standard
 * radiogroup keyboard model). Tab still moves focus into and out of the
 * group normally.
 */
const CHIPS: ReadonlyArray<{ value: CategoryFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'jpop', label: 'J-POP' },
  { value: 'vocaloid', label: 'Vocaloid' },
  { value: 'anime', label: 'Anime' },
];

export function CategoryChips({ selected, onChange }: CategoryChipsProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + CHIPS.length) % CHIPS.length;
    const nextChip = CHIPS[next];
    if (nextChip === undefined) return;
    const target = buttonsRef.current[next];
    if (!target) return;
    target.focus();
    // Focus follows selection in a single-select radiogroup. Skipped if the
    // focus target ref hasn't mounted, so focus and selection state never
    // diverge.
    onChange(nextChip.value);
  };

  return (
    <div class="chip-group" role="radiogroup" aria-label="카테고리 필터">
      {CHIPS.map((chip, idx) => {
        const isActive = selected === chip.value;
        return (
          <button
            key={chip.value}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: chip styling + click handler require <button>; radiogroup behavior is layered on via role + aria-checked.
            role="radio"
            class={`chip ${isActive ? 'chip-selected' : ''}`}
            aria-checked={isActive}
            // tabIndex roving (not aria-activedescendant) is simpler and correct for a small fixed chip set where every item is a real focusable button.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(chip.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
