/**
 * Placeholder shown on the Favorites tab when the user has zero favorites.
 * Rendered ONLY when `favoriteIds.length === 0` on the Favorites tab; if the
 * user has favorites but the query yields no matches, the parent renders
 * <NoResults /> instead.
 */
export function FavoritesEmpty() {
  return (
    <div class="favorites-empty">
      <p>
        즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요. / No favorites yet — tap ★ on a
        result to add one.
      </p>
    </div>
  );
}
