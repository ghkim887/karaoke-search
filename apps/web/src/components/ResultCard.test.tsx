// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultCard } from './ResultCard.js';

const sample: SongRecord = {
  id: 'tj-1',
  title_primary: 'Idol',
  title_ko: '아이돌',
  artist_primary: 'YOASOBI',
  artist_ko: '요아소비',
  categories: ['jpop'],
  karaoke_numbers: { tj: '12345', ky: null, joysound: null },
  source_url: 'https://example.invalid/yoasobi',
  crawled_at: '2026-04-29T00:00:00.000Z',
};

describe('ResultCard favorite-star', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders an outline star with aria-pressed=false when not favorited', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={sample} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    expect(star).not.toBeNull();
    expect(star?.getAttribute('aria-pressed')).toBe('false');
    expect(star?.textContent).toContain('☆');
  });

  it('renders a filled star with aria-pressed=true when favorited', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={sample} isFavorite={true} onToggleFavorite={() => {}} />, host);
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    expect(star?.getAttribute('aria-pressed')).toBe('true');
    expect(star?.textContent).toContain('★');
  });

  it('invokes onToggleFavorite with the record id on click', () => {
    const onToggle = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={sample} isFavorite={false} onToggleFavorite={onToggle} />, host);
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    star?.click();
    expect(onToggle).toHaveBeenCalledWith('tj-1');
  });
});
