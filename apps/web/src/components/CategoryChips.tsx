import type { Category } from '@karaoke/schema';
import { useRef } from 'preact/hooks';

interface CategoryChipsProps {
  selected: ReadonlySet<Category>;
  onToggle: (category: Category) => void;
}

/**
 * Three category toggle chips. Per Phase 6 plan, `proseka` is intentionally
 * excluded from the chip set even though it is a valid `Category` value.
 *
 * Keyboard model (Phase 9): Arrow-Left / Arrow-Right cycle focus among the
 * chips without escaping the group. Tab still moves focus into and out of the
 * group normally.
 */
const CHIPS: ReadonlyArray<{ value: Category; label: string }> = [
  { value: 'jpop', label: 'J-POP' },
  { value: 'vocaloid', label: 'Vocaloid' },
  { value: 'anime', label: 'Anime' },
];

export function CategoryChips({ selected, onToggle }: CategoryChipsProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + CHIPS.length) % CHIPS.length;
    buttonsRef.current[next]?.focus();
  };

  return (
    <fieldset class="chip-group">
      <legend class="chip-group-legend">카테고리 필터</legend>
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
