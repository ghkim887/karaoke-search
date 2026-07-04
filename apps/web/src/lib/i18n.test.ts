import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_LABELS, type MessageKey, isLocale, messages, t } from './i18n.js';

describe('i18n catalog structure', () => {
  it('exposes exactly the three chrome locales', () => {
    expect([...LOCALES]).toEqual(['ko', 'en', 'ja']);
  });

  it('every locale defines the identical set of keys (no missing translations)', () => {
    const koKeys = Object.keys(messages.ko).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages[locale]).sort()).toEqual(koKeys);
    }
  });

  it('has a self-naming endonym label for each locale', () => {
    expect(LOCALE_LABELS).toEqual({ ko: '한국어', en: 'English', ja: '日本語' });
  });
});

describe('isLocale', () => {
  it('accepts the supported locales and rejects everything else', () => {
    expect(isLocale('ko')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ja')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe('t() lookup and interpolation', () => {
  it('resolves static strings per locale', () => {
    expect(t('ko', 'tabBrowse')).toBe('검색');
    expect(t('en', 'tabBrowse')).toBe('Search');
    expect(t('ja', 'tabBrowse')).toBe('検索');
  });

  it('interpolates the result-count parameter', () => {
    expect(t('ko', 'resultCount', 3)).toBe('3건');
    expect(t('en', 'resultCount', 3)).toBe('3 results');
    expect(t('ja', 'resultCount', 3)).toBe('3件');
  });

  it('interpolates the building-index count', () => {
    expect(t('en', 'buildingIndex', '26,401')).toBe('Building 26,401-song index');
    expect(t('ja', 'buildingIndex', '26,401')).toBe('26,401曲の検索インデックスを作成中');
  });

  it('interpolates the copy-number vendor label', () => {
    expect(t('en', 'copyNumberLabel', 'TJ')).toBe('Copy TJ number');
    expect(t('ja', 'copyNumberLabel', 'KY')).toBe('KY番号をコピー');
  });
});

// Korean-only guard: the `ko` locale is the default, server-rendered chrome and
// every user-facing string must be Korean-only. The single intentional
// exception is `appSubtitle` ("Karaoke Search"), a fixed English brand tagline.
// If a future edit reintroduces English into a ko chrome string this fails,
// forcing an intentional review.
describe('ko catalog is Korean-only chrome (brand appSubtitle aside)', () => {
  type StaticKey = Exclude<MessageKey, 'copyNumberLabel' | 'resultCount' | 'buildingIndex'>;
  const expected: Record<StaticKey, string> = {
    appTitle: '일본 노래 검색기',
    appSubtitle: 'Karaoke Search',
    langMenuLabel: '언어',
    tabBrowse: '검색',
    tabFavorites: '즐겨찾기',
    searchInputLabel: '가라오케 검색',
    viewModeLabel: '결과 보기 모드',
    vendorFilterLegend: '머신 필터',
    favoriteLabel: '즐겨찾기',
    copiedAnnouncement: '복사됨',
    searchPlaceholder: '곡명/가수명',
    copiedToast: '복사됨',
    searching: '검색 중',
    errorOccurred: '오류가 발생했습니다',
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

  for (const [key, value] of Object.entries(expected)) {
    it(`ko.${key}`, () => {
      expect(t('ko', key as StaticKey)).toBe(value);
    });
  }

  it('ko interpolated strings are Korean-only', () => {
    expect(t('ko', 'copyNumberLabel', 'TJ')).toBe('TJ 번호 복사');
    expect(t('ko', 'resultCount', 12)).toBe('12건');
    expect(t('ko', 'buildingIndex', '26,401')).toBe('26,401곡 검색 인덱스 빌드 중');
  });
});
