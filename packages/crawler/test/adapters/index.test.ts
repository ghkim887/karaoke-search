import { describe, expect, it } from 'vitest';
import { adapters, resolveAdaptersForSources } from '../../src/adapters/index.js';

describe('adapters registry', () => {
  it('excludes the joysound-official adapter from the DEFAULT run set (opt-in only)', () => {
    const names = adapters.map((a) => a.name);
    expect(names).not.toContain('joysound-official');
  });

  it('includes the existing jpop-playlist-blog and tj-media-direct adapters', () => {
    const names = adapters.map((a) => a.name);
    expect(names).toContain('jpop-playlist-blog');
    expect(names).toContain('tj-media-direct');
  });
});

describe('resolveAdaptersForSources — --source resolution', () => {
  it('returns the default set (blog + tj, no joysound) when no sources are given', () => {
    const names = resolveAdaptersForSources([]).map((a) => a.name);
    expect(names).toContain('jpop-playlist-blog');
    expect(names).toContain('tj-media-direct');
    expect(names).not.toContain('joysound-official');
  });

  it('resolves --source joysound-official even though it is not in the default set', () => {
    const selected = resolveAdaptersForSources(['joysound-official']);
    const names = selected.map((a) => a.name);
    expect(names).toEqual(['joysound-official']);
  });

  it('resolves a default-set source by name', () => {
    const selected = resolveAdaptersForSources(['tj-media-direct']);
    expect(selected.map((a) => a.name)).toEqual(['tj-media-direct']);
  });

  it('resolves a mix of default-set and opt-in sources', () => {
    const names = resolveAdaptersForSources(['jpop-playlist-blog', 'joysound-official']).map(
      (a) => a.name,
    );
    expect(names).toContain('jpop-playlist-blog');
    expect(names).toContain('joysound-official');
  });

  it('throws on an unknown source slug', () => {
    expect(() => resolveAdaptersForSources(['no-such-source'])).toThrow(/no-such-source/);
  });
});
