// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CategoryChips, type CategoryFilter } from './CategoryChips.js';

describe('CategoryChips (single-select radiogroup)', () => {
  let host: HTMLElement;

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  function mount(initial: CategoryFilter): {
    host: HTMLElement;
    onChange: ReturnType<typeof vi.fn>;
    rerender: (next: CategoryFilter) => void;
  } {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    const rerender = (next: CategoryFilter) => {
      render(<CategoryChips selected={next} onChange={onChange} />, host);
    };
    rerender(initial);
    return { host, onChange, rerender };
  }

  function chips(h: HTMLElement): HTMLButtonElement[] {
    return Array.from(h.querySelectorAll<HTMLButtonElement>('.chip-group .chip'));
  }

  it('renders four chips with 전체 leftmost, then J-POP / Vocaloid / Anime', () => {
    const { host } = mount('all');
    const labels = chips(host).map((c) => c.textContent?.trim());
    expect(labels).toEqual(['전체', 'J-POP', 'Vocaloid', 'Anime']);
  });

  it('uses radiogroup semantics with an aria-label on the group', () => {
    const { host } = mount('all');
    const group = host.querySelector('.chip-group');
    expect(group?.getAttribute('role')).toBe('radiogroup');
    expect(group?.getAttribute('aria-label')).toBe('카테고리 필터');
    for (const chip of chips(host)) {
      expect(chip.getAttribute('role')).toBe('radio');
    }
  });

  it("defaults to 전체 active (aria-checked='true' + chip-selected) when selected='all'", () => {
    const { host } = mount('all');
    const [all, jpop, vocaloid, anime] = chips(host);
    expect(all?.getAttribute('aria-checked')).toBe('true');
    expect(all?.classList.contains('chip-selected')).toBe(true);
    for (const inactive of [jpop, vocaloid, anime]) {
      expect(inactive?.getAttribute('aria-checked')).toBe('false');
      expect(inactive?.classList.contains('chip-selected')).toBe(false);
    }
  });

  it('clicking J-POP fires onChange("jpop")', () => {
    const { host, onChange } = mount('all');
    const jpop = chips(host)[1];
    jpop?.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('jpop');
  });

  it("when selected='jpop' only J-POP renders active (single-select switching)", () => {
    const { host } = mount('jpop');
    const [all, jpop, vocaloid, anime] = chips(host);
    expect(jpop?.getAttribute('aria-checked')).toBe('true');
    expect(jpop?.classList.contains('chip-selected')).toBe(true);
    for (const inactive of [all, vocaloid, anime]) {
      expect(inactive?.getAttribute('aria-checked')).toBe('false');
      expect(inactive?.classList.contains('chip-selected')).toBe(false);
    }
  });

  it('clicking 전체 from a category-active state fires onChange("all")', () => {
    const { host, onChange } = mount('vocaloid');
    const all = chips(host)[0];
    all?.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('ArrowRight from focused 전체 moves focus to J-POP and fires onChange("jpop")', () => {
    const { host, onChange } = mount('all');
    const [all, jpop] = chips(host);
    all?.focus();
    all?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('jpop');
    expect(document.activeElement).toBe(jpop);
  });
});
