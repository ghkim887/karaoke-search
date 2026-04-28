// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as searchModule from '../lib/search.js';
import { App } from './App.js';

describe('App loading state', () => {
  let host: HTMLElement;

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the build-time record count and a 3-dot animation slot', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    const loading = host.querySelector('.loading');
    expect(loading).not.toBeNull();
    // The literal record count (currently 26,401) appears in the text.
    expect(loading?.textContent).toMatch(/26,401곡 검색 인덱스 빌드 중/);
    expect(loading?.textContent).toMatch(/Building 26,401-song index/);
    // Three loading-dot spans inside the loading paragraph.
    expect(loading?.querySelectorAll('.loading-dot').length).toBe(3);
  });
});

describe('App loading-state mitigation', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the empty state immediately on mount, alongside the loading indicator', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    // EmptyState root is present.
    expect(host.querySelector('.empty-state')).not.toBeNull();
    // Loading indicator is present (inside the result-list slot).
    expect(host.querySelector('.loading')).not.toBeNull();
    // SearchBox is present and disabled.
    const input = host.querySelector<HTMLInputElement>('.search-input');
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);
    expect(input?.placeholder).toMatch(/Loading search index/);
  });
});

// Fixture corpus used by the tab-behavior tests below. Three records cover the
// three categories so chip-narrowing assertions have a unique winner.
const fixtureRecords: SongRecord[] = [
  {
    id: 'r1',
    title_primary: 'Idol',
    title_ko: '아이돌',
    artist_primary: 'YOASOBI',
    artist_ko: '요아소비',
    categories: ['jpop'],
    karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    source_url: 'https://example.invalid/1',
  },
  {
    id: 'r2',
    title_primary: 'KICK BACK',
    title_ko: null,
    artist_primary: '米津玄師',
    artist_ko: '요네즈 켄시',
    categories: ['anime'],
    karaoke_numbers: { tj: '67890', ky: null, joysound: null },
    source_url: 'https://example.invalid/2',
  },
  {
    id: 'r3',
    title_primary: 'Senbonzakura',
    title_ko: '천본앵',
    artist_primary: '初音ミク',
    artist_ko: '하츠네 미쿠',
    categories: ['vocaloid'],
    karaoke_numbers: { tj: null, ky: '11111', joysound: null },
    source_url: 'https://example.invalid/3',
  },
];

const flushPromises = () => new Promise((r) => setTimeout(r, 0));
// Microtask-only flush — usable under fake setTimeout.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function waitFor<T>(predicate: () => T | null | undefined, attempts = 25): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = predicate();
    if (v) return v;
    await flushPromises();
  }
  throw new Error('waitFor timed out');
}

function buildFixtureBundle() {
  const byId = new Map(fixtureRecords.map((r) => [r.id, r] as const));
  const fakeIndex = {
    search: (q: string) => {
      const lower = q.toLowerCase();
      return fixtureRecords
        .filter(
          (r) =>
            r.title_primary.toLowerCase().includes(lower) ||
            r.artist_primary.toLowerCase().includes(lower),
        )
        .map((r) => ({ id: r.id }));
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
  } as any;
  return { index: fakeIndex, byId };
}

describe('App tab behavior', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(buildFixtureBundle());
  });

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.removeItem('karaoke-favorites:v1');
  });

  async function mount(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    // Wait for the loadIndex promise to resolve and Preact to flush — the
    // search input losing its `disabled` attribute is the proxy for "loaded".
    await waitFor(() => {
      const input = host.querySelector<HTMLInputElement>('.search-input');
      return input && input.disabled === false ? input : null;
    });
    return host;
  }

  function getTabs(h: HTMLElement): HTMLButtonElement[] {
    return Array.from(h.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  }

  async function clickFavoritesTab(h: HTMLElement) {
    const tabs = getTabs(h);
    tabs[1]?.click();
    await flushPromises();
  }

  function typeQuery(h: HTMLElement, value: string) {
    const input = h.querySelector<HTMLInputElement>('.search-input');
    if (!input) throw new Error('search input not found');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('default tab on first render is Browse', async () => {
    await mount();
    const tabs = getTabs(host);
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.textContent?.trim()).toBe('검색');
  });

  it('clicking Favorites with N starred records → body shows all N records, newest-first', async () => {
    // Newest-first ordering in localStorage: r2 (most recent) first, then r1.
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r2', 'r1']));
    await mount();
    await clickFavoritesTab(host);
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(2);
    expect(cards[0]?.textContent).toContain('KICK BACK');
    expect(cards[1]?.textContent).toContain('Idol');
  });

  it('with Favorites active and an empty search box, applying a category chip narrows the body', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r3', 'r1', 'r2']));
    await mount();
    await clickFavoritesTab(host);
    // Find the Vocaloid chip in the category-chip group (it's a fieldset).
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('.chip-group .chip'));
    const vocaloidChip = chips.find((c) => c.textContent?.trim() === 'Vocaloid');
    expect(vocaloidChip).toBeDefined();
    vocaloidChip?.click();
    await flushPromises();
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Senbonzakura');
  });

  it('with Favorites active, typing a query narrows the body case-insensitively', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r2', 'r3']));
    await mount();
    await clickFavoritesTab(host);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
  });

  it('with Favorites active and zero favorites (corpus loaded), <FavoritesEmpty> renders', async () => {
    await mount();
    await clickFavoritesTab(host);
    expect(host.querySelector('.favorites-empty')).not.toBeNull();
    expect(host.querySelector('.result-list')).toBeNull();
  });

  it('toggling off the last favorite while on the Favorites tab → placeholder appears; tab stays Favorites', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1']));
    await mount();
    await clickFavoritesTab(host);
    expect(host.querySelectorAll('[data-testid="result-card"]').length).toBe(1);
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    expect(star).not.toBeNull();
    star?.click();
    await flushPromises();
    expect(host.querySelector('.favorites-empty')).not.toBeNull();
    const tabs = getTabs(host);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('toggling on a favorite while on Browse → tab does not switch; body unchanged', async () => {
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    let cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    star?.click();
    await flushPromises();
    const tabs = getTabs(host);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
  });

  it('switching Favorites → Browse with a query in the box preserves the query and re-runs full-corpus search', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1']));
    await mount();
    await clickFavoritesTab(host);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    expect(host.querySelectorAll('[data-testid="result-card"]').length).toBe(1);
    const tabs = getTabs(host);
    tabs[0]?.click();
    await flushPromises();
    const input = host.querySelector<HTMLInputElement>('.search-input');
    expect(input?.value).toBe('idol');
    expect(host.querySelector('.result-list')).not.toBeNull();
    expect(host.querySelector('.empty-state')).toBeNull();
  });

  it('with Favorites active, typing a query that matches no favorites → <NoResults> renders', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1']));
    await mount();
    await clickFavoritesTab(host);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'xyznomatch');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    expect(host.querySelector('.no-results')).not.toBeNull();
    expect(host.querySelector('.favorites-empty')).toBeNull();
  });

  it('tab buttons inert during the loading window; clicks ignored', async () => {
    vi.spyOn(searchModule, 'loadIndex').mockReturnValueOnce(new Promise(() => {}));
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    // No flushPromises that would let the resolved promise propagate — the
    // loadIndex promise never resolves; loading stays true.
    await flushMicrotasks();
    const tabs = getTabs(host);
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.disabled).toBe(true);
    expect(tabs[1]?.disabled).toBe(true);
    tabs[1]?.click();
    await flushMicrotasks();
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
  });
});

// Discriminating fixture for the scope-filter tests. The `idol` substring
// appears in `r1.title_primary` and `r4.artist_primary` (NOT vice-versa). The
// `hatsune` substring appears in `r4.title_primary` and `r5.artist_primary`
// (NOT vice-versa). This lets each scope's "hides X-only matches" assertion
// be exercised positively + negatively.
const scopeFixtureRecords: SongRecord[] = [
  {
    id: 'r1',
    title_primary: 'Idol',
    title_ko: '아이돌',
    artist_primary: 'YOASOBI',
    artist_ko: '요아소비',
    categories: ['jpop'],
    karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    source_url: 'https://example.invalid/1',
  },
  {
    id: 'r2',
    title_primary: 'KICK BACK',
    title_ko: null,
    artist_primary: '米津玄師',
    artist_ko: '요네즈 켄시',
    categories: ['anime'],
    karaoke_numbers: { tj: '67890', ky: null, joysound: null },
    source_url: 'https://example.invalid/2',
  },
  {
    id: 'r3',
    title_primary: 'Senbonzakura',
    title_ko: '천본앵',
    artist_primary: 'Other Vocaloid',
    artist_ko: '다른 보컬로이드',
    categories: ['vocaloid'],
    karaoke_numbers: { tj: null, ky: '11111', joysound: null },
    source_url: 'https://example.invalid/3',
  },
  {
    id: 'r4',
    title_primary: 'Hatsune',
    title_ko: '하츠네',
    artist_primary: 'IDOL Group',
    artist_ko: '아이돌 그룹',
    categories: ['jpop'],
    karaoke_numbers: { tj: '99999', ky: null, joysound: null },
    source_url: 'https://example.invalid/4',
  },
  {
    id: 'r5',
    title_primary: 'Different Title',
    title_ko: '다른 곡',
    artist_primary: 'Hatsune Singer',
    artist_ko: '하츠네 가수',
    categories: ['jpop'],
    karaoke_numbers: { tj: '88888', ky: null, joysound: null },
    source_url: 'https://example.invalid/5',
  },
];

function buildScopeFixtureBundle() {
  const byId = new Map(scopeFixtureRecords.map((r) => [r.id, r] as const));
  // Fake `index.search` honors the per-call `fields` option so scope tests
  // exercise the actual contract — a fixture that ignored `fields` would
  // silently pass against a broken implementation.
  const fakeIndex = {
    search: (q: string, options?: { fields?: readonly string[] }) => {
      const lower = q.toLowerCase();
      const fields = options?.fields ?? [
        'title_primary',
        'title_ko',
        'artist_primary',
        'artist_ko',
      ];
      return scopeFixtureRecords
        .filter((r) =>
          fields.some((f) => {
            const v = (r as unknown as Record<string, unknown>)[f];
            return typeof v === 'string' && v.toLowerCase().includes(lower);
          }),
        )
        .map((r) => ({ id: r.id }));
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
  } as any;
  return { index: fakeIndex, byId };
}

describe('App scope filter', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(buildScopeFixtureBundle());
  });

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.removeItem('karaoke-favorites:v1');
  });

  async function mount(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    await waitFor(() => {
      const input = host.querySelector<HTMLInputElement>('.search-input');
      return input && input.disabled === false ? input : null;
    });
    return host;
  }

  function getScopeButtons(h: HTMLElement): HTMLButtonElement[] {
    const group = h.querySelector('[role="radiogroup"]');
    if (!group) return [];
    return Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  }

  function getCardTexts(h: HTMLElement): string[] {
    return Array.from(h.querySelectorAll<HTMLElement>('[data-testid="result-card"]')).map(
      (c) => c.textContent ?? '',
    );
  }

  function typeQuery(h: HTMLElement, value: string) {
    const input = h.querySelector<HTMLInputElement>('.search-input');
    if (!input) throw new Error('search input not found');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function typeAndDebounce(h: HTMLElement, value: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(h, value);
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
  }

  async function clickScope(h: HTMLElement, label: '전체' | '곡명' | '가수') {
    const btn = getScopeButtons(h).find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error(`scope button ${label} not found`);
    btn.click();
    await flushPromises();
  }

  it('default scope on first render is 전체 (all); the other two are unchecked', async () => {
    await mount();
    const buttons = getScopeButtons(host);
    expect(buttons.length).toBe(3);
    expect(buttons[0]?.textContent?.trim()).toBe('전체');
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[2]?.getAttribute('aria-checked')).toBe('false');
  });

  it('scope = 곡명 hides artist-only matches on Browse', async () => {
    await mount();
    await clickScope(host, '곡명');
    await typeAndDebounce(host, 'idol');
    const texts = getCardTexts(host);
    // r1 (title=Idol) is included; r4 (artist=IDOL Group) is excluded.
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(false);
  });

  it('scope = 가수 hides title-only matches on Browse', async () => {
    await mount();
    await clickScope(host, '가수');
    await typeAndDebounce(host, 'hatsune');
    const texts = getCardTexts(host);
    // r5 (artist=Hatsune Singer) is included; r4 (title=Hatsune) is excluded.
    expect(texts.some((t) => t.includes('Hatsune Singer'))).toBe(true);
    // r4's title 'Hatsune' should not appear as a title hit. Distinguish by
    // checking that no card has the r4 title without the r5 artist text.
    const r4Cards = texts.filter((t) => t.includes('Hatsune') && !t.includes('Hatsune Singer'));
    expect(r4Cards.length).toBe(0);
  });

  it("default scope ('all') returns the union — regression-free default behavior", async () => {
    await mount();
    await typeAndDebounce(host, 'idol');
    const texts = getCardTexts(host);
    // Both r1 (title hit) AND r4 (artist hit) are present at default scope.
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
  });

  it('switching scope re-runs the search; query is preserved', async () => {
    await mount();
    await typeAndDebounce(host, 'idol');
    // Default 전체 → both r1 and r4.
    let texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);

    // Switch to 곡명 — query stays 'idol', cards drop r4.
    await clickScope(host, '곡명');
    expect(host.querySelector<HTMLInputElement>('.search-input')?.value).toBe('idol');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(false);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);

    // Switch to 가수 — cards include r4, exclude r1.
    await clickScope(host, '가수');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(false);

    // Back to 전체 — both visible again.
    await clickScope(host, '전체');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
  });

  it('scope applies to the Favorites-tab matchesQuery narrowing', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r4']));
    await mount();
    // Click Favorites tab.
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs[1]?.click();
    await flushPromises();

    await typeAndDebounce(host, 'idol');
    // Default 전체 — both favorites match (r1 via title, r4 via artist).
    let texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);

    // 곡명 — only r1 (title hit) visible.
    await clickScope(host, '곡명');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(false);

    // 가수 — only r4 (artist hit) visible.
    await clickScope(host, '가수');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(false);

    // Back to 전체 — both visible.
    await clickScope(host, '전체');
    texts = getCardTexts(host);
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(true);
  });

  it('scope and category chips compose', async () => {
    await mount();
    await clickScope(host, '곡명');
    // Click the J-POP chip.
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('.chip-group .chip'));
    const jpopChip = chips.find((c) => c.textContent?.trim() === 'J-POP');
    expect(jpopChip).toBeDefined();
    jpopChip?.click();
    await flushPromises();
    await typeAndDebounce(host, 'idol');
    const texts = getCardTexts(host);
    // r1 (jpop + title-`idol`) is present; r4 (jpop but artist-`idol` — hidden by scope) is excluded.
    expect(texts.some((t) => t.includes('Idol') && !t.includes('IDOL Group'))).toBe(true);
    expect(texts.some((t) => t.includes('IDOL Group'))).toBe(false);
  });

  it('scope is ephemeral — resets to 전체 on remount (no localStorage persistence)', async () => {
    await mount();
    await clickScope(host, '곡명');
    let buttons = getScopeButtons(host);
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('true');

    // Unmount and remount fresh.
    render(null, host);
    if (host.parentNode) host.parentNode.removeChild(host);
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    await waitFor(() => {
      const input = host.querySelector<HTMLInputElement>('.search-input');
      return input && input.disabled === false ? input : null;
    });
    buttons = getScopeButtons(host);
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[2]?.getAttribute('aria-checked')).toBe('false');
  });

  it('scope buttons inert during the loading window; clicks ignored', async () => {
    vi.spyOn(searchModule, 'loadIndex').mockReturnValueOnce(new Promise(() => {}));
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    await flushMicrotasks();
    const buttons = getScopeButtons(host);
    expect(buttons.length).toBe(3);
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);
    buttons[1]?.click();
    await flushMicrotasks();
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('false');
  });
});
