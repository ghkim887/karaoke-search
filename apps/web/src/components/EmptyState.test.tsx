// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
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
});
