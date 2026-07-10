/**
 * Shared built-crawler-dist locators + loaders for the JOYSOUND scripts.
 *
 * The detail sweep, the listing diagnostic sweep, and the offline replay
 * classifier all import the same built classifier (`buildJoysoundDecision`)
 * from `packages/crawler/dist`, each with the identical "Run pnpm build first"
 * try/catch. The detail sweep additionally imports the detail parser, and the
 * known-Japanese-artist predicate (scripts/lib/joysound-jp-artist.mjs) imports
 * the clustering + drop-list modules. Centralising the dist URLs here keeps the
 * relative-path knowledge in one place; the loaders keep the exact console
 * message + throw behavior the scripts had inline (the label parametrises the
 * script prefix).
 *
 * The `.href` values resolve to the same absolute
 * `packages/crawler/dist/...` targets the scripts referenced before extraction,
 * so the build-hint error strings stay byte-identical.
 */

const DIST_DIAGNOSTIC = new URL(
  '../../packages/crawler/dist/adapters/joysound-official/diagnostic.js',
  import.meta.url,
);
const DIST_DETAIL = new URL(
  '../../packages/crawler/dist/adapters/joysound-official/detail.js',
  import.meta.url,
);
const DIST_CLUSTERING = new URL('../../packages/crawler/dist/clustering.js', import.meta.url);
const DIST_KOREAN_DROP = new URL(
  '../../packages/crawler/dist/curated/koreanArtistDropList.js',
  import.meta.url,
);
const DIST_CHINESE_DROP = new URL(
  '../../packages/crawler/dist/curated/chineseArtistDropList.js',
  import.meta.url,
);
const DIST_HTTP = new URL('../../packages/crawler/dist/http.js', import.meta.url);
const DIST_JOYSOUND_CRAWLER = new URL(
  '../../packages/crawler/dist/adapters/joysound-official/crawler.js',
  import.meta.url,
);

/**
 * Import the built JOYSOUND classifier module (`{ buildJoysoundDecision }`).
 * On failure logs the same build-hint the scripts logged inline (prefixed with
 * `label`) and rethrows.
 *
 * @param {string} label - the calling script's log prefix (e.g. 'joysound-detail-sweep')
 * @returns {Promise<{ buildJoysoundDecision: Function }>}
 */
export async function loadJoysoundClassifier(label) {
  try {
    return await import(DIST_DIAGNOSTIC.href);
  } catch (err) {
    console.error(
      `[${label}] failed to import built classifier from ${DIST_DIAGNOSTIC.href}.\nRun \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
    throw err;
  }
}

/**
 * Import the built JOYSOUND detail parser module (`{ parseJoysoundDetail }`).
 *
 * @returns {Promise<{ parseJoysoundDetail: Function }>}
 */
export function loadJoysoundDetailParser() {
  return import(DIST_DETAIL.href);
}

/**
 * Import the clustering + foreign drop-list helpers the known-Japanese-artist
 * predicate needs. Returns `{ normalizeForMatch, splitArtistCollab,
 * isInDropList, isInChineseDropList }`.
 *
 * @returns {Promise<{ normalizeForMatch: Function, splitArtistCollab: Function, isInDropList: Function, isInChineseDropList: Function }>}
 */
export async function loadJpArtistDropDeps() {
  const { normalizeForMatch, splitArtistCollab } = await import(DIST_CLUSTERING.href);
  const { isInDropList } = await import(DIST_KOREAN_DROP.href);
  const { isInChineseDropList } = await import(DIST_CHINESE_DROP.href);
  return { normalizeForMatch, splitArtistCollab, isInDropList, isInChineseDropList };
}

/**
 * Import the built crawler pieces the JOYSOUND full-catalog LISTING tool needs:
 * the polite `HttpClient` (200ms±50 rate limit, 429/5xx retries, robots
 * allowlist incl. the `/web/search/songlist` path, ETag cache) and the
 * `fetchJoysoundSonglistPage` building block + the `JOYSOUND_FULL_CATALOG_KANA`
 * default kana walk order. Returns
 * `{ HttpClient, fetchJoysoundSonglistPage, JOYSOUND_FULL_CATALOG_KANA }`.
 *
 * @returns {Promise<{ HttpClient: Function, fetchJoysoundSonglistPage: Function, JOYSOUND_FULL_CATALOG_KANA: readonly string[] }>}
 */
export async function loadJoysoundListingDeps() {
  const { HttpClient } = await import(DIST_HTTP.href);
  const { fetchJoysoundSonglistPage, JOYSOUND_FULL_CATALOG_KANA } = await import(
    DIST_JOYSOUND_CRAWLER.href
  );
  return { HttpClient, fetchJoysoundSonglistPage, JOYSOUND_FULL_CATALOG_KANA };
}
