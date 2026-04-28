// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopeFilter } from './ScopeFilter.js';

describe('ScopeFilter', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders three buttons with the literal Korean labels 전체 / 곡명 / 가수', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    render(<ScopeFilter scope="all" onChange={vi.fn()} disabled={false} />, host);
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons.length).toBe(3);
    expect(buttons[0]?.textContent?.trim()).toBe('전체');
    expect(buttons[1]?.textContent?.trim()).toBe('곡명');
    expect(buttons[2]?.textContent?.trim()).toBe('가수');
  });

  it('sets aria-checked="true" on the active scope and "false" on the others', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    render(<ScopeFilter scope="all" onChange={vi.fn()} disabled={false} />, host);
    let buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[2]?.getAttribute('aria-checked')).toBe('false');

    render(<ScopeFilter scope="title" onChange={vi.fn()} disabled={false} />, host);
    buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('true');
    expect(buttons[2]?.getAttribute('aria-checked')).toBe('false');

    render(<ScopeFilter scope="artist" onChange={vi.fn()} disabled={false} />, host);
    buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[1]?.getAttribute('aria-checked')).toBe('false');
    expect(buttons[2]?.getAttribute('aria-checked')).toBe('true');
  });

  it('fires onChange with the right scope when clicking inactive; clicking active is a no-op', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();

    render(<ScopeFilter scope="all" onChange={onChange} disabled={false} />, host);
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    // Click inactive (곡명) → fires once with 'title'.
    buttons[1]?.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('title');

    // Click inactive (가수) → fires with 'artist' (most recent).
    buttons[2]?.click();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('artist');

    // Click active (전체) → no-op.
    onChange.mockReset();
    buttons[0]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cycles focus among the three buttons with ArrowLeft / ArrowRight (wrapping)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ScopeFilter scope="all" onChange={vi.fn()} disabled={false} />, host);
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons.length).toBe(3);

    buttons[0]?.focus();
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);

    buttons[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);

    // Wrap forward.
    buttons[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    // Wrap backward.
    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('does NOT auto-activate on arrow keys (focus moves but onChange is not called)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    render(<ScopeFilter scope="all" onChange={onChange} disabled={false} />, host);
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    buttons[0]?.focus();
    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    buttons[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets tabIndex=0 on the active button and tabIndex=-1 on the others', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    render(<ScopeFilter scope="all" onChange={vi.fn()} disabled={false} />, host);
    let buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons[0]?.tabIndex).toBe(0);
    expect(buttons[1]?.tabIndex).toBe(-1);
    expect(buttons[2]?.tabIndex).toBe(-1);

    render(<ScopeFilter scope="title" onChange={vi.fn()} disabled={false} />, host);
    buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(buttons[0]?.tabIndex).toBe(-1);
    expect(buttons[1]?.tabIndex).toBe(0);
    expect(buttons[2]?.tabIndex).toBe(-1);
  });

  it('marks all buttons disabled and ignores clicks while disabled (loading)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    render(<ScopeFilter scope="all" onChange={onChange} disabled={true} />, host);
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');

    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);

    buttons[0]?.click();
    buttons[1]?.click();
    buttons[2]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
