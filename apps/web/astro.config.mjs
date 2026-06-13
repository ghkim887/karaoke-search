import preact from '@astrojs/preact';
import { defineConfig } from 'astro/config';

const site = process.env.PUBLIC_SITE_URL ?? 'https://ghkim887.github.io';
const base = process.env.PUBLIC_BASE_PATH ?? '/karaoke-search/';

// https://astro.build/config
export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [preact()],
});
