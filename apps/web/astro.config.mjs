import preact from '@astrojs/preact';
import AstroPWA from '@vite-pwa/astro';
import { defineConfig } from 'astro/config';

const site = process.env.PUBLIC_SITE_URL ?? 'https://karaokedb.pages.dev';
const base = process.env.PUBLIC_BASE_PATH ?? '/';

// https://astro.build/config
export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [
    preact(),
    AstroPWA({
      // autoUpdate: a freshly built service worker takes over as soon as it
      // activates (skipWaiting + clientsClaim in src/sw.ts), so users are never
      // stuck on a stale app shell across the weekly deploy cadence. No update
      // prompt UI is needed for a single-screen search app.
      registerType: 'autoUpdate',
      // injectManifest (hand-written src/sw.ts) instead of generateSW: the
      // generated worker's split-chunk output did not run its runtime route
      // handlers here, leaving songs.json un-cached for the offline fallback.
      // A single bundled worker fixes that; see src/sw.ts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The SW + registration are emitted only by `astro build`; `astro dev`
      // never registers one (avoids a stale-cache foot-gun during development).
      devOptions: { enabled: false },
      injectRegister: 'auto',
      manifest: {
        name: '일본 노래 검색기 / Karaoke Search',
        short_name: '노래 검색',
        description:
          '노래방 곡 번호를 오프라인에서도 검색하세요. / Search karaoke song numbers, even offline.',
        lang: 'ko',
        theme_color: '#191c1f',
        background_color: '#191c1f',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // App-shell precache: hashed HTML/JS/CSS/font-subset/icon assets. Two
        // deliberate exclusions (runtime-cached in src/sw.ts instead, so a SW
        // update never forces a multi-MB re-download):
        //   - /data/*.json (songs.json ≈ 10 MB, tj-search-cache.json)
        //   - the rare-CJK-ext font subset (≈ 4 MB, over Workbox's 2 MiB cap).
        //     The common latin/hangul/kana/kanji subsets (~1.7 MB total) ARE
        //     precached so offline text renders; the ext subset covers rare
        //     glyphs and is fetched + runtime-cached on first use.
        globPatterns: ['**/*.{html,js,css,woff2,svg,png}'],
        globIgnores: ['**/data/**', '**/fonts/pretendard-jp-ext.woff2'],
      },
    }),
  ],
});
