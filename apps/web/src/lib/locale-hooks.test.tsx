// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLocaleStore } from './locale-hooks.js';
import { LOCALE_STORAGE_KEY, getLocale, getServerLocale, setLocale } from './locale-store.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor timed out');
}

// Records the value returned by useLocaleStore on every render, so we can
// assert what the FIRST client render produced.
function Probe({ sink }: { sink: string[] }) {
  const locale = useLocaleStore();
  sink.push(locale);
  return <span data-testid="probe">{locale}</span>;
}

describe('useLocaleStore hydration behaviour', () => {
  let host: HTMLElement;

  beforeEach(() => {
    if (getLocale() !== 'ko') setLocale('ko');
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    render(null, host);
    if (host.parentNode) host.parentNode.removeChild(host);
    if (getLocale() !== 'ko') setLocale('ko');
    localStorage.removeItem(LOCALE_STORAGE_KEY);
  });

  it('first render equals the server snapshot (ko) even when a non-ko locale is stored', async () => {
    // A returning ja user: the store already holds ja before mount.
    setLocale('ja');
    expect(getLocale()).toBe('ja');

    const sink: string[] = [];
    render(<Probe sink={sink} />, host);

    // The first client render MUST match the SSR shell (ko) so hydration can
    // patch SSR attributes on the subsequent diff. If this regresses to seeding
    // from the stored locale, aria-labels rendered at SSR stay Korean.
    expect(sink[0]).toBe(getServerLocale());
    expect(sink[0]).toBe('ko');

    // After the mount effect the hook adopts the stored locale and re-renders.
    await waitFor(() => host.querySelector('[data-testid="probe"]')?.textContent === 'ja');
    expect(sink.at(-1)).toBe('ja');
  });

  it('stays on ko (no extra committed value) for the default user', async () => {
    const sink: string[] = [];
    render(<Probe sink={sink} />, host);
    expect(sink[0]).toBe('ko');
    await tick();
    // Adopting ko-over-ko is a no-op; the rendered value never leaves ko.
    expect(host.querySelector('[data-testid="probe"]')?.textContent).toBe('ko');
    expect(new Set(sink)).toEqual(new Set(['ko']));
  });
});
