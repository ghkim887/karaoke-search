import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFullCatalogListing } from './joysound-fullcatalog-listing.mjs';

// --- Fixtures --------------------------------------------------------------

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joysound-fullcatalog-listing-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OUT = () => join(dir, 'listing.jsonl');
const SIDECAR = () => `${OUT()}.progress.json`;

/** A parsed listing item as `parseJoysoundListItems` would yield it. */
function item(naviGroupId, selSongNo, over = {}) {
  return {
    naviGroupId,
    selSongNo,
    songName: `song-${naviGroupId}`,
    artistName: `artist-${naviGroupId}`,
    artistId: null,
    tieupInfo: null,
    tieupId: null,
    ...over,
  };
}

/** The exact on-disk row the tool writes for `item(...)`. */
function expectedRow(naviGroupId, selSongNo, over = {}) {
  return {
    naviGroupId,
    selSongNo,
    songName: `song-${naviGroupId}`,
    artistName: `artist-${naviGroupId}`,
    artistId: null,
    tieupInfo: null,
    tieupId: null,
    ...over,
  };
}

/**
 * Build an injectable page fetcher over a `{ kana: [ [page1 items], … ] }`
 * catalog. `totalPages` is the page count (null when the kana has no pages, to
 * exercise the null → 1-page fallback + the empty-kana guard). `fail(kana,page)`
 * throws to simulate a listing-page fetch failure after retries.
 */
function makePageFetcher(catalog, { fail } = {}) {
  const calls = [];
  const fetch = async (kana, page) => {
    calls.push(`${kana}:${page}`);
    if (fail?.(kana, page)) throw new Error(`simulated fetch failure ${kana}:${page}`);
    const pages = catalog[kana] ?? [];
    return { items: pages[page - 1] ?? [], totalPages: pages.length || null };
  };
  return { fetch, calls };
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// --- Tests -----------------------------------------------------------------

describe('joysound-fullcatalog-listing runFullCatalogListing', () => {
  it('walks kana in order, paginates, and writes the exact 7-field row schema', async () => {
    const catalog = {
      ア: [
        [item('1', '1-1'), item('2', '2-2', { artistId: 'a2', tieupInfo: 'anime', tieupId: 't2' })],
        [item('3', '3-3')],
      ],
      カ: [[item('4', '4-4')]],
    };
    const { fetch, calls } = makePageFetcher(catalog);

    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: fetch,
      kanaList: ['ア', 'カ'],
      kanaFilter: 'ア,カ',
    });

    expect(calls).toEqual(['ア:1', 'ア:2', 'カ:1']);
    expect(stats.rows).toBe(4);
    expect(stats.pagesFetched).toBe(3);
    expect(stats.kanaProcessed).toBe(2);
    expect(stats.duplicatesSkipped).toBe(0);
    expect(stats.resumed).toBe(false);

    const rows = readJsonl(OUT());
    expect(rows).toHaveLength(4);
    // Fixed key order + exactly the 7 fields the sweep's normalizeListItem reads.
    expect(Object.keys(rows[0])).toEqual([
      'naviGroupId',
      'selSongNo',
      'songName',
      'artistName',
      'artistId',
      'tieupInfo',
      'tieupId',
    ]);
    expect(rows).toEqual([
      expectedRow('1', '1-1'),
      expectedRow('2', '2-2', { artistId: 'a2', tieupInfo: 'anime', tieupId: 't2' }),
      expectedRow('3', '3-3'),
      expectedRow('4', '4-4'),
    ]);

    // The completed run marks the sidecar done.
    const sidecar = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    expect(sidecar.done).toBe(true);
    expect(sidecar.rowsWritten).toBe(4);
  });

  it('dedups on naviGroupId|selSongNo at write time (first wins), counting duplicates', async () => {
    const catalog = {
      ア: [
        [item('1', '1-1'), item('2', '2-2')],
        [item('2', '2-2'), item('3', '3-3')], // '2|2-2' repeats across pages
      ],
    };
    const { fetch } = makePageFetcher(catalog);

    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
    });

    expect(stats.rows).toBe(3);
    expect(stats.duplicatesSkipped).toBe(1);
    expect(readJsonl(OUT()).map((r) => r.naviGroupId)).toEqual(['1', '2', '3']);
  });

  it('honors --max-pages-per-kana as a per-kana page cap', async () => {
    const catalog = {
      ア: [[item('1', '1-1')], [item('2', '2-2')], [item('3', '3-3')]], // 3 pages
    };
    const { fetch, calls } = makePageFetcher(catalog);

    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
      maxPagesPerKana: 2,
    });

    expect(calls).toEqual(['ア:1', 'ア:2']); // page 3 never fetched
    expect(stats.rows).toBe(2);
  });

  it('resumes from the sidecar position without refetching completed pages', async () => {
    const catalog = {
      ア: [[item('1', '1-1')], [item('2', '2-2')]],
      カ: [[item('3', '3-3')]],
    };
    // Run 1 fails at カ:1 → ア fully done, then abort.
    const first = makePageFetcher(catalog, { fail: (k, p) => k === 'カ' && p === 1 });
    await expect(
      runFullCatalogListing({
        outPath: OUT(),
        pageFetcher: first.fetch,
        kanaList: ['ア', 'カ'],
        kanaFilter: 'ア,カ',
      }),
    ).rejects.toThrow(/simulated fetch failure カ:1/);
    expect(first.calls).toEqual(['ア:1', 'ア:2', 'カ:1']);

    // Run 2: clean fetcher. Must resume at カ:1 and NOT refetch ア.
    const second = makePageFetcher(catalog);
    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: second.fetch,
      kanaList: ['ア', 'カ'],
      kanaFilter: 'ア,カ',
    });

    expect(second.calls).toEqual(['カ:1']);
    expect(stats.resumed).toBe(true);
    expect(stats.rows).toBe(1); // only カ's new row this run
    expect(readJsonl(OUT()).map((r) => r.naviGroupId)).toEqual(['1', '2', '3']);
  });

  it('a completed resume re-run fetches nothing and writes no new rows', async () => {
    const catalog = { ア: [[item('1', '1-1')], [item('2', '2-2')]] };
    await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: makePageFetcher(catalog).fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
    });

    const rerun = makePageFetcher(catalog);
    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: rerun.fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
    });

    expect(rerun.calls).toEqual([]);
    expect(stats.resumed).toBe(true);
    expect(stats.rows).toBe(0);
    expect(stats.pagesFetched).toBe(0);
    expect(readJsonl(OUT())).toHaveLength(2);
  });

  it('drops a torn final line on resume and continues without welding', async () => {
    const catalog = { ア: [[item('1', '1-1')], [item('2', '2-2')]] };
    // Simulate a crash after ア page 1 committed, mid-write of a page-2 row.
    const validLine = `${JSON.stringify(expectedRow('1', '1-1'))}\n`;
    const tornFragment = '{"naviGroupId":"2","selSong'; // no newline — torn
    writeFileSync(OUT(), validLine + tornFragment, 'utf8');
    writeFileSync(
      SIDECAR(),
      `${JSON.stringify({
        kana: 'ア',
        kanaIndex: 0,
        nextPage: 2,
        totalPages: 2,
        rowsWritten: 1,
        kanaFilter: 'ア',
        updatedAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );

    const { fetch, calls } = makePageFetcher(catalog);
    await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
    });

    // ア page 1 was already committed → only page 2 is fetched.
    expect(calls).toEqual(['ア:2']);
    // Every surviving line is valid JSON (the torn fragment was truncated off,
    // not welded onto the next append).
    const raw = readFileSync(OUT(), 'utf8')
      .split(/\r?\n/u)
      .filter((l) => l.trim().length > 0);
    for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
    expect(readJsonl(OUT()).map((r) => r.naviGroupId)).toEqual(['1', '2']);
    expect(readFileSync(OUT(), 'utf8').endsWith('\n')).toBe(true);
  });

  it('hard-aborts on a page-1 kana with zero rows (site-layout guard)', async () => {
    const catalog = { ア: [] }; // no pages → totalPages null, page 1 empty
    const { fetch } = makePageFetcher(catalog);
    await expect(
      runFullCatalogListing({
        outPath: OUT(),
        pageFetcher: fetch,
        kanaList: ['ア'],
        kanaFilter: 'ア',
      }),
    ).rejects.toThrow(/parsed 0 listing rows/);
  });

  it('accepts an empty kana under --allow-empty-kana', async () => {
    const catalog = { ア: [], カ: [[item('9', '9-9')]] };
    const { fetch } = makePageFetcher(catalog);
    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: fetch,
      kanaList: ['ア', 'カ'],
      kanaFilter: 'ア,カ',
      allowEmptyKana: true,
    });

    expect(stats.rows).toBe(1);
    expect(readJsonl(OUT()).map((r) => r.naviGroupId)).toEqual(['9']);
  });

  it('a fetch-failure abort leaves the sidecar + flushed log intact for resume', async () => {
    const catalog = { ア: [[item('1', '1-1')], [item('2', '2-2')]] };
    const failing = makePageFetcher(catalog, { fail: (k, p) => k === 'ア' && p === 2 });

    await expect(
      runFullCatalogListing({
        outPath: OUT(),
        pageFetcher: failing.fetch,
        kanaList: ['ア'],
        kanaFilter: 'ア',
      }),
    ).rejects.toThrow(/simulated fetch failure ア:2/);

    // Page 1's rows are durably on disk, and the sidecar points at page 2.
    expect(readJsonl(OUT()).map((r) => r.naviGroupId)).toEqual(['1']);
    const sidecar = JSON.parse(readFileSync(SIDECAR(), 'utf8'));
    expect(sidecar).toMatchObject({ kanaIndex: 0, nextPage: 2, totalPages: 2, kanaFilter: 'ア' });
  });

  it('refuses to append to a non-empty log with no sidecar', async () => {
    writeFileSync(OUT(), `${JSON.stringify(expectedRow('1', '1-1'))}\n`, 'utf8');
    // No sidecar written.
    await expect(
      runFullCatalogListing({
        outPath: OUT(),
        pageFetcher: makePageFetcher({ ア: [[item('1', '1-1')]] }).fetch,
        kanaList: ['ア'],
        kanaFilter: 'ア',
      }),
    ).rejects.toThrow(/no sidecar/);
  });

  it('refuses to resume when the sidecar kana filter differs', async () => {
    writeFileSync(OUT(), `${JSON.stringify(expectedRow('1', '1-1'))}\n`, 'utf8');
    writeFileSync(
      SIDECAR(),
      `${JSON.stringify({ kanaIndex: 0, nextPage: 2, totalPages: 2, kanaFilter: 'ア,カ' })}\n`,
      'utf8',
    );
    await expect(
      runFullCatalogListing({
        outPath: OUT(),
        pageFetcher: makePageFetcher({ ア: [[item('1', '1-1')]] }).fetch,
        kanaList: ['ア'],
        kanaFilter: 'ア',
      }),
    ).rejects.toThrow(/does not match|refusing to resume/);
  });

  it('--fresh wipes an existing log + sidecar and starts over', async () => {
    writeFileSync(OUT(), `${JSON.stringify(expectedRow('99', '99-9'))}\n`, 'utf8');
    writeFileSync(
      SIDECAR(),
      `${JSON.stringify({ kanaIndex: 5, nextPage: 3, kanaFilter: null })}\n`,
      'utf8',
    );

    const catalog = { ア: [[item('1', '1-1')]] };
    const stats = await runFullCatalogListing({
      outPath: OUT(),
      pageFetcher: makePageFetcher(catalog).fetch,
      kanaList: ['ア'],
      kanaFilter: 'ア',
      fresh: true,
    });

    expect(stats.resumed).toBe(false);
    expect(stats.rows).toBe(1);
    // The stale row is gone; only the fresh row remains.
    expect(readJsonl(OUT())).toEqual([expectedRow('1', '1-1')]);
    expect(existsSync(SIDECAR())).toBe(true);
    expect(JSON.parse(readFileSync(SIDECAR(), 'utf8')).kanaFilter).toBe('ア');
  });
});
