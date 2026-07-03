/**
 * Central bilingual (Korean / English) UI-string dictionary.
 *
 * The app renders every user-facing string in a `한국어 / English` form. Before
 * this module those literals were scattered across components; the join
 * separator and both halves are now defined in exactly one place. The rendered
 * output is a pure byte-for-byte re-expression of the prior inline literals —
 * this is a centralization, not a copy change. The only strings that were
 * *promoted* to bilingual on purpose are the aria-labels (see `A11Y language
 * rule` below), because the a11y batch unifies the aria-label language policy.
 *
 * Korean-only compact strings that never carried an English half (the search
 * placeholder and the visible copy toast) are kept Korean-only here so the
 * visible bytes stay identical.
 */

/** Join a Korean and an English fragment with the canonical ` / ` separator. */
export function bilingual(ko: string, en: string): string {
  return `${ko} / ${en}`;
}

export const t = {
  // ── A11Y language rule: aria-labels are bilingual across the board ────────
  // These accessible names were Korean-only before the a11y batch and are now
  // bilingual to match `즐겨찾기 / Favorite`, the one that already was. This is
  // an observable (screen-reader) change, tracked in the batch report.
  searchInputLabel: bilingual('가라오케 검색', 'Karaoke search'),
  viewModeLabel: bilingual('결과 보기 모드', 'Result view mode'),
  vendorFilterLegend: bilingual('머신 필터', 'Machine filter'),
  favoriteLabel: bilingual('즐겨찾기', 'Favorite'),
  copyNumberLabel: (label: string): string =>
    bilingual(`${label} 번호 복사`, `Copy ${label} number`),
  copiedAnnouncement: bilingual('복사됨', 'Copied'),

  // ── Korean-only visible strings (kept Korean-only; not bilingual) ─────────
  searchPlaceholder: '곡명/가수명',
  copiedToast: '복사됨',

  // ── Live-region status labels (result count) ──────────────────────────────
  searching: bilingual('검색 중', 'Searching'),
  errorOccurred: bilingual('오류가 발생했습니다', 'An error occurred'),
  resultCount: (n: number): string => bilingual(`${n}건`, `${n} results`),

  // ── Loading / building states ─────────────────────────────────────────────
  buildingIndex: (count: string): string =>
    bilingual(`${count}곡 검색 인덱스 빌드 중`, `Building ${count}-song index`),
  loadingIndex: bilingual('검색 인덱스 로딩 중…', 'Loading search index…'),

  // ── Error and empty messages ──────────────────────────────────────────────
  loadDataFailed: bilingual(
    '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    'Failed to load data. Please try again shortly.',
  ),
  favoritesLoadFailed: bilingual('즐겨찾기를 불러오지 못했습니다', "Couldn't load favorites"),
  searchRequestFailed: bilingual('검색 요청이 실패했습니다', 'The search request failed'),
  retry: bilingual('다시 시도', 'Retry'),
  notYet: bilingual('아직 없음', 'Not yet'),
  favoritesEmpty: bilingual(
    '즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요.',
    'No favorites yet — tap ★ on a result to add one.',
  ),
  noMatches: bilingual('검색 결과가 없습니다', 'No matches'),
} as const;
