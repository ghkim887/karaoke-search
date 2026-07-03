/**
 * Typed UI-string catalogs for the three chrome locales (Korean / English /
 * Japanese). This is chrome i18n only — song DATA fields (`title_ko` etc.) are
 * out of scope (see docs/ROADMAP.md §R2).
 *
 * Behaviour preservation (R2 spec §6): the Korean catalog is a byte-for-byte
 * re-expression of the previous single-locale `t` object. The strings that were
 * bilingual (`한국어 / English`) BEFORE this change stay bilingual under the `ko`
 * locale — `ko` is "the current UI, unchanged", not a Korean-only rewrite — so
 * the default render (locale = ko) is identical to today and the existing
 * component tests pass unmodified. Selecting `en` or `ja` swaps to a clean
 * single-language rendering.
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

/** Join a Korean and an English fragment with the canonical ` / ` separator.
 *  Used only by the `ko` catalog to reproduce the prior bilingual literals
 *  exactly. */
function bilingual(ko: string, en: string): string {
  return `${ko} / ${en}`;
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
 * Korean catalog — the source of truth. Every value here reproduces the exact
 * string rendered by the app today (bilingual where it was bilingual,
 * Korean-only where it was Korean-only), so `t('ko', …)` is byte-identical to
 * the former inline literals.
 */
const ko: Messages = {
  appTitle: '일본 노래 검색기',
  appSubtitle: 'Karaoke Search',
  langMenuLabel: '언어',

  tabBrowse: '검색',
  tabFavorites: '즐겨찾기',

  searchInputLabel: bilingual('가라오케 검색', 'Karaoke search'),
  viewModeLabel: bilingual('결과 보기 모드', 'Result view mode'),
  vendorFilterLegend: bilingual('머신 필터', 'Machine filter'),
  favoriteLabel: bilingual('즐겨찾기', 'Favorite'),
  copyNumberLabel: (label) => bilingual(`${label} 번호 복사`, `Copy ${label} number`),
  copiedAnnouncement: bilingual('복사됨', 'Copied'),

  searchPlaceholder: '곡명/가수명',
  copiedToast: '복사됨',

  searching: bilingual('검색 중', 'Searching'),
  errorOccurred: bilingual('오류가 발생했습니다', 'An error occurred'),
  resultCount: (n) => bilingual(`${n}건`, `${n} results`),

  buildingIndex: (count) =>
    bilingual(`${count}곡 검색 인덱스 빌드 중`, `Building ${count}-song index`),
  loadingIndex: bilingual('검색 인덱스 로딩 중…', 'Loading search index…'),

  loadDataFailed: bilingual(
    '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    'Failed to load data. Please try again shortly.',
  ),
  favoritesLoadFailed: bilingual('즐겨찾기를 불러오지 못했습니다', "Couldn't load favorites"),
  offlineFallback: bilingual(
    '오프라인 · 저장된 목록에서 검색 중',
    'Offline · searching saved list',
  ),
  searchRequestFailed: bilingual('검색 요청이 실패했습니다', 'The search request failed'),
  retry: bilingual('다시 시도', 'Retry'),
  notYet: bilingual('아직 없음', 'Not yet'),
  favoritesEmpty: bilingual(
    '즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요.',
    'No favorites yet — tap ★ on a result to add one.',
  ),
  noMatches: bilingual('검색 결과가 없습니다', 'No matches'),

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
