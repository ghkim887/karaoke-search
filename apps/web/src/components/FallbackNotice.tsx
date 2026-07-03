import { t } from '../lib/i18n.js';

/**
 * Subtle banner shown only while the app is serving results from the local
 * offline corpus because the API is unreachable (T4-6). `aria-live="polite"`
 * (matching the result-count status line) makes screen readers announce the
 * mode change without stealing focus. It is rendered exclusively in the
 * fallback state, so the healthy-path DOM is unchanged.
 */
export function FallbackNotice() {
  return (
    <p class="fallback-notice" aria-live="polite" aria-atomic="true">
      {t.offlineFallback}
    </p>
  );
}
