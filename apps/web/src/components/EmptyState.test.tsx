// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.js';

const recA: SongRecord = {
  id: 'tj-1',
  title_primary: 'Idol',
  title_ko: '아이돌',
  artist_primary: 'YOASOBI',
  artist_ko: '요아소비',
  categories: ['jpop'],
  karaoke_numbers: { tj: '12345', ky: null, joysound: null },
  source_url: 'https://example.invalid/a',
};

const recB: SongRecord = {
  id: 'tj-2',
  title_primary: 'KICK BACK',
  title_ko: null,
  artist_primary: '米津玄師',
  artist_ko: null,
  categories: ['jpop', 'anime'],
  karaoke_numbers: { tj: '67890', ky: null, joysound: null },
  source_url: 'https://example.invalid/b',
};

describe('EmptyState favorites surfacing', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('does not render a favorites section when favoriteIds is empty', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={[]}
        byId={new Map()}
        isFavorite={() => false}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    expect(host.querySelector('.empty-favorites-section')).toBeNull();
  });

  it('renders a favorites section first with N cards in newest-first order', () => {
    const byId = new Map<string, SongRecord>();
    byId.set(recA.id, recA);
    byId.set(recB.id, recB);
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={[recB.id, recA.id]}
        byId={byId}
        isFavorite={(id) => id === recB.id || id === recA.id}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const section = host.querySelector('.empty-favorites-section');
    expect(section).not.toBeNull();
    const cards = section?.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards?.length).toBe(2);
    // Newest-first: recB before recA.
    expect(cards?.[0]?.textContent).toContain('KICK BACK');
    expect(cards?.[1]?.textContent).toContain('Idol');
    // Title contains the count.
    const title = section?.querySelector('.empty-favorites-title');
    expect(title?.textContent).toContain('(2)');
  });

  it('silently skips ids that no longer exist in the loaded corpus', () => {
    const byId = new Map<string, SongRecord>();
    byId.set(recA.id, recA);
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={['stale-id', recA.id]}
        byId={byId}
        isFavorite={(id) => id === recA.id}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const cards = host.querySelectorAll('[data-testid="result-card"]');
    // Only recA renders; stale-id is silently skipped.
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
  });
});
