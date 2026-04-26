import type { Category } from '@karaoke/schema';

interface CategoryChipsProps {
  selected: ReadonlySet<Category>;
  onToggle: (category: Category) => void;
}

/**
 * Three category toggle chips. Per Phase 6 plan, `proseka` is intentionally
 * excluded from the chip set even though it is a valid `Category` value.
 */
const CHIPS: ReadonlyArray<{ value: Category; label: string }> = [
  { value: 'jpop', label: 'J-POP' },
  { value: 'vocaloid', label: 'Vocaloid' },
  { value: 'anime', label: 'Anime' },
];

export function CategoryChips({ selected, onToggle }: CategoryChipsProps) {
  return (
    <fieldset class="chip-group">
      <legend class="chip-group-legend">카테고리 필터</legend>
      {CHIPS.map((chip) => {
        const isSelected = selected.has(chip.value);
        return (
          <button
            key={chip.value}
            type="button"
            class={`chip ${isSelected ? 'chip-selected' : ''}`}
            aria-pressed={isSelected}
            onClick={() => onToggle(chip.value)}
          >
            {chip.label}
          </button>
        );
      })}
    </fieldset>
  );
}
