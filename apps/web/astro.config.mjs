import preact from '@astrojs/preact';
import { defineConfig } from 'astro/config';

const site = process.env.PUBLIC_SITE_URL ?? 'https://karaokedb.pages.dev';
const base = process.env.PUBLIC_BASE_PATH ?? '/';

// https://astro.build/config
export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [preact()],
});
