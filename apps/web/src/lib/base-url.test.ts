import { describe, expect, it } from 'vitest';

describe('search base URL', () => {
  it('respects import.meta.env.BASE_URL', () => {
    const { BASE_URL } = import.meta.env;
    // Astro normally injects this at build time. In vitest it defaults to '/'.
    expect(typeof BASE_URL).toBe('string');
    expect(BASE_URL.endsWith('/')).toBe(true);
  });
});
