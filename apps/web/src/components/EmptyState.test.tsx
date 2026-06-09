// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState.js';

describe('EmptyState featured-artist section', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders a single unlabeled featured-artist section with chips', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmptyState onPickArtist={() => {}} />, host);
    // Flattened landing: one section, no category section titles.
    expect(host.querySelectorAll('.empty-section').length).toBe(1);
    expect(host.querySelectorAll('.empty-section-title').length).toBe(0);
    // Featured chips render.
    expect(host.querySelectorAll('.empty-section-chips .chip').length).toBeGreaterThan(0);
  });

  it('uses the searchable query when a display label contains artist metadata', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onPickArtist = vi.fn();

    render(<EmptyState onPickArtist={onPickArtist} />, host);
    const jinChip = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'じん｜自然の敵P',
    );

    expect(jinChip).toBeDefined();
    jinChip?.click();
    expect(onPickArtist).toHaveBeenCalledWith('じん');
  });
});
