import { useEffect, useRef, useState } from 'preact/hooks';
import { LOCALES, LOCALE_LABELS, type Locale, t } from '../lib/i18n.js';
import { useLocaleStore } from '../lib/locale-hooks.js';
import { setLocale } from '../lib/locale-store.js';

/**
 * Header language switcher — a globe-labelled trigger that opens a menu of the
 * three chrome locales (한국어 / English / 日本語). Its own island: it lives in the
 * static `<header>`, outside `<App>`, and shares the active locale with the
 * search UI through the module-level locale store (`useLocaleStore` /
 * `setLocale`), not through Preact context.
 *
 * Accessibility follows the WAI-ARIA menu-button pattern (single-choice menu):
 *  - trigger is `aria-haspopup="menu"` with `aria-expanded`;
 *  - the popup is `role="menu"`, each item `role="menuitemradio"` with
 *    `aria-checked` on the active locale;
 *  - keyboard: Enter/Space/Arrow open the popup and focus the active item;
 *    Up/Down/Home/End move focus; Enter/Space select; Esc closes and restores
 *    focus to the trigger; Tab or an outside click closes.
 *
 * Chosen over the listbox/option pattern because menu roles have no semantic-
 * HTML equivalent (listbox → native `<select>`), matching the owner's custom
 * dropdown design without a lint suppression.
 */
export function LanguageSwitcher() {
  const locale = useLocaleStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Which option receives focus when the popup opens next. Kept so opening via
  // ArrowUp lands on the last item and ArrowDown on the first, per the pattern.
  const pendingFocus = useRef<number | null>(null);

  const selectedIndex = LOCALES.indexOf(locale);

  // Keep --header-height synced to the real header box. The sticky `.tab-bar`
  // offsets by that token (global.css); the hand-derived default is only right
  // for a single-line title, so a wrapped title — long en/ja titles on narrow
  // viewports, made likelier by the switcher sharing the header row — would
  // leave the tab-bar underlapping the header. This is the ResizeObserver fix
  // the tokens.css TODO anticipated; it also refreshes on locale change (the
  // header content changes) and viewport resize. SSR keeps the CSS fallback.
  useEffect(() => {
    const header = rootRef.current?.closest('header.site-header');
    if (!(header instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // On open, move focus into the popup (selected option by default, or the
  // Arrow/Home/End-requested index). On close, nothing to do here — closing
  // paths that need it restore focus to the trigger explicitly.
  useEffect(() => {
    if (!open) return;
    const target = pendingFocus.current ?? selectedIndex;
    pendingFocus.current = null;
    optionRefs.current[target]?.focus();
  }, [open, selectedIndex]);

  // Close on outside pointer-down while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const closeAndFocusButton = (): void => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const choose = (next: Locale): void => {
    setLocale(next);
    closeAndFocusButton();
  };

  const openWith = (index: number): void => {
    pendingFocus.current = index;
    setOpen(true);
  };

  const handleButtonKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
      case 'Spacebar':
        // Open focusing the currently-selected option. (When already open the
        // list has focus, so these keys never reach the trigger.)
        event.preventDefault();
        openWith(selectedIndex);
        break;
      case 'ArrowUp':
        // Open focusing the last option, per the listbox pattern.
        event.preventDefault();
        openWith(LOCALES.length - 1);
        break;
      default:
        break;
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent, index: number): void => {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = (index + 1) % LOCALES.length;
        optionRefs.current[next]?.focus();
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = (index - 1 + LOCALES.length) % LOCALES.length;
        optionRefs.current[prev]?.focus();
        break;
      }
      case 'Home':
        event.preventDefault();
        optionRefs.current[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        optionRefs.current[LOCALES.length - 1]?.focus();
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        choose(LOCALES[index] as Locale);
        break;
      case 'Escape':
        event.preventDefault();
        closeAndFocusButton();
        break;
      case 'Tab':
        // Allow focus to leave naturally, but collapse the popup.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div class="lang-switcher" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        class="lang-switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openWith(selectedIndex))}
        onKeyDown={handleButtonKeyDown}
      >
        <svg
          class="lang-switcher-icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8ZM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96ZM4.26 14a7.96 7.96 0 0 1 0-4h3.38a16.6 16.6 0 0 0 0 4H4.26Zm.81 2h2.95c.34 1.27.8 2.47 1.38 3.56A8.03 8.03 0 0 1 5.07 16Zm2.95-8H5.07a8.03 8.03 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.02 8ZM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A15.7 15.7 0 0 1 12 19.96ZM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4Zm.24 5.56c.58-1.09 1.04-2.29 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56ZM16.36 14a16.6 16.6 0 0 0 0-4h3.38a7.96 7.96 0 0 1 0 4h-3.38Z"
            fill="currentColor"
          />
        </svg>
        {/* Visually-hidden purpose prefix; the visible endonym is the value. The
            accessible name reads e.g. "언어 한국어" / "Language English". */}
        <span class="sr-only">{t(locale, 'langMenuLabel')}</span>
        <span class="lang-switcher-current">{LOCALE_LABELS[locale]}</span>
        <svg
          class="lang-switcher-caret"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M7 10l5 5 5-5z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        // ARIA "menu button" pattern (APG): a menu of single-choice
        // `menuitemradio`s for picking the locale. Chosen over `listbox`/`option`
        // because menu roles have no semantic-HTML equivalent (unlike listbox →
        // <select>), matching the owner's custom-dropdown design. Items carry
        // real roving DOM focus (`tabIndex={-1}`); `aria-checked` marks the
        // active locale.
        <div class="lang-switcher-list" role="menu" aria-label={t(locale, 'langMenuLabel')}>
          {LOCALES.map((option, index) => {
            const isSelected = option === locale;
            return (
              <div
                key={option}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                role="menuitemradio"
                class={`lang-switcher-option ${isSelected ? 'lang-switcher-option-selected' : ''}`}
                aria-checked={isSelected}
                tabIndex={-1}
                lang={option}
                onClick={() => choose(option)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                {LOCALE_LABELS[option]}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
