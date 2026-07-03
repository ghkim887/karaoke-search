// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as searchModule from '../lib/search.js';
import { App } from './App.js';

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

async function waitFor<T>(predicate: () => T | null | undefined, attempts = 25): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = predicate();
    if (v) return v;
    await flushPromises();
  }
  throw new Error('waitFor timed out');
}

const favRecords: SongRecord[] = [
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
    title_primary: 'Lemon',
    title_ko: null,
    artist_primary: '米津玄師',
    artist_ko: null,
    karaoke_numbers: { tj: '22222', ky: null, joysound: null },
    source_url: 'https://example.invalid/3',
    crawled_at: '2026-04-29T00:00:00.000Z',
  },
];

// P5: in API-favorites mode the query-within-favorites index must be built from
// the fetched records once (keyed on the records), not rebuilt on every
// keystroke inside the query memo.
describe('P5: API favorites index is not rebuilt per keystroke', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
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

  function typeQuery(h: HTMLElement, value: string) {
    const input = h.querySelector<HTMLInputElement>('.search-input');
    if (!input) throw new Error('search input not found');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function typeDebounced(h: HTMLElement, value: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(h, value);
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await flushPromises();
  }

  it('builds the favorites index once per favorites set, regardless of query keystrokes', async () => {
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r1', 'r2', 'r3']));
    vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue(favRecords);
    // Keep the real buildIndex implementation so search still works; just count.
    const buildSpy = vi.spyOn(searchModule, 'buildIndex');

    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={3} />, host);

    await waitFor(() => {
      const tabs = getTabs(host);
      return tabs.length === 2 && tabs.every((t) => t.disabled === false) ? tabs : null;
    });
    getTabs(host)[1]?.click();
    await flushPromises();
    await waitFor(() =>
      host.querySelectorAll('[data-testid="result-card"]').length === 3 ? true : null,
    );

    const buildsAfterLoad = buildSpy.mock.calls.length;

    // Several distinct debounced queries — none should rebuild the index.
    await typeDebounced(host, 'l');
    await typeDebounced(host, 'le');
    await typeDebounced(host, 'lem');
    await typeDebounced(host, 'lemon');

    // Narrowing still works (proves the memoized index is real + used).
    await waitFor(() => {
      const cards = host.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
      return cards.length === 1 && cards[0]?.textContent?.includes('Lemon') ? cards : null;
    });

    expect(buildSpy.mock.calls.length).toBe(buildsAfterLoad);
  });
});
