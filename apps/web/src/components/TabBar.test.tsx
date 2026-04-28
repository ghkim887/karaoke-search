// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabBar } from './TabBar.js';

describe('TabBar', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders Browse label exactly "검색" and Favorites label exactly "즐겨찾기" regardless of favoriteCount', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    // First render: favoriteCount = 0.
    render(
      <TabBar activeTab="browse" onChange={() => {}} favoriteCount={0} disabled={false} />,
      host,
    );
    let tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.textContent?.trim()).toBe('검색');
    expect(tabs[1]?.textContent?.trim()).toBe('즐겨찾기');

    // Re-render: favoriteCount = 42 — labels must NOT change.
    render(
      <TabBar activeTab="browse" onChange={() => {}} favoriteCount={42} disabled={false} />,
      host,
    );
    tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]?.textContent?.trim()).toBe('검색');
    expect(tabs[1]?.textContent?.trim()).toBe('즐겨찾기');
  });

  it('sets aria-selected="true" on the active tab and "false" on the inactive tab', () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    render(
      <TabBar activeTab="browse" onChange={() => {}} favoriteCount={0} disabled={false} />,
      host,
    );
    let tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');

    render(
      <TabBar activeTab="favorites" onChange={() => {}} favoriteCount={0} disabled={false} />,
      host,
    );
    tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('fires onChange with the right id when clicking the inactive tab; clicking the active tab is a no-op', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();

    render(
      <TabBar activeTab="browse" onChange={onChange} favoriteCount={0} disabled={false} />,
      host,
    );
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    // Click inactive (Favorites) → fires once with 'favorites'.
    tabs[1]?.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('favorites');

    // Click active (Browse) → no-op.
    onChange.mockReset();
    tabs[0]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cycles focus between the two buttons with ArrowLeft / ArrowRight', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <TabBar activeTab="browse" onChange={() => {}} favoriteCount={0} disabled={false} />,
      host,
    );
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(2);

    tabs[0]?.focus();
    expect(document.activeElement).toBe(tabs[0]);

    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);

    tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('marks both buttons as disabled and ignores clicks while disabled (loading state)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    render(
      <TabBar activeTab="browse" onChange={onChange} favoriteCount={0} disabled={true} />,
      host,
    );
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]?.disabled).toBe(true);
    expect(tabs[1]?.disabled).toBe(true);

    tabs[0]?.click();
    tabs[1]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the wrapper as div role="tablist" with an aria-label', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <TabBar activeTab="browse" onChange={() => {}} favoriteCount={0} disabled={false} />,
      host,
    );
    const list = host.querySelector('[role="tablist"]');
    expect(list).not.toBeNull();
    expect(list?.tagName).toBe('DIV');
    expect(list?.getAttribute('aria-label')).toBeTruthy();
  });
});
