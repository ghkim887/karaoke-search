/**
 * Rendered when the user has typed a query but no record matches.
 * v2 will add TJ-direct fallback for long-tail songs (per spec §5).
 */
export function NoResults() {
  return (
    <div class="no-results">
      <p class="no-results-title">검색 결과가 없습니다 / 該当なし</p>
      <p class="no-results-hint">
        찾는 곡이 없으면 v2의 TJ 직접 검색을 기다려 주세요. (v2 will add TJ-direct fallback for
        long-tail songs.)
      </p>
    </div>
  );
}
