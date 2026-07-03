/**
 * Framework-agnostic locale store — the single source of truth for the active
 * chrome locale, shared across BOTH client islands (the App search UI and the
 * header language switcher).
 *
 * Why a module store rather than the App island's `useState`: the switcher
 * lives in the server-rendered `<header>`, outside the `<App>` island, and the
 * footer's DB-date script lives in `Footer.astro`. There is no single Preact
 * tree spanning all three, so the App island cannot own the state for the
 * others. This store owns it instead; each island bridges it into Preact
 * (see `locale-hooks.ts`), and the static header/footer/`<html lang>`/title are
 * updated imperatively by {@link applyChrome}.
 *
 * Cross-island notification uses a `window` CustomEvent rather than a shared
 * module variable so it is correct regardless of how Vite chunks the islands
 * (two module instances would each still observe every change).
 *
 * PWA manifest limitation: `manifest.webmanifest` (name/description/lang) is a
 * static build artifact and is NOT updated at runtime — an installed PWA keeps
 * its Korean manifest metadata. Only the live DOM is localized. Documented here
 * and in the R2 report.
 */

import { type Locale, type MessageKey, isLocale, messages, t } from './i18n.js';

/** localStorage key holding the user's chosen locale. */
export const LOCALE_STORAGE_KEY = 'karaoke-locale';

/** Window event fired on every locale change; `detail` is the new locale. */
const LOCALE_EVENT = 'karaoke:locale-change';

/** Default locale. Deliberately NOT navigator-derived — the site is Korean-first
 *  and the default render must stay Korean (R2 spec §2). */
const DEFAULT_LOCALE: Locale = 'ko';

/** Read the persisted locale, tolerating missing/blocked storage. */
export function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

// Cached current value. Initialized lazily from storage, then kept in sync via
// the window event (so every module instance converges on the same value).
let current: Locale | null = null;

/** The active locale (client). Falls back to the default under SSR/no-storage. */
export function getLocale(): Locale {
  if (current === null) current = getStoredLocale();
  return current;
}

/** SSR / first-hydration snapshot — always the Korean default, matching the
 *  server-rendered shell. */
export function getServerLocale(): Locale {
  return DEFAULT_LOCALE;
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function subscribe(callback: () => void): () => void {
  const handler = (event: Event): void => {
    const next = (event as CustomEvent<Locale>).detail;
    if (isLocale(next)) current = next;
    callback();
  };
  window.addEventListener(LOCALE_EVENT, handler);
  return () => window.removeEventListener(LOCALE_EVENT, handler);
}

/**
 * Set the active locale: persist it, update the static chrome, and notify every
 * subscriber (both islands re-render). A no-op if the value is unchanged.
 */
export function setLocale(next: Locale): void {
  if (next === getLocale()) return;
  current = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Storage blocked (private mode / quota) — the in-memory value still drives
    // this session; the preference simply won't persist across reloads.
  }
  applyChrome(next);
  window.dispatchEvent(new CustomEvent<Locale>(LOCALE_EVENT, { detail: next }));
}

/**
 * Localize the server-rendered static chrome (everything outside the Preact
 * islands): `<html lang>`, `document.title`, the header title/subtitle, and the
 * footer disclaimer + meta labels. Idempotent, and a no-op under SSR.
 *
 * Static text nodes opt in with `data-i18n="<key>"` (param-less keys only). The
 * footer disclaimer is handled by visibility toggling instead, so all three
 * translations can be present in the a11y-inert markup and swapped without
 * re-parsing text.
 */
export function applyChrome(locale: Locale): void {
  if (typeof document === 'undefined') return;

  document.documentElement.lang = locale;
  document.title = messages[locale].appTitle;

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key === undefined) continue;
    const entry = messages[locale][key];
    // Only static string entries are wired to data-i18n; skip anything else
    // defensively so a mismatched attribute can never inject `[object …]`.
    if (typeof entry === 'string') el.textContent = entry;
  }

  // The subtitle text ("Karaoke Search" / "カラオケ検索") has its own language,
  // distinct from the UI locale, so its `lang` must track the text, not `<html>`.
  const subtitle = document.querySelector<HTMLElement>('[data-i18n="appSubtitle"]');
  if (subtitle !== null) subtitle.lang = locale === 'ja' ? 'ja' : 'en';

  applyDisclaimer(locale);
}

/**
 * Footer disclaimer visibility. `ko` preserves today's two-line bilingual
 * form (Korean + English lines both shown); `en`/`ja` show only their single
 * line. Driven by the `data-disclaimer` locale marker on each span.
 */
function applyDisclaimer(locale: Locale): void {
  const spans = document.querySelectorAll<HTMLElement>('[data-disclaimer]');
  for (const span of spans) {
    const spanLocale = span.dataset.disclaimer;
    const visible = spanLocale === locale || (locale === 'ko' && spanLocale === 'en');
    span.hidden = !visible;
  }
}

// Bring the static chrome into sync with the stored locale as soon as this
// module executes in the browser (island hydration). A no-op for the Korean
// default; corrects the shell for a returning en/ja user. Guarded for SSR.
if (typeof document !== 'undefined') {
  applyChrome(getLocale());
}

// Re-export `t` so consumers can pull the translator and the store from one
// place if convenient; the canonical source remains ./i18n.
export { t };
