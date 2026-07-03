import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

/**
 * Custom service worker (T4-6), built via `injectManifest` rather than
 * `generateSW`. It is bundled to a single file by Vite — deliberately, because
 * `generateSW`'s AMD/`importScripts` split-chunk output failed to run the
 * runtime `registerRoute` handlers in this project (only the precache served),
 * so `songs.json` was never runtime-cached and the offline fallback had no data.
 * A single bundled worker makes the runtime routes fire reliably.
 *
 * Behaviour mirrors the intended config:
 *  - Precache the app shell (`self.__WB_MANIFEST`, injected at build time with
 *    per-asset revisions). The corpus JSON and the oversized ext font subset are
 *    excluded from the manifest (see injectManifest globs in astro.config.mjs).
 *  - autoUpdate: skipWaiting + clientsClaim so a new build takes over promptly.
 *  - Runtime cache the corpus (CacheFirst, 7-day TTL ≈ weekly crawl cadence) and
 *    any font subset (CacheFirst, 30-day TTL).
 */
declare const self: ServiceWorkerGlobalScope & {
  // Injected at build time by vite-plugin-pwa's injectManifest with the
  // precache entries (url + content revision).
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Offline reloads / deep links with no precache match fall back to the precached
// shell. The single page is precached under the site base ('/') — the
// @vite-pwa/astro manifest transform rewrites index.html to the scope — so the
// handler is bound to '/'. API calls are fetch/XHR (not navigations), so the
// denylist is a guard.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/'), {
    denylist: [/^\/api\//],
  }),
);

// The offline-fallback corpus. CacheFirst avoids re-downloading the ~10 MB
// payload on every fetch; the 7-day expiration matches the weekly crawl so a
// cached entry is at most one crawl behind before the next fetch refreshes it.
registerRoute(
  /\/data\/songs\.json$/,
  new CacheFirst({
    cacheName: 'karaoke-corpus',
    plugins: [
      new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
  'GET',
);

// Font subsets (notably the oversized ext subset excluded from the precache).
// Fonts are immutable at a stable URL, so CacheFirst with a long TTL caches each
// subset on first use for subsequent offline rendering.
registerRoute(
  /\/fonts\/.*\.woff2$/,
  new CacheFirst({
    cacheName: 'karaoke-fonts',
    plugins: [
      new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
  'GET',
);
