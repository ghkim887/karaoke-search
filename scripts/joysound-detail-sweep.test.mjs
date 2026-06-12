import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDetailSweep } from './joysound-detail-sweep.mjs';

// --- Fixtures --------------------------------------------------------------

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joysound-detail-sweep-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write JSONL rows (objects) to a file. */
function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** Read a JSONL file back into an array of parsed objects (skips blanks). */
function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function listingRow(over = {}) {
  return {
    naviGroupId: '1000',
    selSongNo: '100-001',
    songName: 'よるにかける',
    artistName: 'YOASOBI',
    artistId: null,
    tieupInfo: null,
    tieupId: null,
    kana: 'よるにかける',
    page: 1,
    ...over,
  };
}

/** A minimal JoysoundDetail shape (matches parseJoysoundDetail output). */
function detailObj(over = {}) {
  return {
    naviGroupId: '1000',
    songId: null,
    selSongNo: '100001',
    songName: 'よるにかける',
    songNameRuby: null,
    artistName: null,
    artistId: null,
    lyricist: null,
    composer: null,
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreNames: [],
    tieupNames: [],
    aplServicePublishDates: [],
    ...over,
  };
}

const IN = () => join(dir, 'listing-rows.jsonl');
const OUT = () => join(dir, 'decision-log-detail.jsonl');
// No corpus path → the JP-artist recall seam stays off (production-equivalent).
const NO_CORPUS = undefined;

describe('joysound-detail-sweep runDetailSweep', () => {
  it('dedups listing rows on naviGroupId|selSongNo before fetching', async () => {
    // Three rows, two identical (same navi+sel) → 2 unique fetches expected.
    writeJsonl(IN(), [
      listingRow({ naviGroupId: '1', selSongNo: '1-1' }),
      listingRow({ naviGroupId: '1', selSongNo: '1-1' }),
      listingRow({ naviGroupId: '2', selSongNo: '2-2' }),
    ]);

    const fetched = [];
    const fetchDetailImpl = async (naviGroupId) => {
      fetched.push(naviGroupId);
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
    });

    expect(fetched.sort()).toEqual(['1', '2']);
    expect(stats.uniqueRows).toBe(2);
    expect(stats.fetched).toBe(2);
    expect(readJsonl(OUT())).toHaveLength(2);
  });

  it('emits a DecisionRecord that supersets the listing sweep shape (plus the embedded detail)', async () => {
    writeJsonl(IN(), [listingRow({ naviGroupId: '1000', selSongNo: '100-001' })]);
    const fetchDetailImpl = async () => detailObj();

    await runDetailSweep({ inPath: IN(), outPath: OUT(), corpusPath: NO_CORPUS, fetchDetailImpl });

    const [rec] = readJsonl(OUT());
    // Same fields the listing-only sweep emits, plus the failure flag and the
    // compacted parsed detail (successful fetch).
    expect(Object.keys(rec).sort()).toEqual(
      [
        'artist',
        'decision',
        'detail',
        'detailFetchFailed',
        'detailFlipRisk',
        'naviGroupId',
        'reason',
        'selSongNo',
        'selSongNoRaw',
        'tieupInfo',
        'title',
      ].sort(),
    );
    expect(rec).toMatchObject({
      selSongNo: '100001',
      selSongNoRaw: '100-001',
      naviGroupId: '1000',
      title: 'よるにかける',
      artist: 'YOASOBI',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
      detailFetchFailed: false,
    });
    // The compacted detail: null/empty-array fields omitted, names verbatim.
    expect(rec.detail).toEqual({
      naviGroupId: '1000',
      selSongNo: '100001',
      songName: 'よるにかける',
    });
  });

  it('embeds the parsed detail (sans lyricIntro, sans null/empty fields) on a successful fetch', async () => {
    writeJsonl(IN(), [listingRow({ naviGroupId: '1000', selSongNo: '100-001' })]);
    const fetchDetailImpl = async () =>
      detailObj({
        songId: 'S1',
        artistName: 'YOASOBI',
        artistNameForeign: '요아소비',
        lyricist: 'Ayase',
        composer: 'Ayase',
        relDate: '2019/12/15',
        newFlg: '0',
        lyricIntro: '沈むように溶けてゆくように…', // MUST be dropped from the log
        genreNames: ['J-POP'],
        tieupNames: [],
        aplServicePublishDates: ['2019/12/15'],
      });

    await runDetailSweep({ inPath: IN(), outPath: OUT(), corpusPath: NO_CORPUS, fetchDetailImpl });

    const [rec] = readJsonl(OUT());
    // All JoysoundDetail fields preserved verbatim EXCEPT lyricIntro (log-size
    // guard) and null/undefined/empty-array fields (omitted for compactness).
    expect(rec.detail).toEqual({
      naviGroupId: '1000',
      songId: 'S1',
      selSongNo: '100001',
      songName: 'よるにかける',
      artistName: 'YOASOBI',
      artistNameForeign: '요아소비',
      lyricist: 'Ayase',
      composer: 'Ayase',
      relDate: '2019/12/15',
      newFlg: '0',
      genreNames: ['J-POP'],
      aplServicePublishDates: ['2019/12/15'],
    });
    expect(rec.detail).not.toHaveProperty('lyricIntro');
    expect(rec.detail).not.toHaveProperty('songNameRuby'); // null → omitted
    expect(rec.detail).not.toHaveProperty('tieupNames'); // [] → omitted
  });

  it('forwards a Korean-foreign-name detail so the verdict is drop/foreign-korean', async () => {
    // Kana title (listing-only would admit-jpop-kana); the detail carries a
    // Hangul artistNameForeign → the detail-gated foreign gate flips it.
    writeJsonl(IN(), [
      listingRow({
        naviGroupId: '7',
        selSongNo: '7-7',
        songName: 'カナタイトル',
        artistName: 'チョアン',
      }),
    ]);
    const fetchDetailImpl = async (naviGroupId) =>
      detailObj({
        naviGroupId,
        selSongNo: naviGroupId,
        songName: 'カナタイトル',
        artistName: null,
        artistNameForeign: '조안',
      });

    await runDetailSweep({ inPath: IN(), outPath: OUT(), corpusPath: NO_CORPUS, fetchDetailImpl });

    const [rec] = readJsonl(OUT());
    expect(rec.decision).toBe('drop');
    expect(rec.reason).toBe('foreign-korean');
    expect(rec.detailFetchFailed).toBe(false);
  });

  it('resumes: pre-seeded naviGroupIds are skipped regardless of detail presence', async () => {
    writeJsonl(IN(), [
      listingRow({ naviGroupId: 'A', selSongNo: 'A-1' }),
      listingRow({ naviGroupId: 'B', selSongNo: 'B-1' }),
      listingRow({ naviGroupId: 'C', selSongNo: 'C-1' }),
      listingRow({ naviGroupId: 'D', selSongNo: 'D-1' }),
    ]);
    // Pre-seed the out-log with prior-run decisions for A (an OLD detail-less
    // row) and B (a NEW detail-bearing row) — the log is heterogeneous and the
    // resume skip must key on naviGroupId alone, not on detail presence.
    writeJsonl(OUT(), [
      {
        selSongNo: 'A1',
        selSongNoRaw: 'A-1',
        naviGroupId: 'A',
        title: 'prior',
        artist: 'prior',
        tieupInfo: null,
        decision: 'admit',
        reason: 'admit-jpop-kana',
        detailFlipRisk: true,
        detailFetchFailed: false,
      },
      {
        selSongNo: 'B1',
        selSongNoRaw: 'B-1',
        naviGroupId: 'B',
        title: 'prior B',
        artist: 'prior B',
        tieupInfo: null,
        decision: 'admit',
        reason: 'admit-jpop-kana',
        detailFlipRisk: true,
        detailFetchFailed: false,
        detail: { naviGroupId: 'B', selSongNo: 'B1', songName: 'prior B' },
      },
    ]);

    const fetched = [];
    const fetchDetailImpl = async (naviGroupId) => {
      fetched.push(naviGroupId);
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
    });

    // A (detail-less) and B (detail-bearing) were both skipped; C + D fetched.
    expect(fetched.sort()).toEqual(['C', 'D']);
    expect(stats.resumedSkipped).toBe(2);
    expect(stats.fetched).toBe(2);

    const out = readJsonl(OUT());
    // Pre-seeded rows preserved verbatim (appended, not rewritten) + C + D.
    expect(out).toHaveLength(4);
    expect(out[0].naviGroupId).toBe('A');
    expect(out[0].title).toBe('prior');
    expect(out[1].naviGroupId).toBe('B');
    expect(out[1].detail).toEqual({ naviGroupId: 'B', selSongNo: 'B1', songName: 'prior B' });
    expect(out.map((r) => r.naviGroupId).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('resumes a CRASH-TORN log: the torn final line never welds onto the next append', async () => {
    writeJsonl(IN(), [
      listingRow({ naviGroupId: 'A', selSongNo: 'A-1' }),
      listingRow({ naviGroupId: 'B', selSongNo: 'B-1' }),
    ]);
    // Simulate a crash mid-append: one VALID newline-terminated record for A,
    // then a TRUNCATED fragment for B with NO trailing newline (the process
    // died before finishing the line). Append mode would otherwise weld the
    // next record onto `{"selSongNo":"B1","naviGroup`.
    const validA = `${JSON.stringify({
      selSongNo: 'A1',
      selSongNoRaw: 'A-1',
      naviGroupId: 'A',
      title: 'prior A',
      artist: 'prior A',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
      detailFetchFailed: false,
    })}\n`;
    const tornB = '{"selSongNo":"B1","naviGroup'; // no newline — torn
    writeFileSync(OUT(), validA + tornB, 'utf8');

    const fetched = [];
    const fetchDetailImpl = async (naviGroupId) => {
      fetched.push(naviGroupId);
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
    });

    // A was committed (skipped); B's torn fragment did NOT seed the skip-set, so
    // B is re-fetched.
    expect(fetched).toEqual(['B']);
    expect(stats.fetched).toBe(1);

    // (b) EVERY line of the resulting log is valid JSON — the torn fragment was
    // dropped, not welded or left dangling.
    const rawLines = readFileSync(OUT(), 'utf8')
      .split(/\r?\n/u)
      .filter((l) => l.trim().length > 0);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // (a) The re-appended B record is on its own clean line (not welded onto the
    // torn fragment), and the log holds exactly A + the clean B.
    const out = readJsonl(OUT());
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.naviGroupId).sort()).toEqual(['A', 'B']);
    const bRec = out.find((r) => r.naviGroupId === 'B');
    expect(bRec.selSongNoRaw).toBe('B-1');
    expect(bRec.title).toBe('よるにかける');
    expect(bRec.decision).toBe('admit');
  });

  it('re-fetches a torn final line that is COMPLETE JSON (crash between text and newline)', async () => {
    writeJsonl(IN(), [
      listingRow({ naviGroupId: 'A', selSongNo: 'A-1' }),
      listingRow({ naviGroupId: 'B', selSongNo: 'B-1' }),
    ]);
    // Crash landed exactly BETWEEN B's record text and its trailing newline:
    // the tail fragment is COMPLETE, parseable JSON but is still torn (no
    // newline), so startup truncates it off disk. The skip-set scan must NOT
    // parse it — otherwise B would be skipped forever while being absent from
    // the (truncated) log: permanently lost.
    const validA = `${JSON.stringify({
      selSongNo: 'A1',
      selSongNoRaw: 'A-1',
      naviGroupId: 'A',
      title: 'prior A',
      artist: 'prior A',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
      detailFetchFailed: false,
    })}\n`;
    const completeTornB = JSON.stringify({
      selSongNo: 'B1',
      selSongNoRaw: 'B-1',
      naviGroupId: 'B',
      title: 'prior B',
      artist: 'prior B',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
      detailFetchFailed: false,
    }); // complete JSON — but NO trailing newline
    writeFileSync(OUT(), validA + completeTornB, 'utf8');

    const fetched = [];
    const fetchDetailImpl = async (naviGroupId) => {
      fetched.push(naviGroupId);
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
    });

    // B's torn-but-complete fragment was truncated off disk AND excluded from
    // the skip set → B is re-fetched, not lost.
    expect(fetched).toEqual(['B']);
    expect(stats.resumedSkipped).toBe(1);
    expect(stats.fetched).toBe(1);

    // The log holds A (preserved) + a FRESH B decision (with detail), and is
    // fully newline-terminated valid JSONL.
    const out = readJsonl(OUT());
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.naviGroupId).sort()).toEqual(['A', 'B']);
    const bRec = out.find((r) => r.naviGroupId === 'B');
    expect(bRec.title).toBe('よるにかける'); // fresh decision, not the torn 'prior B'
    expect(bRec).toHaveProperty('detail');
    expect(readFileSync(OUT(), 'utf8').endsWith('\n')).toBe(true);
  });

  it('records a listing-only fallback (flagged + counted) when the detail fetch fails', async () => {
    writeJsonl(IN(), [
      listingRow({ naviGroupId: 'OK', selSongNo: 'OK-1' }),
      listingRow({
        naviGroupId: 'BAD',
        selSongNo: 'BAD-1',
        songName: 'よるにかける',
        artistName: 'YOASOBI',
      }),
    ]);

    const fetchDetailImpl = async (naviGroupId) => {
      if (naviGroupId === 'BAD') throw new Error('boom after retries');
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
    });

    // The run did NOT abort: both rows produced a DecisionRecord.
    expect(stats.detailFetchFailures).toBe(1);
    expect(stats.fetched).toBe(2);
    const out = readJsonl(OUT());
    expect(out).toHaveLength(2);
    const bad = out.find((r) => r.naviGroupId === 'BAD');
    // Listing-only classification preserved (kana admit) + flagged.
    expect(bad.detailFetchFailed).toBe(true);
    expect(bad.decision).toBe('admit');
    expect(bad.reason).toBe('admit-jpop-kana');
    // No detail was fetched → the row carries NO `detail` key at all.
    expect(bad).not.toHaveProperty('detail');
    // …while the successful row alongside it DOES embed its detail.
    const ok = out.find((r) => r.naviGroupId === 'OK');
    expect(ok.detailFetchFailed).toBe(false);
    expect(ok).toHaveProperty('detail');
  });

  it('honors --limit by capping at the first N unique rows', async () => {
    writeJsonl(IN(), [
      listingRow({ naviGroupId: '1', selSongNo: '1-1' }),
      listingRow({ naviGroupId: '2', selSongNo: '2-2' }),
      listingRow({ naviGroupId: '3', selSongNo: '3-3' }),
    ]);

    const fetched = [];
    const fetchDetailImpl = async (naviGroupId) => {
      fetched.push(naviGroupId);
      return detailObj({ naviGroupId, selSongNo: naviGroupId });
    };

    const stats = await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
      limit: 2,
    });

    expect(stats.fetched).toBe(2);
    expect(fetched).toHaveLength(2);
    expect(readJsonl(OUT())).toHaveLength(2);
  });

  it('writes a progress sidecar', async () => {
    writeJsonl(IN(), [listingRow({ naviGroupId: '1', selSongNo: '1-1' })]);
    const fetchDetailImpl = async (naviGroupId) =>
      detailObj({ naviGroupId, selSongNo: naviGroupId });

    await runDetailSweep({
      inPath: IN(),
      outPath: OUT(),
      corpusPath: NO_CORPUS,
      fetchDetailImpl,
      progressEvery: 1,
    });

    const progress = JSON.parse(readFileSync(`${OUT()}.progress.json`, 'utf8'));
    expect(progress.done).toBe(1);
    expect(progress.fetched).toBe(1);
    expect(progress.detailFetchFailures).toBe(0);
  });
});
