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
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isCliInvocation } from './lib/cli.mjs';
import { loadJoysoundClassifier, loadJoysoundDetailParser } from './lib/joysound-dist.mjs';
import { buildKnownJapaneseArtistPredicate } from './lib/joysound-jp-artist.mjs';
import { streamJsonl } from './lib/jsonl.mjs';
import { endStream, writeLineBackpressured } from './lib/stream.mjs';

// Re-exported so `joysound-replay-classifier.mjs` (and callers pre-dating the
// lib extraction) can rebuild the EXACT predicate this sweep classified with;
// the canonical implementation lives in scripts/lib/joysound-jp-artist.mjs.
export { buildKnownJapaneseArtistPredicate };

const UA = 'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';
const DETAIL_BASE = 'https://www.joysound.com/apis/v1/ise/fetchContentsDetail';
const MIN_INTERVAL_MS = Number(process.env.JOYSOUND_DETAIL_MIN_INTERVAL_MS ?? 250);
const JITTER_MS = Number(process.env.JOYSOUND_DETAIL_JITTER_MS ?? 80);
const MAX_RETRIES = Number(process.env.JOYSOUND_DETAIL_MAX_RETRIES ?? 3);
const BODY_SIZE_LIMIT = 50 * 1024 * 1024;
const DEFAULT_PROGRESS_EVERY = 200;

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
  const onParseError = (err) => {
    total += 1;
    parseErrors += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[joysound-detail-sweep] skipping unparseable listing line ${total}: ${msg}`);
  };
  for await (const row of streamJsonl(inPath, { onParseError })) {
    total += 1;
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (typeof limit === 'number' && limit > 0 && rows.length >= limit) break;
  }
  return { rows, total, uniqueRows: rows.length, parseErrors };
}

/**
 * Byte offset of the FINAL `\n` in `outPath` (0-based), or -1 when the file has
 * none, plus the file size. Reads only backward tail chunks — never the whole
 * file, which at fullCatalog scale is multiple GB and blows past V8's ~512MB
 * string cap. A `\n` (0x0A) byte can never occur inside a multibyte UTF-8
 * sequence, so scanning raw bytes for it is exact regardless of the log's text.
 */
function scanNewlineBounds(outPath) {
  const fileSize = statSync(outPath).size;
  if (fileSize === 0) return { fileSize: 0, lastNewlineByteOffset: -1 };
  const buf = Buffer.allocUnsafe(Math.min(64 * 1024, fileSize));
  const fd = openSync(outPath, 'r');
  try {
    let pos = fileSize;
    while (pos > 0) {
      const readStart = Math.max(0, pos - buf.length);
      const bytesRead = readSync(fd, buf, 0, pos - readStart, readStart);
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (buf[i] === 0x0a) return { fileSize, lastNewlineByteOffset: readStart + i };
      }
      pos = readStart;
    }
    return { fileSize, lastNewlineByteOffset: -1 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the existing out-decision-log (if present) and return the set of
 * `naviGroupId`s already decided. Resume mechanism: those rows are skipped and
 * the file is APPENDED, never rewritten — so a crash mid-run loses at most the
 * in-flight row, not the whole log. The log grows to multiple GB, so both the
 * torn-line scan and the skip-set scan STREAM the file (never a whole-file
 * `readFileSync`, which throws past V8's ~512MB string cap).
 */
export async function readResumeSkipSet(outPath) {
  const skip = new Set();
  if (!existsSync(outPath)) return skip;
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
  const { fileSize, lastNewlineByteOffset } = scanNewlineBounds(outPath);
  const endsWithNewline = fileSize > 0 && lastNewlineByteOffset === fileSize - 1;
  if (fileSize > 0 && !endsWithNewline) {
    // Byte offset through the last newline (0 when the whole file is one torn
    // line). The log is ASCII-safe JSON but JOYSOUND titles are UTF-8, so this
    // is a BYTE length.
    const keepBytes = lastNewlineByteOffset < 0 ? 0 : lastNewlineByteOffset + 1;
    truncateSync(outPath, keepBytes);
    console.warn(
      '[joysound-detail-sweep] resume: dropped a torn final line (crash mid-append); the owning row is re-fetched',
    );
  }
  // Scan ONLY the kept prefix (everything through the last newline). After the
  // truncation above the on-disk file IS that prefix and ends with a newline, so
  // streaming every line yields exactly the surviving records — the torn
  // fragment is physically gone and never enters the skip set (which would
  // otherwise leave its row permanently unfetched). When the whole file was one
  // torn line it is now empty and nothing is parsed. A corrupt INTERIOR line is
  // skipped silently (it should never happen: every append is one
  // newline-terminated JSON.stringify).
  let kept = 0;
  for await (const rec of streamJsonl(outPath, {
    onParseError: () => {
      /* corrupt interior line: skip silently, matching the prior empty catch */
    },
  })) {
    if (rec && typeof rec.naviGroupId === 'string' && rec.naviGroupId !== '') {
      skip.add(rec.naviGroupId);
      kept += 1;
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
  const { buildJoysoundDecision } = await loadJoysoundClassifier('joysound-detail-sweep');

  const isKnownJapaneseArtist = await buildKnownJapaneseArtistPredicate(corpusPath, {
    label: 'joysound-detail-sweep',
  });

  // 1. Dedup the listing rows (and apply --limit) before any fetch.
  const { rows, total, uniqueRows, parseErrors } = await readUniqueRows(inPath, limit);

  // 2. Resume: drop rows already decided in a prior run. The skip-set is keyed
  //    on `naviGroupId` ALONE (the detail fetch is per-naviGroupId), which is
  //    safe because the listing's naviGroupId↔selSongNo is 1:1 (verified:
  //    291,253 unique naviGroupIds, none mapping to >1 selSongNo). A future
  //    multi-sel listing dump would break that — it would skip every selSongNo
  //    under an already-seen naviGroupId, not just the decided one.
  const skip = await readResumeSkipSet(outPath);
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

  const appendRecord = (record) => writeLineBackpressured(output, `${JSON.stringify(record)}\n`);

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
    await endStream(output);
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

  const { parseJoysoundDetail } = await loadJoysoundDetailParser();
  const fetchDetailImpl = makeRealFetchDetail(parseJoysoundDetail);

  await runDetailSweep({ inPath, outPath, corpusPath, fetchDetailImpl, limit });
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
