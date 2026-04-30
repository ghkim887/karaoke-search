// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFavorites } from './favorites.js';

const STORAGE_KEY = 'karaoke-favorites:v1';

interface Probe {
  current: ReturnType<typeof useFavorites> | null;
}

function HookHost({ probe }: { probe: Probe }) {
  const fav = useFavorites();
  probe.current = fav;
  return null;
}

function mountHook(): { probe: Probe; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const probe: Probe = { current: null };
  render(<HookHost probe={probe} />, host);
  return { probe, host };
}

function unmount(host: HTMLElement): void {
  // Preact unmount: render `null` to the host. Type cast suppresses TS noise.
  render(null as unknown as Parameters<typeof render>[0], host);
  host.parentNode?.removeChild(host);
}

describe('useFavorites', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with an empty favorites set when localStorage is empty', () => {
    const { probe, host } = mountHook();
    expect(probe.current?.orderedIds.length).toBe(0);
    expect(probe.current?.isFavorite('tj-100')).toBe(false);
    unmount(host);
  });

  it('toggle adds a new id and persists', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('tj-100');
    unmount(host);
    const { probe: probe2, host: host2 } = mountHook();
    expect(probe2.current?.isFavorite('tj-100')).toBe(true);
    expect(probe2.current?.orderedIds.length).toBe(1);
    unmount(host2);
  });

  it('toggle on an existing id removes it', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['tj-100', 'tj-200']));
    const { probe, host } = mountHook();
    probe.current?.toggle('tj-100');
    // Preact batches state updates and re-renders on the next tick; wait so
    // the post-toggle snapshot is committed to `probe.current`.
    await new Promise((r) => setTimeout(r, 0));
    expect(probe.current?.isFavorite('tj-100')).toBe(false);
    expect(probe.current?.isFavorite('tj-200')).toBe(true);
    unmount(host);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['tj-200']);
  });

  it('preserves newest-first ordering on the array form', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('a');
    probe.current?.toggle('b');
    probe.current?.toggle('c');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['c', 'b', 'a']);
    unmount(host);
  });

  it('uses the versioned key "karaoke-favorites:v1"', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('x');
    expect(localStorage.getItem('karaoke-favorites:v1')).not.toBeNull();
    expect(localStorage.getItem('karaoke-favorites')).toBeNull();
    unmount(host);
  });
});
