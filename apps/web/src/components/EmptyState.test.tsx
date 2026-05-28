// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState.js';

describe('EmptyState featured-artist sections', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the three featured-artist sections (J-POP, Vocaloid, Anime)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmptyState onPickArtist={() => {}} />, host);
    const titles = host.querySelectorAll('.empty-section-title');
    expect(titles.length).toBe(3);
    expect(titles[0]?.textContent).toContain('J-POP');
    expect(titles[1]?.textContent).toContain('Vocaloid');
    expect(titles[2]?.textContent).toContain('Anime');
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
