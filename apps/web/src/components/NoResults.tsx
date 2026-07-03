import { t } from '../lib/i18n.js';
import { useLocale } from '../lib/locale-hooks.js';

/**
 * Rendered when the user has typed a query but no record matches.
 */
export function NoResults() {
  const locale = useLocale();
  return (
    <div class="no-results">
      <p class="no-results-title">{t(locale, 'noMatches')}</p>
    </div>
  );
}
