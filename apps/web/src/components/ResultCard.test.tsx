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

describe('ResultCard artist_aliases display (spec 2026-05-04)', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  function makeRecord(over: Partial<SongRecord>): SongRecord {
    return {
      id: 'alias-card-0',
      source_url: 'https://example.test/0',
      title_primary: 'Song',
      title_ko: null,
      artist_primary: 'スピッツ',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-05-04T00:00:00Z',
      ...over,
    };
  }

  it('renders "スピッツ (Spitz) — 스피츠" when artist_aliases + artist_ko both present', () => {
    const r = makeRecord({
      artist_primary: 'スピッツ',
      artist_ko: '스피츠',
      artist_aliases: ['Spitz'],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={r} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const artist = host.querySelector('.result-artist');
    expect(artist?.textContent).toBe('スピッツ (Spitz) — 스피츠');
  });

  it('renders "スピッツ — 스피츠" (unchanged behavior) with empty artist_aliases array', () => {
    const r = makeRecord({
      artist_primary: 'スピッツ',
      artist_ko: '스피츠',
      artist_aliases: [],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={r} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const artist = host.querySelector('.result-artist');
    expect(artist?.textContent).toBe('スピッツ — 스피츠');
  });

  it('renders canonical only (no parens, no em-dash) when no artist_aliases and no artist_ko', () => {
    const r = makeRecord({
      artist_primary: 'BUMP OF CHICKEN',
      artist_ko: null,
      // No artist_aliases.
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={r} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const artist = host.querySelector('.result-artist');
    expect(artist?.textContent).toBe('BUMP OF CHICKEN');
  });

  it('joins multiple aliases with ", " (preserves canonical order, no sort)', () => {
    const r = makeRecord({
      artist_primary: '40mP',
      artist_ko: null,
      artist_aliases: ['40meterP', 'M40'],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={r} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const artist = host.querySelector('.result-artist');
    expect(artist?.textContent).toBe('40mP (40meterP, M40)');
  });
});

describe('ResultCard — media_context_ko', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders title_ko and media_context_ko side by side when both set', () => {
    const record: SongRecord = {
      id: 'tj-1',
      source_url: 'https://x.test',
      title_primary: '君が好きだと叫びたい',
      title_ko: '네가 좋다고 외치고 싶어',
      artist_primary: 'BAAD',
      artist_ko: null,
      karaoke_numbers: { tj: '1234', ky: null, joysound: null },
      categories: ['anime'],
      crawled_at: '2026-05-06T00:00:00.000Z',
      media_context_ko: '(슬램덩크 OP)',
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={record} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const text = host.textContent ?? '';
    expect(text).toContain('네가 좋다고 외치고 싶어');
    expect(text).toContain('(슬램덩크 OP)');
  });

  it('renders only media_context_ko when title_ko is null', () => {
    const record: SongRecord = {
      id: 'tj-2',
      source_url: 'https://x.test',
      title_primary: 'Butter-Fly',
      title_ko: null,
      artist_primary: '和田光司',
      artist_ko: null,
      karaoke_numbers: { tj: '5678', ky: null, joysound: null },
      categories: ['anime'],
      crawled_at: '2026-05-06T00:00:00.000Z',
      media_context_ko: '(디지몬 어드벤처 OP)',
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={record} isFavorite={false} onToggleFavorite={() => {}} />, host);
    expect(host.textContent ?? '').toContain('(디지몬 어드벤처 OP)');
  });

  it('does not duplicate when media_context_ko is already a substring of title_ko', () => {
    const record: SongRecord = {
      id: 'blog-1',
      source_url: 'https://x.test',
      title_primary: '光',
      title_ko: '빛 (진격의 거인 OP)',
      artist_primary: 'X',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['anime'],
      crawled_at: '2026-05-06T00:00:00.000Z',
      media_context_ko: '(진격의 거인 OP)',
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<ResultCard record={record} isFavorite={false} onToggleFavorite={() => {}} />, host);
    const occurrences = (host.textContent ?? '').match(/\(진격의 거인 OP\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});
