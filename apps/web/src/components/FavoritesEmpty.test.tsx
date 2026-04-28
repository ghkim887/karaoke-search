// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { FavoritesEmpty } from './FavoritesEmpty.js';

describe('FavoritesEmpty', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the bilingual placeholder text (Korean + English) in a single paragraph', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<FavoritesEmpty />, host);
    const text = host.querySelector('.favorites-empty')?.textContent ?? '';
    expect(text).toContain('즐겨찾기가 아직 없어요');
    expect(text).toContain('No favorites yet — tap ★ on a result to add one');
  });

  it('mentions the ★ glyph in the instruction', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<FavoritesEmpty />, host);
    const text = host.querySelector('.favorites-empty')?.textContent ?? '';
    expect(text).toMatch(/★/);
  });
});
