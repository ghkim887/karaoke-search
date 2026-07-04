/**
 * Typed UI-string catalogs for the three chrome locales (Korean / English /
 * Japanese). This is chrome i18n only — song DATA fields (`title_ko` etc.) are
 * out of scope (see docs/ROADMAP.md §R2).
 *
 * The `ko` catalog is Korean-only chrome: every user-facing string is Korean,
 * with no bilingual `한국어 / English` fragments. The one intentional exception is
 * `appSubtitle` ("Karaoke Search"), kept in English as a fixed brand tagline
 * (it pairs with the footer "KARAOKE SEARCH" wordmark). `en` and `ja` are
 * single-language catalogs in their own right.
 *
 * `Messages` is a closed interface: every locale object is annotated with it,
 * so a key missing from ANY locale is a compile error, and interpolated entries
 * (`copyNumberLabel`, `resultCount`, `buildingIndex`) carry typed parameters.
 */

export const LOCALES = ['ko', 'en', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

/** Endonyms shown in the language switcher — deliberately locale-independent
 *  (each language names itself). */
export const LOCALE_LABELS: Record<Locale, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
};

/** Narrow an arbitrary value to a supported {@link Locale}. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The full set of chrome message keys. String entries are static; function
 * entries take typed interpolation parameters. Adding a key here forces every
 * locale below to define it.
 */
export interface Messages {
  // ── Document / header chrome ──────────────────────────────────────────────
  /** Page `<h1>` and `document.title`. */
  appTitle: string;
  /** Header sub-line under the title. */
  appSubtitle: string;
  /** Accessible name / tooltip for the language switcher trigger. */
  langMenuLabel: string;

  // ── Tab strip ─────────────────────────────────────────────────────────────
  tabBrowse: string;
  tabFavorites: string;

  // ── Accessible names (aria-labels / legends) ──────────────────────────────
  searchInputLabel: string;
  viewModeLabel: string;
  vendorFilterLegend: string;
  favoriteLabel: string;
  copyNumberLabel: (label: string) => string;
  copiedAnnouncement: string;

  // ── Visible compact strings ───────────────────────────────────────────────
  searchPlaceholder: string;
  copiedToast: string;

  // ── Live-region status labels ─────────────────────────────────────────────
  searching: string;
  errorOccurred: string;
  resultCount: (n: number) => string;

  // ── Loading / building states ─────────────────────────────────────────────
  buildingIndex: (count: string) => string;
  loadingIndex: string;

  // ── Error and empty messages ──────────────────────────────────────────────
  loadDataFailed: string;
  favoritesLoadFailed: string;
  offlineFallback: string;
  searchRequestFailed: string;
  retry: string;
  notYet: string;
  favoritesEmpty: string;
  noMatches: string;

  // ── Footer chrome ─────────────────────────────────────────────────────────
  disclaimer: string;
  dbUpdatedLabel: string;
  reportIssue: string;
}

export type MessageKey = keyof Messages;

/** Tuple of interpolation params for a given key (`[]` for static strings). */
type Params<K extends MessageKey> = Messages[K] extends (...args: infer P) => string ? P : [];

/**
 * Korean catalog — Korean-only chrome (the default locale). The one English
 * value is `appSubtitle`, an intentional brand tagline (see the file header).
 */
const ko: Messages = {
  appTitle: '일본 노래 검색기',
  appSubtitle: 'Karaoke Search',
  langMenuLabel: '언어',

  tabBrowse: '검색',
  tabFavorites: '즐겨찾기',

  searchInputLabel: '가라오케 검색',
  viewModeLabel: '결과 보기 모드',
  vendorFilterLegend: '머신 필터',
  favoriteLabel: '즐겨찾기',
  copyNumberLabel: (label) => `${label} 번호 복사`,
  copiedAnnouncement: '복사됨',

  searchPlaceholder: '곡명/가수명',
  copiedToast: '복사됨',

  searching: '검색 중',
  errorOccurred: '오류가 발생했습니다',
  resultCount: (n) => `${n}건`,

  buildingIndex: (count) => `${count}곡 검색 인덱스 빌드 중`,
  loadingIndex: '검색 인덱스 로딩 중…',

  loadDataFailed: '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  favoritesLoadFailed: '즐겨찾기를 불러오지 못했습니다',
  offlineFallback: '오프라인 · 저장된 목록에서 검색 중',
  searchRequestFailed: '검색 요청이 실패했습니다',
  retry: '다시 시도',
  notYet: '아직 없음',
  favoritesEmpty: '즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요.',
  noMatches: '검색 결과가 없습니다',

  disclaimer: '본 검색 결과는 참고용이며 실제 노래방 기기와 다를 수 있습니다.',
  dbUpdatedLabel: 'DB 업데이트',
  reportIssue: '문제 보고 ↗',
};

/** English catalog — concise, matching a search-tool register. */
const en: Messages = {
  appTitle: 'Japanese Song Search',
  appSubtitle: 'Karaoke Search',
  langMenuLabel: 'Language',

  tabBrowse: 'Search',
  tabFavorites: 'Favorites',

  searchInputLabel: 'Karaoke search',
  viewModeLabel: 'Result view mode',
  vendorFilterLegend: 'Machine filter',
  favoriteLabel: 'Favorite',
  copyNumberLabel: (label) => `Copy ${label} number`,
  copiedAnnouncement: 'Copied',

  searchPlaceholder: 'Song or artist',
  copiedToast: 'Copied',

  searching: 'Searching',
  errorOccurred: 'An error occurred',
  resultCount: (n) => `${n} results`,

  buildingIndex: (count) => `Building ${count}-song index`,
  loadingIndex: 'Loading search index…',

  loadDataFailed: 'Failed to load data. Please try again shortly.',
  favoritesLoadFailed: "Couldn't load favorites",
  offlineFallback: 'Offline · searching saved list',
  searchRequestFailed: 'The search request failed',
  retry: 'Retry',
  notYet: 'Not yet',
  favoritesEmpty: 'No favorites yet — tap ★ on a result to add one.',
  noMatches: 'No matches',

  disclaimer: 'Results are for reference; the actual karaoke machine may differ.',
  dbUpdatedLabel: 'DB updated',
  reportIssue: 'Report an issue ↗',
};

/** Japanese catalog — standard polite short forms (search-tool register). */
const ja: Messages = {
  appTitle: '日本の歌検索',
  appSubtitle: 'カラオケ検索',
  langMenuLabel: '言語',

  tabBrowse: '検索',
  tabFavorites: 'お気に入り',

  searchInputLabel: 'カラオケ検索',
  viewModeLabel: '表示モード',
  vendorFilterLegend: '機種フィルター',
  favoriteLabel: 'お気に入り',
  copyNumberLabel: (label) => `${label}番号をコピー`,
  copiedAnnouncement: 'コピーしました',

  searchPlaceholder: '曲名・歌手名',
  copiedToast: 'コピーしました',

  searching: '検索中',
  errorOccurred: 'エラーが発生しました',
  resultCount: (n) => `${n}件`,

  buildingIndex: (count) => `${count}曲の検索インデックスを作成中`,
  loadingIndex: '検索インデックスを読み込み中…',

  loadDataFailed: 'データを読み込めませんでした。しばらくしてからもう一度お試しください。',
  favoritesLoadFailed: 'お気に入りを読み込めませんでした',
  offlineFallback: 'オフライン · 保存済みリストから検索中',
  searchRequestFailed: '検索リクエストに失敗しました',
  retry: '再試行',
  notYet: 'まだありません',
  favoritesEmpty: 'お気に入りはまだありません — 結果カードの ★ ボタンで追加できます。',
  noMatches: '検索結果がありません',

  disclaimer: '本検索結果は参考用であり、実際のカラオケ機器と異なる場合があります。',
  dbUpdatedLabel: 'DB更新',
  reportIssue: '問題を報告 ↗',
};

/** All catalogs, keyed by locale. */
export const messages: Record<Locale, Messages> = { ko, en, ja };

/**
 * Resolve a chrome string for `locale`. Interpolated keys take their typed
 * parameters as trailing arguments; static keys take none — both are enforced
 * by {@link Params}. An unknown locale can't occur (typed), so there is no
 * runtime fallback branch here; callers hold a validated {@link Locale}.
 */
export function t<K extends MessageKey>(locale: Locale, key: K, ...params: Params<K>): string {
  // `Params<K>` guarantees the caller passed the right arguments; the internal
  // widening cast is needed only because indexing by the generic `K` collapses
  // the value to the union of all entry types.
  const entry = messages[locale][key] as string | ((...args: unknown[]) => string);
  return typeof entry === 'function' ? entry(...(params as unknown[])) : entry;
}
