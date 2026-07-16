#!/usr/bin/env node
/**
 * Build the KY curated title-recovery map from the KYSing anisong book (42탄).
 *
 * Why (R5 KY adapter, D2 revision, owner decision 2026-07-16): the live KY
 * karaoke-book index and its `category=1` detail page apply the SAME fixed-width
 * server-side truncation, so the per-row detail fetch recovered a full title in
 * only 0.37% of attempts (run2: 1/270) — pure wasted requests. The detail-fetch
 * repair path is removed; instead, truncated index rows are recovered from a
 * COMMITTED lookup map built here from the anisong book's full-title listing.
 *
 * Source: the KYSing anisong book 42탄 static HTML — an `<article class=
 * "song-card">` per song with `.song-no` / `.song-title` / `.artist-name`
 * (full, non-truncated). Pass a local copy with `--html <path>` (no network);
 * absent that, the script fetches {@link DEFAULT_SOURCE_URL} once. The 1.3MB
 * HTML original is NOT committed — only this script and its JSON output are.
 *
 * The map holds ALL anisong-book songs (truncation-agnostic — the lookup only
 * fires on truncated index rows) plus the hand-confirmed manual entries in
 * {@link MANUAL_ENTRIES}. Output is a `{ ky: { title, artist, source } }` object
 * with numerically-sorted keys for stable diffs.
 *
 * Integrity (enforced here so the committed data is always clean): every key is
 * bare digits; every title/artist is non-empty and contains no `..` truncation
 * sentinel. A row failing any check is skipped with a warning.
 *
 * Usage:
 *   node scripts/build-ky-title-recovery.mjs --html <anibook42.html> [--out <path>]
 *   node scripts/build-ky-title-recovery.mjs            # fetches DEFAULT_SOURCE_URL
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DEFAULT_OUT = resolve(
  REPO_ROOT,
  'packages/crawler/src/adapters/ky-kysing/curated-title-recovery.json',
);
const DEFAULT_SOURCE_URL = 'https://kysing.kr/wp-content/uploads/2026/07/애니송북42탄-여름호.html';
const USER_AGENT = 'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';

/**
 * Hand-confirmed entries merged over the anisong-book extraction. `ky 44092`
 * was recovered via a run2 detail probe (the one case the old detail fetch
 * actually recovered) and is pinned here so removing the fetch does not lose it.
 */
export const MANUAL_ENTRIES = {
  44092: {
    title: 'Connecting',
    artist: 'halyosy feat.初音ミク、鏡音リン・レン、巡音ルカ、KAITO、MEIKO',
    source: 'manual-20260716',
  },
};

const TRUNCATION_SENTINEL = '..';

/** True when a candidate value is a usable, non-truncated, non-empty string. */
function isCleanValue(value) {
  return (
    typeof value === 'string' && value.trim() !== '' && !value.trim().endsWith(TRUNCATION_SENTINEL)
  );
}

/** Decode the handful of HTML entities the anisong-book markup emits. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// The anisong-book HTML is WordPress-generated and fully regular: one
// `<article class="song-card">…</article>` per song, each with `.song-no`,
// `.song-title`, and `.artist-name` single-line divs. cheerio is not resolvable
// from scripts/, and the markup is stable enough that scoped regexes over each
// card block are robust (verified against the live 2,521-card fixture). `[^<]*`
// captures the text node before any child tag; entities are decoded above.
const CARD_RE = /<article class="song-card"[\s\S]*?<\/article>/g;
const SONG_NO_RE = /<div class="song-no">([^<]*)<\/div>/;
const SONG_TITLE_RE = /<div class="song-title">([^<]*)<\/div>/;
const ARTIST_NAME_RE = /<div class="artist-name">([^<]*)<\/div>/;

/**
 * Parse the anisong-book HTML into `{ ky: { title, artist, source } }`. Pure —
 * `warn` collects skip reasons. Rows with a non-digit number, an empty/truncated
 * title, or an empty/truncated artist are skipped.
 */
export function parseAnisongBook(html, warn = () => {}) {
  const entries = {};
  for (const card of html.match(CARD_RE) ?? []) {
    const ky = (card.match(SONG_NO_RE)?.[1] ?? '').trim();
    const title = decodeEntities(card.match(SONG_TITLE_RE)?.[1] ?? '').trim();
    const artist = decodeEntities(card.match(ARTIST_NAME_RE)?.[1] ?? '').trim();
    if (!/^[0-9]+$/.test(ky)) {
      warn(`skip: non-digit song-no ${JSON.stringify(ky)}`);
      continue;
    }
    if (!isCleanValue(title)) {
      warn(`skip ky=${ky}: empty/truncated title ${JSON.stringify(title)}`);
      continue;
    }
    if (!isCleanValue(artist)) {
      warn(`skip ky=${ky}: empty/truncated artist ${JSON.stringify(artist)}`);
      continue;
    }
    // First occurrence wins; a duplicate song-no in the book is anomalous.
    if (entries[ky] === undefined) {
      entries[ky] = { title, artist, source: 'anisong-book-42' };
    } else {
      warn(`skip ky=${ky}: duplicate song-no (keeping first)`);
    }
  }
  return entries;
}

/** Merge manual entries over the parsed map (manual wins) and sort keys numerically. */
export function buildRecoveryMap(parsed, manual = MANUAL_ENTRIES) {
  const merged = { ...parsed, ...manual };
  const sorted = {};
  for (const ky of Object.keys(merged).sort((a, b) => Number(a) - Number(b))) {
    sorted[ky] = merged[ky];
  }
  return sorted;
}

async function loadHtml(htmlPath, log) {
  if (htmlPath) {
    if (!existsSync(htmlPath)) throw new Error(`--html path not found: ${htmlPath}`);
    log.log(`reading local HTML: ${htmlPath}`);
    return readFileSync(htmlPath, 'utf8');
  }
  log.log(`fetching ${DEFAULT_SOURCE_URL}`);
  const res = await fetch(DEFAULT_SOURCE_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  return await res.text();
}

export const USAGE =
  'usage: node scripts/build-ky-title-recovery.mjs [--html <path>] [--out <path>]';

export function parseArgs(argv) {
  const parsed = { htmlPath: null, outPath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--html') {
      const v = argv[i + 1];
      if (!v) throw new Error('--html requires a path value');
      parsed.htmlPath = v;
      i += 1;
    } else if (arg === '--out') {
      const v = argv[i + 1];
      if (!v) throw new Error('--out requires a path value');
      parsed.outPath = v;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const html = await loadHtml(args.htmlPath, console);
  const parsed = parseAnisongBook(html, (msg) => console.warn(`[warn] ${msg}`));
  const map = buildRecoveryMap(parsed);
  const outPath = resolve(args.outPath ?? DEFAULT_OUT);
  writeTextAtomic(outPath, `${JSON.stringify(map, null, 2)}\n`);
  const manualCount = Object.keys(MANUAL_ENTRIES).length;
  console.log(
    `wrote ${Object.keys(map).length} entries (${Object.keys(parsed).length} anisong + ${manualCount} manual) to ${outPath}`,
  );
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
