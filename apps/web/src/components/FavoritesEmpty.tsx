import { t } from '../lib/i18n.js';

/**
 * Placeholder shown on the Favorites tab when the user has zero favorites.
 * Rendered ONLY when `favoriteIds.length === 0` on the Favorites tab; if the
 * user has favorites but the query yields no matches, the parent renders
 * <NoResults /> instead.
 */
export function FavoritesEmpty() {
  return (
    <div class="favorites-empty">
      <p>{t.favoritesEmpty}</p>
    </div>
  );
}
