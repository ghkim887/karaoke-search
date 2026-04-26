import preact from '@astrojs/preact';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://ghkim887.github.io',
  base: '/karaoke-search/',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [preact()],
});
