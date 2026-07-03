import { useRef } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { useLocale } from '../lib/locale-hooks.js';

export type TabId = 'browse' | 'favorites';

interface TabBarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  disabled: boolean;
}

// `labelKey` is narrowed to the two static tab keys (not the full MessageKey
// union) so `t()` sees a param-less key and needs no interpolation arguments.
const TABS: ReadonlyArray<{ id: TabId; labelKey: 'tabBrowse' | 'tabFavorites' }> = [
  { id: 'browse', labelKey: 'tabBrowse' },
  { id: 'favorites', labelKey: 'tabFavorites' },
];

/** DOM id of the single results panel these tabs control (see `App.tsx`). */
export const TAB_PANEL_ID = 'results-tabpanel';

/** Stable DOM id for a tab button, so the panel can point back at the active
 *  tab via `aria-labelledby`. */
export function tabButtonId(id: TabId): string {
  return `tab-${id}`;
}

/**
 * Two-button tab strip for switching between Browse and Favorites views.
 * Mirrors `VendorChips` for refs-array + arrow-key focus cycling, but uses
 * `<div role="tablist">` (not `<fieldset>`) because
 * `role="tablist"` is semantically incompatible with form-control children.
 * Active-tab click is a hard no-op at the source — parents don't dedupe.
 *
 * Implements the WAI-ARIA tabs pattern: roving tabindex (only the active tab
 * is in the Tab order; ArrowLeft/ArrowRight move focus between tabs), and each
 * tab wires `aria-controls` to the shared results panel (`TAB_PANEL_ID`).
 */
export function TabBar({ activeTab, onChange, disabled }: TabBarProps) {
  const locale = useLocale();
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
    <div class="tab-bar" role="tablist" aria-label={t(locale, 'viewModeLabel')}>
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
            id={tabButtonId(tab.id)}
            class="tab-button"
            aria-selected={isActive}
            aria-controls={TAB_PANEL_ID}
            // Roving tabindex: only the active tab is a Tab stop; the inactive
            // tab is reachable via ArrowLeft/ArrowRight (handleKeyDown).
            tabIndex={isActive ? 0 : -1}
            disabled={disabled}
            onClick={() => handleClick(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {t(locale, tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
