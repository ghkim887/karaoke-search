// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as searchModule from '../lib/search.js';
import { App } from './App.js';

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

async function waitFor<T>(predicate: () => T | null | undefined, attempts = 30): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = predicate();
    if (v) return v;
    await flushPromises();
  }
  throw new Error('waitFor timed out');
}

const kick: SongRecord = {
  id: 'r2',
  title_primary: 'KICK BACK',
  title_ko: null,
  artist_primary: '米津玄師',
  artist_ko: null,
  karaoke_numbers: { tj: '67890', ky: null, joysound: null },
  source_url: 'https://example.invalid/2',
  crawled_at: '2026-04-29T00:00:00.000Z',
};

function fakeBundle(records: SongRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const index = {
    search: (q: string) => {
      const lower = q.toLowerCase();
      return records
        .filter((r) => r.title_primary.toLowerCase().includes(lower))
        .map((r) => ({ id: r.id }));
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
  } as any;
  return { index, byId };
}

describe('App offline fallback banner (T4-6)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.removeItem('karaoke-favorites:v1');
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle([kick]));
  });

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.removeItem('karaoke-favorites:v1');
  });

  function typeQuery(h: HTMLElement, value: string) {
    const input = h.querySelector<HTMLInputElement>('.search-input');
    if (!input) throw new Error('search input not found');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function mount(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App songCount={1} />, host);
    await waitFor(() => {
      const input = host.querySelector<HTMLInputElement>('.search-input');
      return input && input.disabled === false ? input : null;
    });
    return host;
  }

  it('shows the offline hint and local results when the API browse fails', async () => {
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('network down'));
    await mount();

    // No banner before any search.
    expect(host.querySelector('.fallback-notice')).toBeNull();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    // Local fallback result renders...
    const card = await waitFor(() => {
      const c = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return c?.textContent?.includes('KICK BACK') ? c : null;
    });
    expect(card).not.toBeNull();
    // ...and the offline hint appears (NOT an error state).
    const notice = await waitFor(() => host.querySelector<HTMLElement>('.fallback-notice'));
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent).toContain('오프라인');
    expect(host.querySelector('.error-state')).toBeNull();
  });

  it('does NOT show the offline hint on the healthy API path', async () => {
    vi.spyOn(searchModule, 'searchApi').mockResolvedValue([kick]);
    await mount();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => {
      const c = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return c?.textContent?.includes('KICK BACK') ? c : null;
    });
    expect(host.querySelector('.fallback-notice')).toBeNull();
  });

  it('does NOT show the offline hint on the Browse landing when a background favorites prefetch falls back', async () => {
    // Starred records exist, so the favorites prefetch runs on mount even on the
    // Browse tab; make it fail so it engages the local fallback for FAVORITES.
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r2']));
    const fetchSpy = vi
      .spyOn(searchModule, 'fetchSongsByIds')
      .mockRejectedValue(new Error('network down'));
    // Browse itself is healthy and nothing is searched — the landing is shown.
    vi.spyOn(searchModule, 'searchApi').mockResolvedValue([kick]);
    await mount();

    // Let the background favorites prefetch fail and engage the fallback corpus.
    await waitFor(() => (fetchSpy.mock.calls.length > 0 ? true : null));
    await flushPromises();
    await flushPromises();

    // The Browse landing shows the featured-artist empty state and NO banner —
    // nothing fallback-served is displayed in the active view.
    expect(host.querySelector('.empty-state')).not.toBeNull();
    expect(host.querySelector('.fallback-notice')).toBeNull();
  });

  it('shows the offline hint for fallback-served Browse results even when the favorites prefetch also failed', async () => {
    // Both paths fail: the favorites prefetch (background) AND the browse search
    // the user actually runs. The banner must reflect the DISPLAYED (browse)
    // results, so it appears — proving the scoping is per-view, not a global off.
    localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r2']));
    vi.spyOn(searchModule, 'fetchSongsByIds').mockRejectedValue(new Error('down'));
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('network down'));
    await mount();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeQuery(host, 'kick');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    await waitFor(() => {
      const c = host.querySelector<HTMLElement>('[data-testid="result-card"]');
      return c?.textContent?.includes('KICK BACK') ? c : null;
    });
    const notice = await waitFor(() => host.querySelector<HTMLElement>('.fallback-notice'));
    expect(notice).not.toBeNull();
  });
});
