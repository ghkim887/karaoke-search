import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { resolveCrawlLimit } from '../limit.js';
import { type KyClassifyReason, classifyKyRow, kyStepForReason } from './classifier.js';
import { type KyTitleRecoveryEntry, lookupKyTitleRecovery } from './curatedTitleRecovery.js';
import { normalizeKyRecord } from './normalizer.js';
import { type KyRawRow, parseKyIndexRows } from './parser.js';

const KARAOKE_BOOK_BASE = 'https://kysing.kr/karaoke-book/';

/** Look up a truncated row's full title/artist in the curated recovery map. */
type KyTitleRecoveryLookup = (ky: string) => KyTitleRecoveryEntry | null;

/**
 * Index letters for the `city=jp` (Japanese) karaoke-book walk. These are the
 * `s_value` query values the live index exposes as clickable anchors on
 * `https://kysing.kr/karaoke-book/?city=jp` — 80 hiragana readings, the
 * "其他/ETC" bucket (`0`), and A–Z (107 distinct values total). Measured from
 * the live entry page 2026-07-16 (see docs/research/2026-07-16-ky-smart-
 * enumeration-resurvey.md and test/fixtures/ky/index-entry-jp.html). The index
 * anchors are HIRAGANA, not katakana; the walk URL is
 * `?city=jp&s_cd=2&s_page={n}&s_value={letter}`.
 *
 * Exported `as const` + overridable via the constructor's `indexValues` option
 * so tests can narrow the set (JOYSOUND_FULL_CATALOG_KANA precedent).
 */
export const KY_KARAOKE_BOOK_INDEX = [
  'あ',
  'ぁ',
  'か',
  'が',
  'さ',
  'ざ',
  'た',
  'だ',
  'な',
  'は',
  'ば',
  'ぱ',
  'ま',
  'や',
  'ゃ',
  'ら',
  'わ',
  'ん',
  'い',
  'ぃ',
  'き',
  'ぎ',
  'し',
  'じ',
  'ち',
  'ぢ',
  'に',
  'ひ',
  'び',
  'ぴ',
  'み',
  'り',
  'う',
  'ぅ',
  'く',
  'ぐ',
  'す',
  'ず',
  'つ',
  'づ',
  'ぬ',
  'ふ',
  'ぶ',
  'ぷ',
  'む',
  'ゆ',
  'ゅ',
  'る',
  'っ',
  'え',
  'ぇ',
  'け',
  'げ',
  'せ',
  'ぜ',
  'て',
  'で',
  'ね',
  'へ',
  'べ',
  'ぺ',
  'め',
  'れ',
  'お',
  'ぉ',
  'こ',
  'ご',
  'そ',
  'ぞ',
  'と',
  'ど',
  'の',
  'ほ',
  'ぼ',
  'ぽ',
  'も',
  'よ',
  'ょ',
  'ろ',
  'を',
  '0',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
] as const;

/**
 * Minimum rows encountered before the row-parse-error skip-ratio abort (D5) is
 * enforced — avoids a false abort on a tiny sample (e.g. a limited test walk)
 * where one bad row would exceed 1%.
 */
const MIN_ROWS_FOR_SKIP_RATIO = 50;
/** Row-parse-error skip-ratio abort threshold (D5): >1% of rows unparseable. */
const MAX_ROW_PARSE_SKIP_RATIO = 0.01;

/** One decision-log row (D8), TJ/JOYSOUND-isomorphic. `reason` is a string
 * superset of the classifier enum (adds operational `truncation-unrecovered` /
 * `row-parse-error`). */
interface KyDecisionRecord {
  ky: string;
  title: string;
  artist: string;
  decision: 'admit' | 'drop';
  step: string | null;
  reason: string;
}

export interface KyKysingCrawlerOptions {
  /** Override the adapter slug. */
  name?: string;
  /** Test/audit hook to narrow the index-letter set (JOYSOUND fullCatalogKana precedent). */
  indexValues?: readonly string[];
  /**
   * Curated title-recovery lookup for truncated rows. Defaults to the committed
   * production map ({@link lookupKyTitleRecovery}); tests inject a fake map to
   * exercise the recovered/unrecovered paths without the full data file.
   */
  titleRecovery?: KyTitleRecoveryLookup;
}

/** Mutable per-run state threaded through the walk. */
interface RunState {
  crawledAt: string;
  decisions: KyDecisionRecord[];
  seen: Set<string>;
  rowsSeen: number;
  rowParseErrors: number;
}

/**
 * `KyKysingCrawler` walks kysing.kr's Japanese karaoke-book index
 * (`/karaoke-book/?city=jp&s_cd=2&s_value={letter}&s_page={n}`), one index
 * letter at a time, s_page 1 until a page yields 0 rows (total pages are not
 * advertised — JOYSOUND full-catalog walk pattern). Rows are deduped by KY
 * number, classified conservatively, and — for rows the index truncated — the
 * full title/artist is recovered from the curated title-recovery map before
 * admit (drop when the number is not in the map). Admitted rows yield
 * `SongRecord`s populating only `karaoke_numbers.ky` (never TJ / JOYSOUND
 * numbers nor Korean translations). This adapter makes NO detail fetch: the KY
 * index and its `category=1` detail truncate identically, so the former per-row
 * detail-repair fetch recovered ~0.37% of long titles (run2: 1/270) and was
 * pure wasted requests (D2 revision, owner decision 2026-07-16).
 *
 * Failure semantics:
 *   - Index page fetch null (robots) / non-2xx: THROW (a skipped index page is
 *     a coverage hole — JOYSOUND listing principle, D5).
 *   - Truncated row whose KY number is NOT in the recovery map: per-row DROP
 *     with reason `truncation-unrecovered` (D2') — the truncated title never
 *     enters the corpus.
 *   - Empty title/artist or normalize throw: per-row DROP with reason
 *     `row-parse-error` (D5); if the row-parse-error ratio exceeds 1% over a
 *     meaningful sample, the walk ABORTS.
 *
 * Limit semantics: `options.limit` caps the number of records YIELDED
 * (post-classify). Pages/letters are fetched lazily until the cap is hit.
 */
export class KyKysingCrawler implements Crawler {
  readonly name: string;
  private readonly indexValues: readonly string[];
  private readonly titleRecovery: KyTitleRecoveryLookup;

  constructor(
    private http: HttpClient,
    options: KyKysingCrawlerOptions = {},
  ) {
    this.name = options.name ?? 'ky-kysing';
    this.indexValues = options.indexValues ?? KY_KARAOKE_BOOK_INDEX;
    this.titleRecovery = options.titleRecovery ?? lookupKyTitleRecovery;
  }

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit = resolveCrawlLimit(options);
    const state: RunState = {
      crawledAt: new Date().toISOString(),
      decisions: [],
      seen: new Set<string>(),
      rowsSeen: 0,
      rowParseErrors: 0,
    };
    try {
      yield* this.walk(limit, state);
    } finally {
      const admits = state.decisions.filter((d) => d.decision === 'admit').length;
      const drops = state.decisions.length - admits;
      console.log(
        `[${this.name}] run summary: ${state.rowsSeen} index rows, admitted ${admits}, dropped ${drops}, row-parse-errors ${state.rowParseErrors}`,
      );
      if (options?.kyDecisionsOutPath) {
        await this.tryWriteDecisions(options.kyDecisionsOutPath, state.decisions);
      }
    }
  }

  private async *walk(limit: number, state: RunState): AsyncIterable<SongRecord> {
    let yielded = 0;
    for (const letter of this.indexValues) {
      let page = 1;
      while (yielded < limit) {
        const rows = await this.fetchIndexPage(letter, page);
        if (rows.length === 0) break; // end of this letter's pages
        for (const row of rows) {
          if (yielded >= limit) return;
          state.rowsSeen++;
          if (state.seen.has(row.ky)) continue; // dedup by KY number
          state.seen.add(row.ky);
          const record = this.processRow(row, state);
          if (record !== null) {
            yield record;
            yielded++;
          }
        }
        this.assertSkipRatioOk(state);
        page++;
      }
    }
  }

  /** Fetch + parse one index page. A null (robots) / non-2xx fetch throws. */
  private async fetchIndexPage(letter: string, page: number): Promise<KyRawRow[]> {
    const url = `${KARAOKE_BOOK_BASE}?city=jp&s_cd=2&s_page=${page}&s_value=${encodeURIComponent(letter)}`;
    const res = await this.http.fetch(url);
    if (res === null) {
      throw new Error(
        `[${this.name}] index "${letter}" page ${page} blocked by robots.txt: ${url}`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`[${this.name}] index "${letter}" page ${page} HTTP ${res.status} (${url})`);
    }
    return parseKyIndexRows(res.body);
  }

  /**
   * Process one deduped index row: recover-if-truncated, classify, record the
   * decision, and return a normalized record on admit (else `null`). No network:
   * truncation recovery is a synchronous lookup in the curated map.
   */
  private processRow(row: KyRawRow, state: RunState): SongRecord | null {
    // Empty title/artist from the index is unparseable — record + skip (D5).
    if (row.title.trim() === '' || row.artist.trim() === '') {
      state.rowParseErrors++;
      this.record(state, row.ky, row.title, row.artist, 'drop', null, 'row-parse-error');
      return null;
    }

    let effective = row;
    let recovered = false;
    if (row.truncated) {
      const entry = this.titleRecovery(row.ky);
      if (entry === null) {
        // Not in the curated recovery map: drop so a truncated title never
        // enters the corpus (D2'). No detail fetch — the index and its
        // `category=1` detail truncate identically, so a fetch cannot recover it.
        this.record(
          state,
          row.ky,
          row.title,
          row.artist,
          'drop',
          'truncation-recovery',
          'truncation-unrecovered',
        );
        return null;
      }
      effective = { ky: row.ky, title: entry.title, artist: entry.artist, truncated: false };
      recovered = true;
    }

    const { admit, reason } = classifyKyRow({
      ky: effective.ky,
      title: effective.title,
      artist: effective.artist,
      recovered,
    });
    this.record(
      state,
      effective.ky,
      effective.title,
      effective.artist,
      admit ? 'admit' : 'drop',
      kyStepForReason(reason),
      reason,
    );
    if (!admit) return null;

    try {
      return normalizeKyRecord({
        ky: effective.ky,
        title: effective.title,
        artist: effective.artist,
        crawledAt: state.crawledAt,
      });
    } catch (err) {
      // Defensive: an admitted row that fails normalization/validation is a
      // per-row non-fatal parse error, not a crawl abort.
      state.rowParseErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] normalize failed for ky=${effective.ky}: ${msg} (skipped)`);
      // Rewrite the just-pushed admit decision as a row-parse-error drop so the
      // decision log never claims a record that was not emitted.
      const last = state.decisions[state.decisions.length - 1];
      if (last && last.ky === effective.ky && last.decision === 'admit') {
        last.decision = 'drop';
        last.step = null;
        last.reason = 'row-parse-error';
      }
      return null;
    }
  }

  private record(
    state: RunState,
    ky: string,
    title: string,
    artist: string,
    decision: 'admit' | 'drop',
    step: string | null,
    reason: KyClassifyReason | 'truncation-unrecovered' | 'row-parse-error',
  ): void {
    state.decisions.push({ ky, title, artist, decision, step, reason });
  }

  /** Abort the walk if the row-parse-error ratio exceeds the D5 threshold. */
  private assertSkipRatioOk(state: RunState): void {
    if (state.rowsSeen < MIN_ROWS_FOR_SKIP_RATIO) return;
    const ratio = state.rowParseErrors / state.rowsSeen;
    if (ratio > MAX_ROW_PARSE_SKIP_RATIO) {
      throw new Error(
        `[${this.name}] row-parse-error ratio ${(ratio * 100).toFixed(1)}% exceeds ${(MAX_ROW_PARSE_SKIP_RATIO * 100).toFixed(0)}% over ${state.rowsSeen} rows — aborting to avoid ingesting a broken parse`,
      );
    }
  }

  /**
   * Write the per-row decision log as JSONL (overwrite). Fail-soft: a write
   * error is warned, never thrown — the log is report-only telemetry and must
   * not abort the crawl (TJ `tryWriteDecisions` pattern). Parent dir created if
   * missing (CI points this at a RUNNER_TEMP subdir).
   */
  private async tryWriteDecisions(outPath: string, decisions: KyDecisionRecord[]): Promise<void> {
    try {
      await mkdir(dirname(outPath), { recursive: true });
      const body = decisions.map((d) => JSON.stringify(d)).join('\n');
      await writeFile(outPath, decisions.length > 0 ? `${body}\n` : '', 'utf8');
      console.log(`[${this.name}] wrote ${decisions.length} filter decisions to ${outPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] filter decision-log write failed at ${outPath}: ${msg}`);
    }
  }
}
