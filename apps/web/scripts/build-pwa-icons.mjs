#!/usr/bin/env node
// PWA icon generator. Rasterizes a single microphone glyph — drawn only from
// the design-token palette (DESIGN.md §2: Revolut Dark #191c1f background,
// Ghost-on-Dark #f4f4f4 foreground) — into the manifest icon set. There was no
// pre-existing favicon/logo asset in the repo, so the mark is derived from the
// design tokens rather than a bitmap source.
//
// Rendering is done with the Playwright Chromium already present for e2e (no
// new raster dependency): an inline SVG is loaded at the exact target pixel
// size and screenshotted at deviceScaleFactor 1.
//
// Outputs (public/icons + public/favicon.svg):
//   icon-192.png, icon-512.png             — purpose "any" (mic fills the frame)
//   icon-maskable-192.png, icon-maskable-512.png — purpose "maskable" (mic
//     scaled to 60% and centered so it stays inside the maskable safe zone, the
//     ~80%-diameter circle platforms may crop to a squircle/circle)
//   favicon.svg                            — the same mark, vector
//
// Re-run with: `node scripts/build-pwa-icons.mjs` (idempotent).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BG = '#191c1f'; // DESIGN.md §2 Revolut Dark (Primary)
const FG = '#f4f4f4'; // DESIGN.md §4 Ghost-on-Dark foreground

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'public', 'icons');
const publicDir = resolve(__dirname, '..', 'public');

/** The microphone mark, centered on a 512 canvas. `scale` shrinks the mark
 *  toward the center (1 = full "any" size; <1 for the maskable safe zone). */
function mark(scale) {
  return `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <rect x="196" y="96" width="120" height="200" rx="60" fill="${FG}" />
    <path d="M150 236 a106 106 0 0 0 212 0" fill="none" stroke="${FG}" stroke-width="26" stroke-linecap="round" />
    <rect x="243" y="342" width="26" height="74" rx="13" fill="${FG}" />
    <rect x="188" y="404" width="136" height="26" rx="13" fill="${FG}" />
  </g>`;
}

function svg({ maskable }) {
  // Maskable icons must be full-bleed (the platform applies its own mask), so
  // the background is a plain square. "any" icons use the same full square for
  // a consistent silhouette across launchers.
  const inner = maskable ? mark(0.6) : mark(0.82);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" fill="${BG}" />
    ${inner}
  </svg>`;
}

async function renderPng(page, svgMarkup, size, outPath) {
  await page.setViewportSize({ width: size, height: size });
  // Inline the SVG directly (no nested data URL) so Chromium renders the vector
  // markup verbatim; CSS pins the root <svg> to the exact target pixel box.
  await page.setContent(
    `<!doctype html><html><head><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svgMarkup}</body></html>`,
  );
  const buf = await page.screenshot({ omitBackground: false });
  writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${size}x${size})`);
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });

  const anySvg = svg({ maskable: false });
  const maskableSvg = svg({ maskable: true });

  writeFileSync(resolve(publicDir, 'favicon.svg'), anySvg);
  console.log(`wrote ${resolve(publicDir, 'favicon.svg')}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    await renderPng(page, anySvg, 192, resolve(iconsDir, 'icon-192.png'));
    await renderPng(page, anySvg, 512, resolve(iconsDir, 'icon-512.png'));
    await renderPng(page, maskableSvg, 192, resolve(iconsDir, 'icon-maskable-192.png'));
    await renderPng(page, maskableSvg, 512, resolve(iconsDir, 'icon-maskable-512.png'));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
