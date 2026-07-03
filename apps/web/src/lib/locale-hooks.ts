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
import { getLocale, subscribe } from './locale-store.js';

/** Active locale for a subtree. Default `'ko'` keeps provider-less renders
 *  (unit tests) on the Korean catalog. */
export const LocaleContext = createContext<Locale>('ko');

/** Read the active locale from context (for descendants of an island). */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/**
 * Subscribe the calling island to the locale store and return the live locale.
 * Initialized from the store on first render (client: the persisted value;
 * SSR/no-storage: the Korean default), then updated on every change.
 */
export function useLocaleStore(): Locale {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  useEffect(() => subscribe(() => setLocaleState(getLocale())), []);
  return locale;
}
