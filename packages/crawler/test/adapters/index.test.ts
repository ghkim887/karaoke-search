import { describe, expect, it } from 'vitest';
import { adapters } from '../../src/adapters/index.js';

describe('adapters registry', () => {
  it('includes the joysound-official adapter (CLI --source slug)', () => {
    const names = adapters.map((a) => a.name);
    expect(names).toContain('joysound-official');
  });

  it('includes the existing jpop-playlist-blog and tj-media-direct adapters too', () => {
    const names = adapters.map((a) => a.name);
    expect(names).toContain('jpop-playlist-blog');
    expect(names).toContain('tj-media-direct');
  });
});
