import { t } from '../lib/i18n.js';

/**
 * Rendered when the user has typed a query but no record matches.
 */
export function NoResults() {
  return (
    <div class="no-results">
      <p class="no-results-title">{t.noMatches}</p>
    </div>
  );
}
