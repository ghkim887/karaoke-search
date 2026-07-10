#!/usr/bin/env node
/**
 * JOYSOUND full-catalog LISTING enumerator.
 *
 * Freshly walks the ENTIRE public JOYSOUND kana-indexed songlist
 * (`/web/search/songlist/{kana}?page=N`, 72 kana buckets) and emits one JSONL
 * line per unique listing row in the exact `JoysoundListItem` contract the
 * downstream sweep normalizes:
 *   { naviGroupId, selSongNo, songName, artistName, artistId, tieupInfo, tieupId }
 *
 * Pipeline position (the v22 SWEEP lane):
 *   joysound-fullcatalog-listing.mjs  (THIS TOOL — raw listing JSONL)
 *     → joysound-detail-sweep.mjs      (per-song detail fetch + classify → decision log)
 *       → build-joysound-candidate.mjs (decision log → candidate SongRecords)
 *
 * WHY THIS TOOL EXISTS — the from-corpus prohibition:
 *   Coverage is decided by the LISTING. Re-using a stale "from-corpus" listing
 *   (deriving the row set from an already-built corpus instead of re-enumerating
 *   the live site) once dropped JOYSOUND coverage by −49,683 rows (the v22
 *   regression). This tool makes FRESH enumeration the easy, resumable path so
 *   nobody reaches for a stale listing again. Do NOT feed a corpus-derived
 *   listing into the sweep — always regenerate with this.
 *
 * Coverage safety:
 *   - Any listing-page fetch failure after the HttpClient's internal retries
 *     (429/5xx/network) HARD-ABORTS with resume state intact — a page is never
 *     silently skipped, because a skipped page is a coverage hole.
 *   - Page 1 of a kana parsing ZERO rows hard-aborts too (a site-layout-change
 *     guard), unless `--allow-empty-kana`.
 *
 * Resumable + safe for a multi-hour run:
 *   - Append-only output (createWriteStream flags 'a'); per-page rows are
 *     flushed (awaited write callback) BEFORE the progress sidecar advances, so
 *     a crash between the two only re-fetches a page (dedup drops the rows), it
 *     never skips one.
 *   - A `<out>.progress.json` sidecar (atomic tmp+rename) records the resume
 *     position ({kana, kanaIndex, nextPage, totalPages, rowsWritten, kanaFilter,
 *     …}) after each COMPLETED page.
 *   - On startup: out present + sidecar present → auto-resume (torn-tail
 *     truncate, rebuild the dedup set by STREAMING the log, continue from the
 *     sidecar position); out present & non-empty WITHOUT a sidecar → abort
 *     (protect the artifact); `--fresh` wipes both and starts over.
 *   - The log grows to multiple GB at full scale, so it is only ever STREAMED
 *     (readResumeSkipSet-style backward newline scan for the torn tail; never a
 *     whole-file readFileSync, which throws past V8's ~512MB string cap).
 *
 * Usage:
 *   node scripts/joysound-fullcatalog-listing.mjs <out-listing.jsonl> \
 *     [--kana ア,カ] [--max-pages-per-kana N] [--limit N] [--fresh] [--allow-empty-kana]
 */
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isCliInvocation } from './lib/cli.mjs';
import { loadJoysoundListingDeps } from './lib/joysound-dist.mjs';
import { streamJsonl } from './lib/jsonl.mjs';
import { endStream } from './lib/stream.mjs';

/** The dedup key: a listing row is uniquely `naviGroupId|selSongNo`. */
function rowKey(row) {
  return `${String(row.naviGroupId ?? '')}|${String(row.selSongNo ?? '')}`;
}

/**
 * Project a parsed listing item to EXACTLY the 7-field JoysoundListItem
 * contract the sweep's `normalizeListItem` reads — a fixed key order, no extra
 * fields, optionals coerced to null. `parseJoysoundListItems` already returns
 * this shape; the explicit projection pins the on-disk schema even if the
 * parser later grows a field.
 */
function toListingRow(item) {
  return {
    naviGroupId: item.naviGroupId,
    selSongNo: item.selSongNo,
    songName: item.songName,
    artistName: item.artistName,
    artistId: item.artistId ?? null,
    tieupInfo: item.tieupInfo ?? null,
    tieupId: item.tieupId ?? null,
  };
}

function progressPathFor(outPath) {
  return `${outPath}.progress.json`;
}

/**
 * If `outPath`'s final line has NO trailing newline (a crash mid-append left a
 * torn fragment), truncate it off so the next append can't weld onto it and the
 * dedup rebuild sees only whole JSON lines. Reads only backward tail chunks —
 * never the whole file, which at full-catalog scale is multiple GB and blows
 * past V8's ~512MB string cap. A `\n` (0x0A) byte can never occur inside a
 * multibyte UTF-8 sequence, so scanning raw bytes for it is exact.
 */
function truncateTornTail(outPath) {
  const fileSize = statSync(outPath).size;
  if (fileSize === 0) return;
  const buf = Buffer.allocUnsafe(Math.min(64 * 1024, fileSize));
  const fd = openSync(outPath, 'r');
  let lastNewline = -1;
  try {
    let pos = fileSize;
    while (pos > 0) {
      const readStart = Math.max(0, pos - buf.length);
      const bytesRead = readSync(fd, buf, 0, pos - readStart, readStart);
      let found = false;
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (buf[i] === 0x0a) {
          lastNewline = readStart + i;
          found = true;
          break;
        }
      }
      if (found) break;
      pos = readStart;
    }
  } finally {
    closeSync(fd);
  }
  if (lastNewline === fileSize - 1) return;
  // Byte offset through the last newline (0 when the whole file is one torn
  // line). JOYSOUND titles are UTF-8, so this is a BYTE length. Truncation is
  // O(1) (a length set, not a rewrite), so it stays cheap on a multi-GB log.
  truncateSync(outPath, lastNewline < 0 ? 0 : lastNewline + 1);
  console.warn(
    '[joysound-fullcatalog] resume: dropped a torn final line (crash mid-append); the owning page is re-fetched',
  );
}

/**
 * Rebuild the write-time dedup set from an existing (already torn-tail-truncated)
 * log by streaming it line-by-line. Never a whole-file read (multi-GB at scale).
 */
async function rebuildDedupSet(outPath) {
  const seen = new Set();
  for await (const rec of streamJsonl(outPath, { onParseError: () => {} })) {
    if (rec && typeof rec === 'object') seen.add(rowKey(rec));
  }
  return seen;
}

/**
 * Core enumeration, factored out of `main()` so tests drive it with an injected
 * `pageFetcher` (no real HTTP). The fetcher takes `(kana, page)` and returns
 * `{ items, totalPages }` — `totalPages` RAW (null → treat as a single page,
 * mirroring the class crawler's `totalPages ?? 1`). Returns run stats.
 *
 * @param {{
 *   outPath: string,
 *   pageFetcher: (kana: string, page: number) => Promise<{ items: object[], totalPages: number | null }>,
 *   kanaList: readonly string[],
 *   kanaFilter?: string | null,
 *   maxPagesPerKana?: number,
 *   limit?: number,
 *   allowEmptyKana?: boolean,
 *   fresh?: boolean,
 * }} opts
 */
export async function runFullCatalogListing({
  outPath,
  pageFetcher,
  kanaList,
  kanaFilter = null,
  maxPagesPerKana,
  limit,
  allowEmptyKana = false,
  fresh = false,
}) {
  const startedAt = Date.now();
  const sidecarPath = progressPathFor(outPath);

  if (fresh) {
    rmSync(outPath, { force: true });
    rmSync(sidecarPath, { force: true });
  }

  // --- Resume detection ---------------------------------------------------
  let dedupSet = new Set();
  let resumed = false;
  let resumeKanaIndex = 0;
  let resumeStartPage = 1;
  let resumeKnownTotal = null;
  let alreadyDone = false;

  const outSize = existsSync(outPath) ? statSync(outPath).size : 0;
  if (outSize > 0) {
    truncateTornTail(outPath);
    if (!existsSync(sidecarPath)) {
      throw new Error(
        `[joysound-fullcatalog] refusing to append to a non-empty ${outPath} with no sidecar ${sidecarPath} (cannot determine the resume position safely). Use --fresh to overwrite, or restore the sidecar.`,
      );
    }
    // The sidecar is a tiny JSON file — readFileSync is safe here (only the
    // potentially-multi-GB LOG is streamed, never whole-file-read).
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    const prevFilter = sidecar.kanaFilter ?? null;
    if (prevFilter !== kanaFilter) {
      throw new Error(
        `[joysound-fullcatalog] sidecar was written for --kana ${prevFilter ?? '(full-catalog)'} ` +
          `but this run selects ${kanaFilter ?? '(full-catalog)'}; refusing to resume. Use --fresh to start over.`,
      );
    }
    dedupSet = await rebuildDedupSet(outPath);
    resumed = true;
    resumeKanaIndex = Number(sidecar.kanaIndex ?? 0);
    resumeStartPage = Number(sidecar.nextPage ?? 1);
    resumeKnownTotal = sidecar.totalPages ?? null;
    alreadyDone = sidecar.done === true || resumeKanaIndex >= kanaList.length;
  }

  const stats = {
    rows: 0, // unique rows WRITTEN this run (excludes resumed/pre-existing)
    duplicatesSkipped: 0,
    kanaProcessed: 0,
    pagesFetched: 0,
    resumed,
  };

  // --- Output stream (append-only) ----------------------------------------
  mkdirSync(dirname(outPath), { recursive: true });
  const output = createWriteStream(outPath, { flags: 'a', encoding: 'utf8' });

  /** Append `text` and RESOLVE only once it is flushed to the fs (durability +
   *  backpressure in one — the write callback fires after the underlying
   *  fs.write completes, and writes are ordered). No-op on an empty chunk. */
  const appendAndFlush = (text) =>
    text === ''
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          output.write(text, (err) => (err ? reject(err) : resolve()));
        });

  const writeSidecar = async (state) => {
    const payload = {
      kana: state.kanaIndex < kanaList.length ? kanaList[state.kanaIndex] : null,
      kanaIndex: state.kanaIndex,
      nextPage: state.nextPage,
      totalPages: state.totalPages,
      rowsWritten: dedupSet.size,
      pagesFetched: stats.pagesFetched,
      kanaFilter,
      updatedAt: new Date().toISOString(),
      ...(state.done ? { done: true } : {}),
    };
    const tmp = `${sidecarPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, sidecarPath);
  };

  /** Buffer one page's NEW (deduped) rows into a single chunk; count dupes. */
  const collectPageChunk = (items) => {
    let chunk = '';
    for (const item of items) {
      const row = toListingRow(item);
      const key = rowKey(row);
      if (dedupSet.has(key)) {
        stats.duplicatesSkipped += 1;
        continue;
      }
      dedupSet.add(key);
      chunk += `${JSON.stringify(row)}\n`;
      stats.rows += 1;
    }
    return chunk;
  };

  const limitReached = () => typeof limit === 'number' && limit > 0 && dedupSet.size >= limit;

  try {
    let stop = alreadyDone || limitReached();
    for (let i = resumeKanaIndex; i < kanaList.length && !stop; i += 1) {
      const kana = kanaList[i];
      stats.kanaProcessed += 1;
      // Only the resumed kana keeps its sidecar-known page/total; later kana
      // start at page 1 with an unknown (null) total to resolve on page 1.
      let total = i === resumeKanaIndex ? resumeKnownTotal : null;
      let page = i === resumeKanaIndex ? resumeStartPage : 1;

      for (;;) {
        const { items, totalPages } = await pageFetcher(kana, page);
        stats.pagesFetched += 1;
        // Resolve the effective total the first time we learn it (null → 1).
        if (total === null || total === undefined) total = totalPages ?? 1;

        // Site-layout-change guard: page 1 with zero rows is almost always a
        // markup change, not a genuinely empty bucket. A resumed kana that
        // starts past page 1 already cleared this in a prior run.
        if (page === 1 && items.length === 0 && !allowEmptyKana) {
          throw new Error(
            `[joysound-fullcatalog] kana ${kana} page 1 parsed 0 listing rows — likely a site-layout change. Pass --allow-empty-kana to accept a genuinely empty bucket.`,
          );
        }

        await appendAndFlush(collectPageChunk(items));

        const effectiveTotal =
          typeof maxPagesPerKana === 'number' && maxPagesPerKana > 0
            ? Math.min(total, maxPagesPerKana)
            : total;
        const kanaDone = page >= effectiveTotal;

        // Advance the sidecar to reflect the just-COMPLETED page. Rows for this
        // page are already flushed (appendAndFlush awaited) before this, so a
        // crash between the flush and the sidecar only re-fetches the page.
        const nextState = kanaDone
          ? i + 1 < kanaList.length
            ? { kanaIndex: i + 1, nextPage: 1, totalPages: null }
            : { kanaIndex: kanaList.length, nextPage: 1, totalPages: null, done: true }
          : { kanaIndex: i, nextPage: page + 1, totalPages: total };
        await writeSidecar(nextState);

        if (limitReached()) {
          stop = true;
          break;
        }
        if (kanaDone) break;
        page += 1;
      }
    }
  } finally {
    await endStream(output);
  }

  stats.elapsedMs = Date.now() - startedAt;
  stats.totalRows = dedupSet.size;
  console.log(
    `[joysound-fullcatalog] ${resumed ? 'resumed; ' : ''}${stats.rows} new row(s), ` +
      `${dedupSet.size} total unique; ${stats.pagesFetched} page(s) fetched across ` +
      `${stats.kanaProcessed} kana; ${stats.duplicatesSkipped} duplicate(s) skipped`,
  );
  return stats;
}

function parseArgs(argv) {
  const positional = [];
  let kana;
  let maxPagesPerKana;
  let limit;
  let fresh = false;
  let allowEmptyKana = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fresh') fresh = true;
    else if (arg === '--allow-empty-kana') allowEmptyKana = true;
    else if (arg === '--kana') kana = argv[++i];
    else if (arg.startsWith('--kana=')) kana = arg.slice('--kana='.length);
    else if (arg === '--max-pages-per-kana') maxPagesPerKana = Number(argv[++i]);
    else if (arg.startsWith('--max-pages-per-kana='))
      maxPagesPerKana = Number(arg.slice('--max-pages-per-kana='.length));
    else if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else positional.push(arg);
  }
  return { outPath: positional[0], kana, maxPagesPerKana, limit, fresh, allowEmptyKana };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.outPath) {
    console.error(
      'usage: node scripts/joysound-fullcatalog-listing.mjs <out-listing.jsonl> ' +
        '[--kana ア,カ] [--max-pages-per-kana N] [--limit N] [--fresh] [--allow-empty-kana]',
    );
    process.exit(2);
  }
  for (const [name, value] of [
    ['--max-pages-per-kana', args.maxPagesPerKana],
    ['--limit', args.limit],
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      console.error(`[joysound-fullcatalog] ${name} must be a positive number, got ${value}`);
      process.exit(2);
    }
  }

  const { HttpClient, fetchJoysoundSonglistPage, JOYSOUND_FULL_CATALOG_KANA } =
    await loadJoysoundListingDeps();

  const kanaList = args.kana
    ? args.kana
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k !== '')
    : [...JOYSOUND_FULL_CATALOG_KANA];
  if (kanaList.length === 0) {
    console.error('[joysound-fullcatalog] --kana selected no kana');
    process.exit(2);
  }
  // Normalize the recorded filter so whitespace differences between runs do not
  // spuriously fail the resume consistency check.
  const kanaFilter = args.kana ? kanaList.join(',') : null;

  const http = new HttpClient();
  const pageFetcher = (kana, page) => fetchJoysoundSonglistPage(http, kana, page);

  let stats;
  try {
    stats = await runFullCatalogListing({
      outPath: args.outPath,
      pageFetcher,
      kanaList,
      kanaFilter,
      maxPagesPerKana: args.maxPagesPerKana,
      limit: args.limit,
      allowEmptyKana: args.allowEmptyKana,
      fresh: args.fresh,
    });
  } finally {
    // Persist the HttpClient's batched ETag cache so a resume gets 304s.
    if (typeof http.flush === 'function') await http.flush();
  }

  console.log(
    JSON.stringify({
      rows: stats.rows,
      duplicatesSkipped: stats.duplicatesSkipped,
      kanaProcessed: stats.kanaProcessed,
      pagesFetched: stats.pagesFetched,
      resumed: stats.resumed,
      elapsedMs: stats.elapsedMs,
    }),
  );
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
