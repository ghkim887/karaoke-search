// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY, getLocale, setLocale } from '../lib/locale-store.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';

// Preact commits state updates on a microtask and runs effects a frame later; a
// setTimeout(0) turn flushes a re-render, and polling covers focus effects.
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor timed out');
}

function getButton(host: HTMLElement): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>('.lang-switcher-button');
  if (!btn) throw new Error('switcher button not found');
  return btn;
}

function getMenuItems(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
}

describe('LanguageSwitcher', () => {
  let host: HTMLElement;

  beforeEach(() => {
    // Force the shared store back to the Korean default before each test.
    if (getLocale() !== 'ko') setLocale('ko');
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    render(null, host); // unmount → detaches the store subscription
    if (host.parentNode) host.parentNode.removeChild(host);
    if (getLocale() !== 'ko') setLocale('ko');
    localStorage.removeItem(LOCALE_STORAGE_KEY);
  });

  it('renders a collapsed menu-button trigger showing the current endonym', () => {
    render(<LanguageSwitcher />, host);
    const btn = getButton(host);
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain('한국어');
    // Popup is not in the DOM while collapsed.
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens the menu on click with one checked item per the active locale', async () => {
    render(<LanguageSwitcher />, host);
    const btn = getButton(host);
    btn.click();
    await waitFor(() => host.querySelector('[role="menu"]') !== null);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const menu = host.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBeTruthy();

    const items = getMenuItems(host);
    expect(items.map((i) => i.textContent)).toEqual(['한국어', 'English', '日本語']);
    // Only the Korean (active) item is checked.
    const checked = items.filter((i) => i.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toBe('한국어');
    // Each item is tagged with its own language for correct pronunciation.
    expect(items[2]?.getAttribute('lang')).toBe('ja');
  });

  it('selecting a language persists it, updates the trigger, and closes the menu', async () => {
    render(<LanguageSwitcher />, host);
    getButton(host).click();
    await waitFor(() => getMenuItems(host).length === 3);

    getMenuItems(host)
      .find((i) => i.textContent === '日本語')
      ?.click();
    await waitFor(() => host.querySelector('[role="menu"]') === null);

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ja');
    expect(getLocale()).toBe('ja');
    const btn = getButton(host);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain('日本語');
  });

  it('reflects a pre-existing store value on first render', () => {
    setLocale('en');
    render(<LanguageSwitcher />, host);
    expect(getButton(host).textContent).toContain('English');
  });

  it('opens via ArrowDown and moves focus between items with the arrow keys', async () => {
    render(<LanguageSwitcher />, host);
    const btn = getButton(host);
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    // Opened focusing the selected (Korean, index 0) item.
    await waitFor(() => document.activeElement === getMenuItems(host)[0]);
    const items = getMenuItems(host);
    expect(items).toHaveLength(3);

    items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    // Wraps from the first item to the last on ArrowUp.
    items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[2]);
  });

  it('selects the focused item with Enter', async () => {
    render(<LanguageSwitcher />, host);
    getButton(host).click();
    await waitFor(() => getMenuItems(host).length === 3);

    getMenuItems(host)[1]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await waitFor(() => getLocale() === 'en');
    expect(getButton(host).textContent).toContain('English');
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    render(<LanguageSwitcher />, host);
    getButton(host).click();
    // Wait until the open-focus effect has settled (focus on the active item)
    // so it can't race the trigger re-focus below.
    await waitFor(() => document.activeElement === getMenuItems(host)[0]);

    getMenuItems(host)[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await waitFor(() => host.querySelector('[role="menu"]') === null);
    expect(document.activeElement).toBe(getButton(host));
  });

  it('closes when clicking outside the switcher', async () => {
    render(<LanguageSwitcher />, host);
    getButton(host).click();
    // Waiting for the focus effect also guarantees the sibling outside-click
    // listener effect has attached before we dispatch the outside mousedown.
    await waitFor(() => document.activeElement === getMenuItems(host)[0]);

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await waitFor(() => host.querySelector('[role="menu"]') === null);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
