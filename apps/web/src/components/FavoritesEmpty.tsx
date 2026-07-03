import { t } from '../lib/i18n.js';
import { useLocale } from '../lib/locale-hooks.js';

/**
 * Placeholder shown on the Favorites tab when the user has zero favorites.
 * Rendered ONLY when `favoriteIds.length === 0` on the Favorites tab; if the
 * user has favorites but the query yields no matches, the parent renders
 * <NoResults /> instead.
 */
export function FavoritesEmpty() {
  const locale = useLocale();
  return (
    <div class="favorites-empty">
      <p>{t(locale, 'favoritesEmpty')}</p>
    </div>
  );
}
