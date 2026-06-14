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

// Fixture corpus used by the tab-behavior tests below.
const fixtureRecords: SongRecord[] = [
  {
    id: 'r1',
    title_primary: 'Idol',
    title_ko: '아이돌',
    artist_primary: 'YOASOBI',
    artist_ko: '요아소비',
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

describe('App RenderMode loading→browse-empty transition', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
  });

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.removeItem('karaoke-favorites:v1');
  });

  it('co-renders <EmptyState> alongside <loading> during the loading window, then drops <loading> after loadIndex resolves while <empty-state> remains', async () => {
    // Hold the loadIndex promise open so we can observe the loading window.
    let resolveLoad: (bundle: { index: unknown; byId: Map<string, SongRecord> }) => void = () => {};
    const pending = new Promise<{ index: unknown; byId: Map<string, SongRecord> }>((resolve) => {
      resolveLoad = resolve;
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal IndexBundle stub for tests
    vi.spyOn(searchModule, 'loadIndex').mockReturnValue(pending as any);

    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={26401} />, host);

    // During the loading window: BOTH .loading and .empty-state are present.
    await flushMicrotasks();
    expect(host.querySelector('.loading')).not.toBeNull();
    expect(host.querySelector('.empty-state')).not.toBeNull();

    // Resolve loadIndex with an empty-corpus bundle.
    const byId = new Map<string, SongRecord>();
    const fakeIndex = {
      search: () => [],
      // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
    } as any;
    resolveLoad({ index: fakeIndex, byId });
    await waitFor(() => {
      const input = host.querySelector<HTMLInputElement>('.search-input');
      return input && input.disabled === false ? input : null;
    });

    // After resolve: .loading is gone, .empty-state remains (browse-empty mode).
    expect(host.querySelector('.loading')).toBeNull();
    expect(host.querySelector('.empty-state')).not.toBeNull();
  });
});

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

  it('uses API search for Browse queries when an API base URL is configured', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const apiRecord = fixtureRecords[1];
    if (apiRecord === undefined) throw new Error('fixture record missing');
    const apiSpy = vi.spyOn(searchModule, 'searchApi').mockResolvedValue([apiRecord]);
    await mount();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => (apiSpy.mock.calls.length > 0 ? true : null));
    await waitFor(() => {
      const card = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return card?.textContent?.includes('KICK BACK') ? card : null;
    });
    expect(apiSpy).toHaveBeenCalledWith(
      'https://api.example.test',
      expect.objectContaining({ query: 'kick', limit: 50 }),
    );
  });

  it('shows a searching state, not NoResults, while an API Browse query is pending', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const apiRecord = fixtureRecords[1];
    if (apiRecord === undefined) throw new Error('fixture record missing');
    let resolveApi: (records: SongRecord[]) => void = () => {};
    const pending = new Promise<SongRecord[]>((resolve) => {
      resolveApi = resolve;
    });
    const apiSpy = vi.spyOn(searchModule, 'searchApi').mockReturnValue(pending);
    await mount();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => (apiSpy.mock.calls.length > 0 ? true : null));
    const searching = await waitFor(() => host.querySelector<HTMLElement>('.search-loading'));
    expect(searching.textContent).toContain('검색 중');
    expect(host.querySelector('.no-results')).toBeNull();
    expect(host.querySelector('[data-testid="result-count"]')?.textContent).toContain('검색 중');

    resolveApi([apiRecord]);
    await waitFor(() => {
      const card = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return card?.textContent?.includes('KICK BACK') ? card : null;
    });
    expect(host.querySelector('.search-loading')).toBeNull();
  });
  it('keeps Browse search usable through the API before the local MiniSearch index finishes loading', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    vi.spyOn(searchModule, 'loadIndex').mockReturnValue(new Promise(() => {}) as never);
    const apiRecord = fixtureRecords[1];
    if (apiRecord === undefined) throw new Error('fixture record missing');
    const apiSpy = vi.spyOn(searchModule, 'searchApi').mockResolvedValue([apiRecord]);

    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={26401} />, host);
    await flushMicrotasks();

    const input = host.querySelector<HTMLInputElement>('.search-input');
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => (apiSpy.mock.calls.length > 0 ? true : null));
    await waitFor(() => {
      const card = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return card?.textContent?.includes('KICK BACK') ? card : null;
    });
    expect(host.querySelector('.loading')).toBeNull();
  });
  it('does NOT download the local index when an API base URL is configured (full API-first)', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const loadSpy = vi.spyOn(searchModule, 'loadIndex');
    vi.spyOn(searchModule, 'searchApi').mockResolvedValue([]);

    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={26401} />, host);
    await flushMicrotasks();
    await flushPromises();

    // In API mode the full songs.json is never fetched.
    expect(loadSpy).not.toHaveBeenCalled();
    // The UI is immediately usable (no "Building index" loading window).
    const input = host.querySelector<HTMLInputElement>('.search-input');
    expect(input?.disabled).toBe(false);
    expect(host.querySelector('.loading')).toBeNull();
  });
  it('uses API search with a comma-joined vendor union when multiple vendors are selected', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const apiRecord = fixtureRecords[0];
    if (apiRecord === undefined) throw new Error('fixture record missing');
    const apiSpy = vi.spyOn(searchModule, 'searchApi').mockResolvedValue([apiRecord]);
    await mount();

    const vendorChips = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.chip-group-vendor .chip'),
    );
    vendorChips.find((c) => c.textContent?.trim() === 'TJ')?.click();
    vendorChips.find((c) => c.textContent?.trim() === 'KY')?.click();
    await flushPromises();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => (apiSpy.mock.calls.length > 0 ? true : null));
    // The full selected vendor set is forwarded to the API as `vendors`.
    const lastCall = apiSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('https://api.example.test');
    const opts = lastCall?.[1] as { query: string; vendors?: string[] };
    expect(opts.query).toBe('idol');
    expect([...(opts.vendors ?? [])].sort()).toEqual(['ky', 'tj']);
  });
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

  it('switching tabs resets input and vendor chip to defaults', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r2', 'r3']));
    await mount();

    // --- Browse tab: type a query, pick a vendor chip ---
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
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

    // Still clean defaults: empty input, no vendor active.
    const inputAfterBrowse = host.querySelector<HTMLInputElement>('.search-input');
    expect(inputAfterBrowse?.value).toBe('');

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

describe('App favorites via API (full API-first mode)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    // Resolved stub: in API mode App never calls loadIndex, but a stale Preact
    // tree from a prior describe (DOM node removed, never unmounted) could fire
    // a deferred mount effect — keep it off the network. The dedicated
    // "does NOT download the local index…" test (above) is the clean assertion
    // that API mode skips the corpus download.
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue({
      index: { search: () => [] },
      byId: new Map(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal IndexBundle stub for tests
    } as any);
    vi.spyOn(searchModule, 'searchApi').mockResolvedValue([]);
  });

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.removeItem('karaoke-favorites:v1');
  });

  function getTabs(h: HTMLElement): HTMLButtonElement[] {
    return Array.from(h.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  }

  async function mount(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={26401} />, host);
    // In API mode the mount effect flips loading→false (no full-corpus
    // download). Wait until the tab bar is interactive (tabs un-disable once
    // loading settles) before driving clicks.
    await waitFor(() => {
      const tabs = getTabs(host);
      return tabs.length === 2 && tabs.every((t) => t.disabled === false) ? tabs : null;
    });
    return host;
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

  it('Favorites tab fetches starred records via fetchSongsByIds and renders them re-sorted by favorite order', async () => {
    // Favorite order (newest-first) is r2, r1; the API returns them in a
    // different (unspecified) order — the component must re-sort to r2, r1.
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r2', 'r1']));
    const r1 = fixtureRecords[0];
    const r2 = fixtureRecords[1];
    if (!r1 || !r2) throw new Error('fixture records missing');
    const fetchSpy = vi
      .spyOn(searchModule, 'fetchSongsByIds')
      // Returned out of favorite order on purpose.
      .mockResolvedValue([r1, r2]);

    await mount();
    await clickFavoritesTab(host);
    await waitFor(() => (fetchSpy.mock.calls.length > 0 ? true : null));
    await waitFor(() =>
      host.querySelectorAll('[data-testid="result-card"]').length === 2 ? true : null,
    );

    expect(fetchSpy).toHaveBeenCalledWith('https://api.example.test', ['r2', 'r1']);
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(2);
    // Re-sorted to favorite order: r2 (KICK BACK) first, r1 (Idol) second.
    expect(cards[0]?.textContent).toContain('KICK BACK');
    expect(cards[1]?.textContent).toContain('Idol');
  });

  it('query within Favorites filters the fetched favorites client-side (no extra fetch)', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r2', 'r3']));
    const [r1, r2, r3] = fixtureRecords;
    if (!r1 || !r2 || !r3) throw new Error('fixture records missing');
    const fetchSpy = vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue([r1, r2, r3]);

    await mount();
    await clickFavoritesTab(host);
    await waitFor(() =>
      host.querySelectorAll('[data-testid="result-card"]').length === 3 ? true : null,
    );
    const callsAfterLoad = fetchSpy.mock.calls.length;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'idol');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();

    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
    // Client-side filter — no additional fetchSongsByIds calls for the query.
    expect(fetchSpy.mock.calls.length).toBe(callsAfterLoad);
  });

  it('Favorites query matches an artist alias client-side (alias-aware)', async () => {
    const aliasRecord: SongRecord = {
      id: 'r4',
      title_primary: 'Robinson',
      title_ko: null,
      artist_primary: 'スピッツ',
      artist_ko: null,
      artist_aliases: ['Spitz'],
      karaoke_numbers: { tj: '99999', ky: null, joysound: null },
      source_url: 'https://example.invalid/4',
      crawled_at: '2026-04-29T00:00:00.000Z',
    };
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r4', 'r1']));
    const r1 = fixtureRecords[0];
    if (!r1) throw new Error('fixture record missing');
    vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue([aliasRecord, r1]);

    await mount();
    await clickFavoritesTab(host);
    await waitFor(() =>
      host.querySelectorAll('[data-testid="result-card"]').length === 2 ? true : null,
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'Spitz');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();

    const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('スピッツ');
  });

  it('with zero favorites, <FavoritesEmpty> renders without any API fetch', async () => {
    const fetchSpy = vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue([]);
    await mount();
    await clickFavoritesTab(host);
    expect(host.querySelector('.favorites-empty')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
