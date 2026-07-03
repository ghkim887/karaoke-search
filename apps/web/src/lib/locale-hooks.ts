/**
 * Preact bridge for the framework-agnostic locale store (`locale-store.ts`).
 *
 * - `useLocaleStore()` subscribes an island's render to the store. Used by the
 *   two top-level islands (App, LanguageSwitcher).
 * - `LocaleContext` / `useLocale()` propagate the active locale DOWN a single
 *   island's tree, so leaf components (SearchBox, ResultCard, …) read it without
 *   prop-drilling. Its default is `'ko'`, so a component rendered WITHOUT a
 *   provider (as the existing component unit tests do) resolves to the Korean
 *   catalog — i.e. today's strings, unchanged.
 */

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Locale } from './i18n.js';
import { getLocale, getServerLocale, subscribe } from './locale-store.js';

/** Active locale for a subtree. Default `'ko'` keeps provider-less renders
 *  (unit tests) on the Korean catalog. */
export const LocaleContext = createContext<Locale>('ko');

/** Read the active locale from context (for descendants of an island). */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/**
 * Subscribe the calling island to the locale store and return the live locale.
 *
 * The FIRST client render must equal the server-rendered snapshot (`ko`), not
 * the stored locale. Astro hydrates islands with `hydrate()`, and Preact only
 * patches an attribute when a later vnode differs from the one it reconciled
 * against the existing DOM — if the very first client vnode already carried the
 * stored `ja`/`en` value, the SSR Korean attributes (e.g. the search input and
 * tab-bar `aria-label`s) would never be diffed and would silently stay Korean.
 * So we seed state with `getServerLocale()` and swap to the real stored locale
 * in a mount effect, which forces a genuine post-hydration diff. The resulting
 * one-frame `ko` flash for a returning en/ja user is the accepted trade-off.
 */
export function useLocaleStore(): Locale {
  const [locale, setLocaleState] = useState<Locale>(getServerLocale);
  useEffect(() => {
    // Adopt the persisted locale after hydration (a no-op re-render when it is
    // already `ko`), then keep in sync with later changes.
    setLocaleState(getLocale());
    return subscribe(() => setLocaleState(getLocale()));
  }, []);
  return locale;
}
