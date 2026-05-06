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
    render(<App songCount={26401} />, host);
    const loading = host.querySelector('.loading');
    expect(loading).not.toBeNull();
    // Format-shape assertion — a comma-grouped count in the build-time label.
    // Catches future regressions in the toLocaleString formatting without
    // pinning a literal that drifts as the corpus grows.
    expect(loading?.textContent).toMatch(/Building \d{1,3}(,\d{3})*-song index/);
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
    render(<App songCount={26401} />, host);
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
    crawled_at: '2026-04-29T00:00:00.000Z',
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
    crawled_at: '2026-04-29T00:00:00.000Z',
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
    crawled_at: '2026-04-29T00:00:00.000Z',
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
            r.artist_primary.toLowerCase().includes(lower) ||
            (r.artist_aliases ?? []).some((a) => a.toLowerCase().includes(lower)),
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
    render(<App songCount={26401} />, host);
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
    // Find the Vocaloid chip in the category-chip group (rendered as a
    // <div role="radiogroup">, not a <fieldset>).
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

  it('with Favorites active, searching via an artist alias finds the record (alias-aware search)', async () => {
    // Fixture record with an alias — not in fixtureRecords, injected via a
    // custom bundle that adds a fourth record.
    const aliasRecord: SongRecord = {
      id: 'r4',
      title_primary: 'Robinson',
      title_ko: null,
      artist_primary: 'スピッツ',
      artist_ko: null,
      artist_aliases: ['Spitz'],
      categories: ['jpop'],
      karaoke_numbers: { tj: '99999', ky: null, joysound: null },
      source_url: 'https://example.invalid/4',
      crawled_at: '2026-04-29T00:00:00.000Z',
    };
    const allRecords = [...fixtureRecords, aliasRecord];
    const byId = new Map(allRecords.map((r) => [r.id, r] as const));
    const fakeIndexAlias = {
      search: (q: string) => {
        const lower = q.toLowerCase();
        return allRecords
          .filter(
            (r) =>
              r.title_primary.toLowerCase().includes(lower) ||
              r.artist_primary.toLowerCase().includes(lower) ||
              (r.artist_aliases ?? []).some((a) => a.toLowerCase().includes(lower)),
          )
          .map((r) => ({ id: r.id }));
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
    } as any;
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue({ index: fakeIndexAlias, byId });
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r4']));
    await mount();
    await clickFavoritesTab(host);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'Spitz');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('スピッツ');
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

  it('switching Favorites → Browse resets filters and shows the empty-state (no query)', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1']));
    await mount();
    await clickFavoritesTab(host);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
    // Favorites tab: narrowed to 1 card.
    expect(host.querySelectorAll('[data-testid="result-card"]').length).toBe(1);
    // Switch back to Browse — filters should reset.
    const tabs = getTabs(host);
    tabs[0]?.click();
    await flushPromises();
    const input = host.querySelector<HTMLInputElement>('.search-input');
    // Input cleared on tab switch.
    expect(input?.value).toBe('');
    // Browse with empty query shows the empty state, not a result list.
    expect(host.querySelector('.empty-state')).not.toBeNull();
    expect(host.querySelector('.result-list')).toBeNull();
  });

  it('switching tabs resets input, category chip, and vendor chip to defaults', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r2', 'r3']));
    await mount();

    // --- Browse tab: type a query, pick a category chip, pick a vendor chip ---
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();

    // Pick the Anime category chip.
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('.chip-group .chip'));
    const animeChip = chips.find((c) => c.textContent?.trim() === 'Anime');
    expect(animeChip).toBeDefined();
    animeChip?.click();
    await flushPromises();

    // Pick the TJ vendor chip.
    const vendorChips = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.chip-group-vendor .chip'),
    );
    const tjChip = vendorChips.find((c) => c.textContent?.trim() === 'TJ');
    expect(tjChip).toBeDefined();
    tjChip?.click();
    await flushPromises();

    // --- Switch to Favorites tab ---
    await clickFavoritesTab(host);

    // Input must be empty.
    const inputAfter = host.querySelector<HTMLInputElement>('.search-input');
    expect(inputAfter?.value).toBe('');

    // 전체 (All) chip must be selected (aria-checked="true").
    const allChip = Array.from(host.querySelectorAll<HTMLButtonElement>('.chip-group .chip')).find(
      (c) => c.textContent?.trim() === '전체',
    );
    expect(allChip).toBeDefined();
    expect(allChip?.getAttribute('aria-checked')).toBe('true');

    // No vendor chip should be active.
    const activeVendorChips = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.chip-group-vendor .chip'),
    ).filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(activeVendorChips.length).toBe(0);

    // Favorites tab shows all 3 favorites (no filter narrowing).
    const cards = host.querySelectorAll('[data-testid="result-card"]');
    expect(cards.length).toBe(3);

    // --- Switch back to Browse ---
    const tabs = getTabs(host);
    tabs[0]?.click();
    await flushPromises();

    // Still clean defaults: empty input, 전체 selected, no vendor active.
    const inputAfterBrowse = host.querySelector<HTMLInputElement>('.search-input');
    expect(inputAfterBrowse?.value).toBe('');

    const allChipBrowse = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.chip-group .chip'),
    ).find((c) => c.textContent?.trim() === '전체');
    expect(allChipBrowse?.getAttribute('aria-checked')).toBe('true');

    const activeVendorChipsBrowse = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.chip-group-vendor .chip'),
    ).filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(activeVendorChipsBrowse.length).toBe(0);

    // Browse with empty query shows the empty state.
    expect(host.querySelector('.empty-state')).not.toBeNull();
    expect(host.querySelector('.result-list')).toBeNull();
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
    render(<App songCount={26401} />, host);
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
