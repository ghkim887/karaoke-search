import { useRef } from 'preact/hooks';

export type TabId = 'browse' | 'favorites';

interface TabBarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  disabled: boolean;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'browse', label: '검색' },
  { id: 'favorites', label: '즐겨찾기' },
];

/**
 * Two-button tab strip for switching between Browse and Favorites views.
 * Mirrors `CategoryChips`/`VendorChips` for refs-array + arrow-key focus
 * cycling, but uses `<div role="tablist">` (not `<fieldset>`) because
 * `role="tablist"` is semantically incompatible with form-control children.
 * Active-tab click is a hard no-op at the source — parents don't dedupe.
 */
export function TabBar({ activeTab, onChange, disabled }: TabBarProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + TABS.length) % TABS.length;
    buttonsRef.current[next]?.focus();
  };

  const handleClick = (id: TabId) => {
    if (id === activeTab) return;
    onChange(id);
  };

  return (
    <div class="tab-bar" role="tablist" aria-label="결과 보기 모드">
      {TABS.map((tab, idx) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            role="tab"
            class={`tab-button ${isActive ? 'tab-button-active' : ''}`}
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => handleClick(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
