import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasHan, hasHangul, hasKana } from '@karaoke/search';

/**
 * Resolve to the on-disk blog corpus the rescue path reads at construction time.
 *
 * Walks up from the compiled file location
 * (`<repo>/packages/crawler/dist/adapters/tj-media-direct/blogWhitelist.js`) to
 * the repo root, then into `apps/web/public/data/songs.json`. This makes the
 * path resolution independent of `process.cwd()` so the adapter works whether
 * the CLI is invoked from the repo root, a package dir, or a CI worker.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BLOG_CORPUS_PATH_DEFAULT = resolve(HERE, '../../../../../apps/web/public/data/songs.json');

/**
 * Provider for the set of TJ catalog numbers that should bypass the per-record
 * + per-artist cache filter (defense-in-depth rescue). Defaults to the on-disk
 * blog corpus (`apps/web/public/data/songs.json`).
 *
 * Pragmatic dependency: the rescue path reads the deployed blog data so the
 * adapter retains all-Latin-named Japanese acts the blog already knows about
 * (GRANRODEO, halyosy, DREAMS COME TRUE, etc.). This mirrors the small
 * architectural smell already present in `apps/web/src/lib/featured.ts`,
 * which is also tied to the blog corpus.
 */
export type BlogWhitelistSource = () => ReadonlySet<string>;

/**
 * Minimal record shape consumed by `buildBlogWhitelist`. The default source
 * reads `apps/web/public/data/songs.json` whose entries match `SongRecord`,
 * but the builder only needs a narrow projection — accepting a small interface
 * keeps the unit tests trivial to set up.
 *
 * `title_primary` is read by the direct-origin baseline rescue policy
 * (tj-* / tjpdf-*); it is unused for blog-origin records.
 */
export interface BlogWhitelistRecord {
  id?: string | null | undefined;
  source_url?: string | null | undefined;
  artist_primary: string | null | undefined;
  title_primary?: string | null | undefined;
  karaoke_numbers: { tj?: string | null };
}

/**
 * Decide whether a blog-corpus record's `artist_primary` carries enough script
 * signal to admit its TJ# into the rescue whitelist.
 *
 * Audit motivation (PR-3): the blog corpus contains ~1,029 Mandopop /
 * Cantopop / K-pop records mistakenly tagged `jpop`. Their `artist_primary`
 * is pure Han (Chinese) or pure Hangul (Korean). Admitting them on the rescue
 * path defeats the parser's nationality filter for those TJ#s, so we trim
 * them out at whitelist-construction time.
 *
 * Rules:
 *   - Artist contains hiragana OR katakana   -> admit (genuine JP signal).
 *   - Artist contains Han AND no kana        -> skip (pure Chinese).
 *   - Artist contains Hangul AND no kana     -> skip (pure Korean).
 *   - Artist is pure Latin (no kana, no Han, no Hangul) -> admit
 *     (could be a genuine JP-Latin act like L'Arc~en~Ciel; the rescue's
 *     safety-net role still applies for these).
 *   - Empty / missing artist                 -> skip (no signal to evaluate).
 *
 * Mixed Hangul + kana: kana takes precedence and admits — kana is the
 * strongest JP signal, and these collab strings (e.g. `에반스 & ヨネ`) are
 * almost always genuine JP collaborations carrying a Korean billing.
 *
 * Note: pure-kanji JP acts (e.g. 米津玄師) are intentionally skipped here and
 * rely on path-1 (per-artist `searchSong` scan) or path-2 (per-record JPN
 * `nationalcode`) for admission. The rescue path is a safety net for
 * kana-bearing and Latin-named acts, not an exhaustive JP oracle.
 */
export function shouldAdmitArtistToWhitelist(artist: string | null | undefined): boolean {
  if (!artist) return false;
  if (hasKana(artist)) return true;
  if (hasHan(artist)) return false;
  if (hasHangul(artist)) return false;
  return true;
}

function isBlogOriginRecord(rec: BlogWhitelistRecord): boolean {
  if (typeof rec.id === 'string' && rec.id.startsWith('blog-')) return true;
  return (
    typeof rec.source_url === 'string' && rec.source_url.includes('j-pop-playlist.tistory.com')
  );
}

function isDirectAcceptedCorpusRecord(rec: BlogWhitelistRecord): boolean {
  if (typeof rec.id !== 'string') return false;
  return rec.id.startsWith('tj-') || rec.id.startsWith('tjpdf-');
}

/**
 * Direct-origin baseline rescue policy for `tj-*` / `tjpdf-*` records.
 *
 * Background: the full-workflow replay showed trusted baseline TJ numbers
 * being silently dropped because the rescue whitelist admitted only blog-origin
 * records. Restoring all direct-origin records would re-leak the featured-only
 * cases (e.g. `HOME / Charlie Puth(Feat.宇多田ヒカル)`), so the rescue here is
 * narrow: admit only when the record carries a concrete JP signal that the
 * featured-artist leak shape cannot satisfy.
 *
 * Admit if:
 *   - `title_primary` contains hiragana or katakana (kana on the title, not on
 *     a featured artist, is a property of the song itself).
 *
 * Deliberately rejected: artist kana. The leak shape we are protecting against
 * has kana on a featured-artist component while the title is Latin — relying on
 * full-artist kana would re-admit exactly those records.
 *
 * NOTE: the category-based admit (anime/vocaloid) was removed with the category
 * dimension. This is an accepted recall reduction — Latin-titled anime/vocaloid
 * baseline records that lack title kana now rely on the per-artist /
 * per-pro JPN signals rather than a category tag.
 *
 * Explicit non-JPN pro entries are still vetoed by `nonJpnProRejectStep` in
 * the filter chain — this rescue only lifts the per-record drop, it does not
 * override pro-level non-JPN evidence.
 */
function shouldAdmitDirectOriginRecord(rec: BlogWhitelistRecord): boolean {
  const title = rec.title_primary;
  if (typeof title === 'string' && hasKana(title)) {
    return true;
  }
  return false;
}

/**
 * Build the rescue-path TJ# whitelist from an in-memory blog-corpus record
 * array. Extracted from `defaultBlogWhitelistSource` so unit tests can
 * exercise the trim logic without touching the on-disk JSON.
 *
 * Logs a one-line warn-level summary of how many records the script-signal
 * trim skipped vs admitted; the production crawler surfaces this alongside
 * the per-path admit counters for post-trim auditability.
 */
export function buildBlogWhitelist(
  records: ReadonlyArray<BlogWhitelistRecord>,
): ReadonlySet<string> {
  const tjs = new Set<string>();
  let kept = 0;
  let skipped = 0;
  let keptDirect = 0;
  let skippedUntrustedOrigin = 0;
  for (const rec of records) {
    const tj = rec.karaoke_numbers?.tj;
    if (typeof tj !== 'string' || tj === '') continue;
    if (isBlogOriginRecord(rec)) {
      if (!shouldAdmitArtistToWhitelist(rec.artist_primary)) {
        skipped++;
        continue;
      }
      tjs.add(tj);
      kept++;
      continue;
    }
    if (isDirectAcceptedCorpusRecord(rec) && shouldAdmitDirectOriginRecord(rec)) {
      tjs.add(tj);
      keptDirect++;
      continue;
    }
    skippedUntrustedOrigin++;
  }
  console.log(
    `[tj-media-direct] blog whitelist trimmed: kept ${kept} of ${kept + skipped + keptDirect + skippedUntrustedOrigin} records (skipped ${skipped} with Han-only / Hangul artist names, ${skippedUntrustedOrigin} non-blog-origin; direct-origin admits ${keptDirect})`,
  );
  return tjs;
}

/**
 * Default blog whitelist source: read `apps/web/public/data/songs.json` from
 * the working directory and extract `karaoke_numbers.tj` for every record
 * whose `artist_primary` passes the script-signal trim.
 *
 * If the file is missing or unreadable, log a single warning and return an
 * empty set — the adapter degrades to "no rescue", not a hard failure.
 */
export function defaultBlogWhitelistSource(): ReadonlySet<string> {
  try {
    const text = readFileSync(BLOG_CORPUS_PATH_DEFAULT, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return new Set();
    const records: BlogWhitelistRecord[] = [];
    for (const rec of parsed) {
      if (!rec || typeof rec !== 'object') continue;
      const numbersRaw = (rec as { karaoke_numbers?: unknown }).karaoke_numbers;
      if (!numbersRaw || typeof numbersRaw !== 'object') continue;
      const tjRaw = (numbersRaw as { tj?: unknown }).tj;
      const artistRaw = (rec as { artist_primary?: unknown }).artist_primary;
      const titleRaw = (rec as { title_primary?: unknown }).title_primary;
      records.push({
        id: typeof (rec as { id?: unknown }).id === 'string' ? (rec as { id: string }).id : null,
        source_url:
          typeof (rec as { source_url?: unknown }).source_url === 'string'
            ? (rec as { source_url: string }).source_url
            : null,
        artist_primary: typeof artistRaw === 'string' ? artistRaw : null,
        title_primary: typeof titleRaw === 'string' ? titleRaw : null,
        karaoke_numbers: { tj: typeof tjRaw === 'string' ? tjRaw : null },
      });
    }
    return buildBlogWhitelist(records);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tj-media-direct] blog-whitelist rescue disabled: could not read ${BLOG_CORPUS_PATH_DEFAULT}: ${msg}`,
    );
    return new Set();
  }
}

/**
 * Provider for the TJ reverse-probe SEED: TJ catalog numbers claimed by
 * blog-origin records in the previous corpus. Same on-disk source as the
 * rescue whitelist (`apps/web/public/data/songs.json`) but a DIFFERENT
 * projection — see `buildBlogSeed`. Defaults to the on-disk corpus.
 */
export type BlogSeedSource = () => ReadonlySet<string>;

/**
 * Build the reverse-probe seed from a previous-corpus record array: every TJ
 * number claimed by a blog-origin record.
 *
 * Detection is PREFIX-ONLY (`id` starts with `blog-`), so it works for both
 * the legacy positional shape (`blog-{artistId}-{rowIndex}`) and the current
 * `blog-{artistId}-{vendor}-{number}` minting. Unlike `buildBlogWhitelist`
 * there is NO artist script-signal trim: every blog TJ claim is a probe
 * candidate. The probe hit is still gated by the full classification chain
 * downstream (a probe hit does not bypass the JPN/drop filters), so widening
 * the candidate set here cannot admit a non-JP record — it only decides which
 * numbers are worth a lookup.
 */
export function buildBlogSeed(records: ReadonlyArray<BlogWhitelistRecord>): ReadonlySet<string> {
  const seed = new Set<string>();
  for (const rec of records) {
    if (typeof rec.id !== 'string' || !rec.id.startsWith('blog-')) continue;
    const tj = rec.karaoke_numbers?.tj;
    if (typeof tj === 'string' && tj !== '') seed.add(tj);
  }
  return seed;
}

/**
 * Read a corpus JSON file and derive the blog reverse-probe seed. If the file
 * is missing or unreadable, log a single warning and return an empty set — the
 * seed probe degrades to "no reverse lookup", not a hard failure (mirrors
 * `defaultBlogWhitelistSource`). Extracted (path-parameterized) so the
 * missing-file and derivation behavior are unit-testable without the on-disk
 * default corpus.
 */
export function loadBlogSeedFromCorpus(corpusPath: string): ReadonlySet<string> {
  try {
    const text = readFileSync(corpusPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return new Set();
    const records: BlogWhitelistRecord[] = [];
    for (const rec of parsed) {
      if (!rec || typeof rec !== 'object') continue;
      const numbersRaw = (rec as { karaoke_numbers?: unknown }).karaoke_numbers;
      if (!numbersRaw || typeof numbersRaw !== 'object') continue;
      const tjRaw = (numbersRaw as { tj?: unknown }).tj;
      records.push({
        id: typeof (rec as { id?: unknown }).id === 'string' ? (rec as { id: string }).id : null,
        artist_primary: null,
        karaoke_numbers: { tj: typeof tjRaw === 'string' ? tjRaw : null },
      });
    }
    return buildBlogSeed(records);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tj-seed] blog seed disabled: could not read ${corpusPath}: ${msg}`);
    return new Set();
  }
}

/**
 * Default blog seed source: derive the blog-claimed TJ numbers from the same
 * `apps/web/public/data/songs.json` the rescue whitelist reads.
 */
export function defaultBlogSeedSource(): ReadonlySet<string> {
  return loadBlogSeedFromCorpus(BLOG_CORPUS_PATH_DEFAULT);
}
