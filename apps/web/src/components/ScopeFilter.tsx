import { useRef } from 'preact/hooks';

export type Scope = 'all' | 'title' | 'artist';

interface ScopeFilterProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
  disabled: boolean;
}

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'title', label: '곡명' },
  { id: 'artist', label: '가수' },
];

/**
 * Three-button segmented-control for restricting which fields the search query
 * is matched against. Single-select. Default `'all'` (= current 4-field
 * behavior). Mirrors `TabBar` for refs-array + arrow-key focus cycling, but
 * uses the WAI-ARIA radio-group pattern (single-select, manual activation):
 *
 *   - Container: `role="radiogroup" aria-label="검색 범위"`.
 *   - Each button: `role="radio"` + `aria-checked={isActive}`.
 *   - `tabIndex={0}` on the active button, `-1` on the others — the group is
 *     a single tab stop; arrow keys cycle within.
 *   - Arrow keys move focus only; Enter/Space (default button activation)
 *     commit the choice. No auto-activation on arrow.
 *   - Active-click is a hard no-op at the source.
 */
export function ScopeFilter({ scope, onChange, disabled }: ScopeFilterProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + SCOPES.length) % SCOPES.length;
    buttonsRef.current[next]?.focus();
  };

  const handleClick = (id: Scope) => {
    if (id === scope) return;
    onChange(id);
  };

  return (
    <div class="scope-filter" role="radiogroup" aria-label="검색 범위">
      {SCOPES.map((opt, idx) => {
        const isActive = scope === opt.id;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: segmented-control radio pattern uses <button role="radio"> per WAI-ARIA radiogroup; native <input type="radio"> would force a different visual + keyboard treatment.
            role="radio"
            class={`scope-button ${isActive ? 'scope-button-active' : ''}`}
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={disabled}
            onClick={() => handleClick(opt.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
