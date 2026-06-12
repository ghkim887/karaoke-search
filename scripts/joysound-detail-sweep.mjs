#!/usr/bin/env node
/**
 * JOYSOUND full-catalog DETAIL-FETCH sweep.
 *
 * The companion `scripts/joysound-diagnostic-sweep.mjs` is LISTING-ONLY: it
 * classifies each cached listing row with no per-song detail, so the
 * classifier's DETAIL-GATED gates never fire — the `foreignNameSignal` DROP
 * gate, the `admit-jp-detail` recovery, and the C1/C2 corroborating tells are
 * all inert without detail. This runner closes that gap: it fetches each song's
 * `fetchContentsDetail` payload, parses it, and feeds the detail into
 * `buildJoysoundDecision` so the full classifier fires. The output is a
 * detail-bearing decision-log JSONL that `scripts/build-joysound-candidate.mjs`
 * consumes UNCHANGED (the DecisionRecord shape is a superset of the listing
 * sweep's — same fields plus a `detailFetchFailed` flag, plus an optional
 * `detail` field carrying the parsed `JoysoundDetail` when the fetch succeeded
 * — compacted by `compactDetail`, which deliberately drops `lyricIntro` and
 * omits null/undefined/empty-array fields; rows from older runs or failed
 * fetches simply lack `detail`, and the heterogeneous log stays valid).
 *
 * The real input is ~294k listing rows (~291k unique). At ~250ms/fetch this is
 * a ~2-day run, so the runner is RESUMABLE: on startup it reads the existing
 * out-decision-log and skips every `naviGroupId` already decided, APPENDING new
 * records (never rewriting the file). A crash/restart picks up where it left
 * off — and if the crash left a TORN final line (a fragment with no trailing
 * newline), startup TRUNCATES it off so the next append can't weld onto it and
 * the on-disk log stays 100% newline-terminated + JSON-parseable for the
 * downstream `build-joysound-candidate.mjs` (whose `JSON.parse` has no
 * try/catch). A `*.progress.json` sidecar is rewritten every `progressEvery`
 * rows so an operator can watch ETA without tailing the log.
 *
 * The classifier is the single source of truth — this runner only adapts I/O,
 * fetching, dedup, resume, and failure handling.
 *
 * Usage:
 *   node scripts/joysound-detail-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl> <corpus-songs.json> [--limit N]
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DIST_DIAGNOSTIC = new URL(
  '../packages/crawler/dist/adapters/joysound-official/diagnostic.js',
  import.meta.url,
);
const DIST_DETAIL = new URL(
  '../packages/crawler/dist/adapters/joysound-official/detail.js',
  import.meta.url,
);
const DIST_CLUSTERING = new URL('../packages/crawler/dist/clustering.js', import.meta.url);
const DIST_KOREAN_DROP = new URL(
  '../packages/crawler/dist/adapters/tj-media-direct/koreanArtistDropList.js',
  import.meta.url,
);
const DIST_CHINESE_DROP = new URL(
  '../packages/crawler/dist/adapters/tj-media-direct/chineseArtistDropList.js',
  import.meta.url,
);

const UA = 'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';
const DETAIL_BASE = 'https://www.joysound.com/apis/v1/ise/fetchContentsDetail';
const MIN_INTERVAL_MS = Number(process.env.JOYSOUND_DETAIL_MIN_INTERVAL_MS ?? 250);
const JITTER_MS = Number(process.env.JOYSOUND_DETAIL_JITTER_MS ?? 80);
const MAX_RETRIES = Number(process.env.JOYSOUND_DETAIL_MAX_RETRIES ?? 3);
const BODY_SIZE_LIMIT = 50 * 1024 * 1024;
const DEFAULT_PROGRESS_EVERY = 200;

/**
 * Generic bucket names that must NOT seed the known-Japanese-artist set — a
 * handful of real JP rows would otherwise make `Various Artists` look Japanese
 * and admit every OST/BGM row filed under the same bucket. Mirrors
 * `joysound-diagnostic-sweep.mjs` / the TJ filter chain.
 */
const GENERIC_ARTIST_KEYS = new Set([
  'variousartists',
  'variousartist',
  'various',
  'unknown',
  'unknownartist',
  'オムニバス',
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterDelay() {
  return Math.max(0, MIN_INTERVAL_MS + (Math.random() - 0.5) * JITTER_MS);
}

/** The dedup key: a song is uniquely `naviGroupId|selSongNo`. */
function rowKey(row) {
  return `${String(row.naviGroupId ?? '')}|${String(row.selSongNo ?? '')}`;
}

/**
 * Normalize a leaner listing-rows dump into the `JoysoundListItem` contract the
 * classifier expects (the diagnostic sweep does the same — the dump may omit
 * `artistId` / `tieupId` / `tieupInfo`).
 */
function normalizeListItem(row) {
  return {
    naviGroupId: String(row.naviGroupId ?? ''),
    selSongNo: String(row.selSongNo ?? ''),
    songName: String(row.songName ?? ''),
    artistName: String(row.artistName ?? ''),
    artistId: row.artistId ?? null,
    tieupInfo: row.tieupInfo ?? null,
    tieupId: row.tieupId ?? null,
  };
}

/**
 * Compact a parsed `JoysoundDetail` for persistence in the decision log.
 * Copies EVERY JoysoundDetail field with its name UNCHANGED — so downstream
 * (`build-joysound-candidate.mjs`) can hand the object straight to
 * `normalizeJoysoundRecord({ listItem, detail, ... })` — with two exceptions:
 *   - `lyricIntro` is DELIBERATELY dropped: it can carry lyric-snippet text,
 *     which would bloat a ~291k-row log by GBs.
 *   - Keys whose value is null/undefined/empty-array are omitted to keep rows
 *     compact (only those three; everything else — including empty strings —
 *     is kept verbatim). Omission is safe for the normalizer: it reads detail
 *     fields with `?.`/`??`, so a missing key behaves like the null it was.
 *
 * @param {import('../packages/crawler/dist/adapters/joysound-official/types.js').JoysoundDetail} detail
 * @returns {Record<string, unknown>}
 */
export function compactDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'lyricIntro') continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build the normalized known-Japanese-artist predicate from a corpus file.
 * Returns `undefined` when no corpus path was supplied so the classifier's
 * `admit-jp-artist` recall path stays off (production-equivalent behavior).
 * Mirrors `joysound-diagnostic-sweep.mjs` exactly.
 *
 * Exported so `joysound-replay-classifier.mjs` rebuilds the EXACT predicate
 * this sweep classified with (same corpus → same set → same `admit-jp-artist`
 * verdicts on replay).
 */
export async function buildKnownJapaneseArtistPredicate(corpusPath) {
  if (!corpusPath) return undefined;

  const { normalizeForMatch, splitArtistCollab } = await import(DIST_CLUSTERING.href);
  const { isInDropList } = await import(DIST_KOREAN_DROP.href);
  const { isInChineseDropList } = await import(DIST_CHINESE_DROP.href);

  const isDropListForeign = (artist) =>
    splitArtistCollab(artist).some((component) => {
      const key = normalizeForMatch(component);
      return key !== '' && (isInDropList(key) || isInChineseDropList(key));
    });

  const records = JSON.parse(readFileSync(corpusPath, 'utf8'));
  if (!Array.isArray(records)) {
    throw new Error(`[joysound-detail-sweep] corpus ${corpusPath} is not a JSON array`);
  }

  const set = new Set();
  for (const record of records) {
    const artist = typeof record?.artist_primary === 'string' ? record.artist_primary : '';
    if (artist === '') continue;
    const key = normalizeForMatch(artist);
    if (key === '' || GENERIC_ARTIST_KEYS.has(key)) continue;
    if (isDropListForeign(artist)) continue;
    set.add(key);
  }

  console.log(
    `[joysound-detail-sweep] built known-Japanese-artist set (${set.size} artists) from ${corpusPath}`,
  );
  return (artist) => set.has(normalizeForMatch(artist));
}

/** Cap a fetch body at BODY_SIZE_LIMIT so a pathological response can't OOM. */
async function fetchTextCapped(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > BODY_SIZE_LIMIT) throw new Error(`response too large by content-length: ${len}`);
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, body: await res.text() };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_SIZE_LIMIT)
      throw new Error(`response body exceeds size limit: ${BODY_SIZE_LIMIT}`);
    chunks.push(value);
  }
  return { status: res.status, body: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Default production fetch+parse for one song's detail. Mirrors the audit
 * runners: ~250ms interval + ~80ms jitter, 3 retries with linear backoff.
 * Returns the parsed `JoysoundDetail`. Throws after the last retry. Injected as
 * `fetchDetailImpl` so tests pass a stub and never hit the network.
 *
 * @param {string} naviGroupId
 * @param {(value: unknown) => import('../packages/crawler/dist/adapters/joysound-official/types.js').JoysoundDetail} parseJoysoundDetail
 */
function makeRealFetchDetail(parseJoysoundDetail) {
  return async function fetchDetail(naviGroupId) {
    const url = `${DETAIL_BASE}?kind=naviGroupId&id=${encodeURIComponent(naviGroupId)}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await sleep(jitterDelay());
      try {
        const res = await fetchTextCapped(url);
        if (res.status >= 200 && res.status < 300) {
          return parseJoysoundDetail(JSON.parse(res.body));
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      // Linear backoff between retries (1s, 2s, …).
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
    throw lastErr ?? new Error('unknown detail fetch failure');
  };
}

/**
 * Stream the listing JSONL once, returning the de-duplicated rows (collapsed on
 * `naviGroupId|selSongNo`, FIRST occurrence wins) optionally capped at `limit`.
 * The file is ~55MB so it is streamed line-by-line; only the dedup key set and
 * the surviving rows are held in memory.
 */
async function readUniqueRows(inPath, limit) {
  const seen = new Set();
  const rows = [];
  let total = 0;
  let parseErrors = 0;
  const rl = createInterface({
    input: createReadStream(inPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    total += 1;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch (err) {
      parseErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[joysound-detail-sweep] skipping unparseable listing line ${total}: ${msg}`);
      continue;
    }
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (typeof limit === 'number' && limit > 0 && rows.length >= limit) break;
  }
  return { rows, total, uniqueRows: rows.length, parseErrors };
}

/**
 * Read the existing out-decision-log (if present) and return the set of
 * `naviGroupId`s already decided. Resume mechanism: those rows are skipped and
 * the file is APPENDED, never rewritten — so a crash mid-run loses at most the
 * in-flight row, not the whole log.
 */
function readResumeSkipSet(outPath) {
  const skip = new Set();
  if (!existsSync(outPath)) return skip;
  const raw = readFileSync(outPath, 'utf8');
  // A crash mid-append can leave a TORN final line: a fragment with no trailing
  // newline. We must NOT weld the next appended record onto it — append mode
  // (`flags:'a'`) opens at the very end of the fragment, so without a guard the
  // first new record becomes `…torn{"selSongNo":…}`, a single corrupt JSON line
  // that crashes `build-joysound-candidate.mjs`'s `JSON.parse` (no try/catch).
  // Truncate the torn fragment to the last newline so the on-disk log is left
  // 100% newline-terminated + parseable; the dropped row is re-fetched and
  // re-appended cleanly (the fragment is excluded from the skip-set scan below).
  // Truncation is O(1) (a length set, not a rewrite), so it stays cheap on the
  // multi-GB resume log.
  if (raw.length > 0 && !raw.endsWith('\n')) {
    const lastNewline = raw.lastIndexOf('\n');
    // Byte length of the kept prefix (everything through the last newline; 0
    // when the whole file is one torn line). The log is ASCII-safe JSON but
    // JOYSOUND titles are UTF-8, so measure BYTES.
    const keepBytes = Buffer.byteLength(raw.slice(0, lastNewline + 1), 'utf8');
    truncateSync(outPath, keepBytes);
    console.warn(
      '[joysound-detail-sweep] resume: dropped a torn final line (crash mid-append); the owning row is re-fetched',
    );
  }
  // Scan ONLY the kept prefix (everything through the last newline) — exactly
  // what survived the truncation above. A crash can land BETWEEN a record's
  // text and its trailing newline, leaving a torn tail that is nonetheless
  // COMPLETE JSON; scanning `raw` would parse that fragment into the skip set
  // even though it was just truncated off disk — the row would never be
  // re-fetched and would be permanently missing from the log. When the whole
  // file is one torn line (no newline at all, lastIndexOf === -1), the kept
  // prefix is empty and nothing is parsed — consistent with the
  // truncate-to-zero above.
  const parseable = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  let kept = 0;
  for (const line of parseable.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && typeof rec.naviGroupId === 'string' && rec.naviGroupId !== '') {
        skip.add(rec.naviGroupId);
        kept += 1;
      }
    } catch {
      // A corrupt interior line (should not happen — every append is one
      // newline-terminated JSON.stringify). The torn final line never reaches
      // here: it is excluded from `parseable` above.
    }
  }
  if (kept > 0) {
    console.log(`[joysound-detail-sweep] resume: ${kept} naviGroupId(s) already decided, skipping`);
  }
  return skip;
}

function progressPathFor(outPath) {
  return `${outPath}.progress.json`;
}

/**
 * Core sweep, factored out of `main()` so tests drive it with an injected
 * `fetchDetailImpl` (no real HTTP). Returns the run stats.
 *
 * @param {{
 *   inPath: string,
 *   outPath: string,
 *   corpusPath?: string,
 *   fetchDetailImpl: (naviGroupId: string) => Promise<import('../packages/crawler/dist/adapters/joysound-official/types.js').JoysoundDetail>,
 *   limit?: number,
 *   progressEvery?: number,
 * }} opts
 */
export async function runDetailSweep({
  inPath,
  outPath,
  corpusPath,
  fetchDetailImpl,
  limit,
  progressEvery = DEFAULT_PROGRESS_EVERY,
}) {
  let buildJoysoundDecision;
  try {
    ({ buildJoysoundDecision } = await import(DIST_DIAGNOSTIC.href));
  } catch (err) {
    console.error(
      `[joysound-detail-sweep] failed to import built classifier from ${DIST_DIAGNOSTIC.href}.\nRun \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
    throw err;
  }

  const isKnownJapaneseArtist = await buildKnownJapaneseArtistPredicate(corpusPath);

  // 1. Dedup the listing rows (and apply --limit) before any fetch.
  const { rows, total, uniqueRows, parseErrors } = await readUniqueRows(inPath, limit);

  // 2. Resume: drop rows already decided in a prior run. The skip-set is keyed
  //    on `naviGroupId` ALONE (the detail fetch is per-naviGroupId), which is
  //    safe because the listing's naviGroupId↔selSongNo is 1:1 (verified:
  //    291,253 unique naviGroupIds, none mapping to >1 selSongNo). A future
  //    multi-sel listing dump would break that — it would skip every selSongNo
  //    under an already-seen naviGroupId, not just the decided one.
  const skip = readResumeSkipSet(outPath);
  const pending = rows.filter((row) => !skip.has(String(row.naviGroupId ?? '')));
  const resumedSkipped = rows.length - pending.length;

  const stats = {
    startedAt: new Date().toISOString(),
    inPath,
    outPath,
    corpusPath: corpusPath ?? null,
    listingRowsRead: total,
    listingParseErrors: parseErrors,
    uniqueRows,
    resumedSkipped,
    pending: pending.length,
    done: 0,
    fetched: 0,
    admitted: 0,
    dropped: 0,
    detailFetchFailures: 0,
  };

  console.log(
    `[joysound-detail-sweep] ${total} listing rows → ${uniqueRows} unique; ` +
      `${resumedSkipped} resumed-skip; ${pending.length} to fetch`,
  );

  // 3. Append-mode output stream (NOT atomic-rewrite — that would defeat resume
  //    on a multi-day run). createWriteStream with flags 'a' appends durably.
  //    Ensure the parent dir exists first (the recommended out path is nested,
  //    and createWriteStream does NOT create parents).
  mkdirSync(dirname(outPath), { recursive: true });
  const output = createWriteStream(outPath, { flags: 'a', encoding: 'utf8' });

  const writeProgress = async () => {
    const elapsedMs = Date.now() - Date.parse(stats.startedAt);
    const rate = stats.done > 0 ? elapsedMs / stats.done : 0;
    const remaining = pending.length - stats.done;
    await writeFile(
      progressPathFor(outPath),
      `${JSON.stringify(
        {
          ...stats,
          updatedAt: new Date().toISOString(),
          remaining,
          etaMs: Math.round(rate * remaining),
          etaHours: Number(((rate * remaining) / 3_600_000).toFixed(2)),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  };

  const appendRecord = async (record) => {
    if (!output.write(`${JSON.stringify(record)}\n`)) {
      await new Promise((r) => output.once('drain', r));
    }
  };

  try {
    for (const row of pending) {
      const listItem = normalizeListItem(row);
      let detail;
      let detailFetchFailed = false;
      try {
        detail = await fetchDetailImpl(listItem.naviGroupId);
      } catch (err) {
        // 4. A detail fetch that exhausted its retries must NOT abort the run.
        //    Fall back to the listing-only classification (detail undefined),
        //    flag it, and count it so the failure is auditable + re-runnable.
        detailFetchFailed = true;
        stats.detailFetchFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[joysound-detail-sweep] detail fetch failed for naviGroupId=${listItem.naviGroupId}: ${msg} (listing-only fallback)`,
        );
      }

      const decision = buildJoysoundDecision(listItem, {
        ...(detail ? { detail } : {}),
        ...(isKnownJapaneseArtist ? { isKnownJapaneseArtist } : {}),
      });
      // Superset of the listing sweep's DecisionRecord: same fields + the
      // failure flag + (on a successful fetch) the compacted parsed detail.
      // `build-joysound-candidate.mjs` reads `decision`,
      // `selSongNo`/`selSongNoRaw`, `naviGroupId`, `title`, `artist`,
      // `tieupInfo` — all present and unchanged — and threads `detail` into
      // `normalizeJoysoundRecord` when present (older detail-less rows stay
      // valid).
      await appendRecord({
        ...decision,
        detailFetchFailed,
        ...(detail ? { detail: compactDetail(detail) } : {}),
      });

      stats.done += 1;
      stats.fetched += 1;
      if (decision.decision === 'admit') stats.admitted += 1;
      else stats.dropped += 1;

      if (stats.done % progressEvery === 0) {
        await writeProgress();
        const elapsedMs = Date.now() - Date.parse(stats.startedAt);
        const rate = elapsedMs / stats.done;
        const remaining = pending.length - stats.done;
        console.log(
          `[joysound-detail-sweep] heartbeat: ${stats.done}/${pending.length} done ` +
            `(${stats.admitted} admit, ${stats.dropped} drop, ${stats.detailFetchFailures} fetch-fail) ` +
            `ETA ~${((rate * remaining) / 3_600_000).toFixed(2)}h`,
        );
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.end((err) => (err ? reject(err) : resolve()));
    });
  }

  stats.finishedAt = new Date().toISOString();
  await writeProgress();

  console.log(
    `[joysound-detail-sweep] done: ${stats.done} decided ` +
      `(${stats.admitted} admit, ${stats.dropped} drop), ` +
      `${stats.detailFetchFailures} detail-fetch failure(s) recorded with listing-only fallback`,
  );

  return stats;
}

function parseArgs(argv) {
  const positional = [];
  let limit;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      limit = Number(argv[++i]);
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
    } else {
      positional.push(arg);
    }
  }
  const [inPath, outPath, corpusPath] = positional;
  return { inPath, outPath, corpusPath, limit };
}

async function main() {
  const { inPath, outPath, corpusPath, limit } = parseArgs(process.argv);
  if (!inPath || !outPath || !corpusPath) {
    console.error(
      'usage: node scripts/joysound-detail-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl> <corpus-songs.json> [--limit N]',
    );
    process.exit(2);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    console.error(`[joysound-detail-sweep] --limit must be a non-negative number, got ${limit}`);
    process.exit(2);
  }

  const { parseJoysoundDetail } = await import(DIST_DETAIL.href);
  const fetchDetailImpl = makeRealFetchDetail(parseJoysoundDetail);

  await runDetailSweep({ inPath, outPath, corpusPath, fetchDetailImpl, limit });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
