import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyFlip,
  flipPurityViolation,
  parseArgs,
  rebuildListItem,
  rehydrateDetail,
  runReplay,
} from './joysound-replay-classifier.mjs';

const YOUGAKU = '洋楽';

// --- Pure helpers ------------------------------------------------------------

describe('rebuildListItem', () => {
  it('prefers selSongNoRaw and maps title/artist back to songName/artistName', () => {
    expect(
      rebuildListItem({
        selSongNo: '100001',
        selSongNoRaw: '100-001',
        naviGroupId: '1000',
        title: 'よるにかける',
        artist: 'YOASOBI',
        tieupInfo: '映画「X」主題歌',
      }),
    ).toEqual({
      naviGroupId: '1000',
      selSongNo: '100-001',
      songName: 'よるにかける',
      artistName: 'YOASOBI',
      artistId: null,
      tieupInfo: '映画「X」主題歌',
      tieupId: null,
    });
  });

  it('falls back to selSongNo when selSongNoRaw is absent and nulls absent tieupInfo', () => {
    const item = rebuildListItem({
      selSongNo: '100001',
      naviGroupId: '1000',
      title: 'T',
      artist: 'A',
    });
    expect(item.selSongNo).toBe('100001');
    expect(item.tieupInfo).toBeNull();
  });
});

describe('rehydrateDetail', () => {
  it('restores compacted-away fields to the JoysoundDetail defaults', () => {
    // compactDetail omits null/undefined/empty-array values and drops
    // lyricIntro entirely — the classifier spreads genreNames/tieupNames, so
    // they MUST come back as arrays.
    const detail = rehydrateDetail({
      naviGroupId: '1000',
      selSongNo: '100001',
      songName: 'Song',
    });
    expect(detail.genreNames).toEqual([]);
    expect(detail.tieupNames).toEqual([]);
    expect(detail.aplServicePublishDates).toEqual([]);
    for (const key of [
      'songId',
      'songNameRuby',
      'artistName',
      'artistId',
      'lyricist',
      'composer',
      'relDate',
      'newFlg',
      'lyricIntro',
    ]) {
      expect(detail[key], `${key} should default to null`).toBeNull();
    }
  });

  it('keeps persisted fields verbatim (incl. foreign-name fields)', () => {
    const detail = rehydrateDetail({
      naviGroupId: '1000',
      selSongNo: '100001',
      songName: 'Song',
      artistName: 'Act',
      genreNames: [YOUGAKU],
      artistNameForeign: '한글',
    });
    expect(detail.artistName).toBe('Act');
    expect(detail.genreNames).toEqual([YOUGAKU]);
    expect(detail.artistNameForeign).toBe('한글');
  });

  it('does NOT invent absent optional foreign-name fields (only-assign-when-present contract)', () => {
    const detail = rehydrateDetail({ naviGroupId: '1', selSongNo: '1', songName: 'S' });
    for (const key of [
      'songNameForeign',
      'songNameForeignSearch',
      'artistNameForeign',
      'artistNameForeignSearch',
    ]) {
      expect(key in detail, `${key} must stay absent`).toBe(false);
    }
  });
});

describe('classifyFlip', () => {
  const base = {
    selSongNo: '123456',
    naviGroupId: '99',
    title: 'T',
    artist: 'A',
    decision: 'admit',
    reason: 'admit-jp-detail',
  };

  it('returns null when the decision is unchanged (even if the reason sharpened)', () => {
    expect(classifyFlip(base, { decision: 'admit', reason: 'admit-anime' })).toBeNull();
  });

  it('classifies admit→drop and carries the original genreNames', () => {
    const flip = classifyFlip(
      { ...base, detail: { genreNames: [YOUGAKU] } },
      { decision: 'drop', reason: 'drop-ascii-only' },
    );
    expect(flip).toMatchObject({
      kind: 'admit->drop',
      selSongNo: '123456',
      oldReason: 'admit-jp-detail',
      newReason: 'drop-ascii-only',
      genreNames: [YOUGAKU],
    });
  });

  it('classifies drop→admit and defaults genreNames for detail-less rows', () => {
    const flip = classifyFlip(
      { ...base, decision: 'drop', reason: 'drop-ascii-only' },
      { decision: 'admit', reason: 'admit-jp-detail' },
    );
    expect(flip).toMatchObject({ kind: 'drop->admit', genreNames: [] });
  });
});

describe('flipPurityViolation', () => {
  const admitToDrop = {
    kind: 'admit->drop',
    selSongNo: '123456',
    naviGroupId: '99',
    title: 'T',
    artist: 'A',
    oldReason: 'admit-jp-detail',
    newReason: 'drop-ascii-only',
    genreNames: [],
  };

  it('allows an admit→drop flip carrying the 洋楽 genre when the old reason was admit-jp-detail', () => {
    expect(flipPurityViolation({ ...admitToDrop, genreNames: ['POPS', YOUGAKU] })).toBeNull();
  });

  it('flags a 洋楽 admit→drop flip whose old reason was NOT admit-jp-detail (veto scoping proof)', () => {
    // The veto is scoped to the step-6 recovery: a 洋楽 row losing an
    // admit-anime / admit-jpop-kana / admit-jp-artist verdict means the veto
    // leaked into another gate and the purity gate must fail.
    for (const oldReason of ['admit-anime', 'admit-jpop-kana', 'admit-jp-artist']) {
      expect(
        flipPurityViolation({ ...admitToDrop, oldReason, genreNames: [YOUGAKU] }),
        `oldReason=${oldReason} must violate`,
      ).toMatch(/not a 洋楽-vetoed admit-jp-detail row/);
    }
  });

  it('allows the 2 curated DROP overrides without a genre', () => {
    expect(flipPurityViolation({ ...admitToDrop, selSongNo: '154010' })).toBeNull();
    expect(flipPurityViolation({ ...admitToDrop, selSongNo: '488568' })).toBeNull();
  });

  it('flags an admit→drop flip with neither 洋楽 nor a curated DROP', () => {
    expect(flipPurityViolation(admitToDrop)).toMatch(
      /not a 洋楽-vetoed admit-jp-detail row and not a curated DROP/,
    );
  });

  it('flags every drop→admit flip outside the curated ALLOW set', () => {
    expect(
      flipPurityViolation({
        ...admitToDrop,
        kind: 'drop->admit',
        newReason: 'reviewed-allow', // even the right reason may not admit a non-whitelisted number
        genreNames: [YOUGAKU], // even a 洋楽 row may not GAIN admission
      }),
    ).toMatch(/forbidden drop→admit flip/);
  });

  it('allows the curated ALLOW drop→admit flip ONLY via reviewed-allow', () => {
    // 2026-06-12 owner-approved recall recovery: 623552 (LEveL /
    // SawanoHiroyuki[nZk]:TOMORROW X TOGETHER) may flip drop→admit, but ONLY
    // through the exact-number override gate (`reviewed-allow`).
    const allowFlip = {
      ...admitToDrop,
      kind: 'drop->admit',
      selSongNo: '623552',
      oldReason: 'foreign-korean',
      newReason: 'reviewed-allow',
    };
    expect(flipPurityViolation(allowFlip)).toBeNull();
    // The same whitelisted number admitting via any ORGANIC gate means the
    // recovery leaked past the override and must still violate.
    for (const newReason of ['admit-jp-detail', 'admit-anime', 'admit-jpop-kana']) {
      expect(
        flipPurityViolation({ ...allowFlip, newReason }),
        `newReason=${newReason} must violate`,
      ).toMatch(/forbidden drop→admit flip/);
    }
  });
});

describe('parseArgs', () => {
  it('returns defaults with no arguments', () => {
    const opts = parseArgs(['node', 'script']);
    expect(opts.help).toBe(false);
    expect(opts.inPath).toMatch(/decision-log\.jsonl$/);
    expect(opts.outPath).toMatch(/decision-log\.replayed\.jsonl$/);
    expect(opts.flipsOutPath).toMatch(/decision-log\.replay-flips\.jsonl$/);
  });

  it('accepts both --flag value and --flag=value forms', () => {
    const opts = parseArgs(['node', 'script', '--in', 'a.jsonl', '--out=b.jsonl']);
    expect(opts.inPath).toBe('a.jsonl');
    expect(opts.outPath).toBe('b.jsonl');
  });

  it('sets help on --help and throws on an unknown argument', () => {
    expect(parseArgs(['node', 'script', '--help']).help).toBe(true);
    expect(() => parseArgs(['node', 'script', '--bogus'])).toThrow(/unknown argument/);
  });
});

// --- runReplay integration (uses the built crawler dist, like the sweep tests) -

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joysound-replay-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** A decision-log row in the detail-sweep shape (compacted detail). */
function logRow(over = {}) {
  return {
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
    detail: { naviGroupId: '1000', selSongNo: '100001', songName: 'よるにかける' },
    ...over,
  };
}

describe('runReplay', () => {
  it('replays unchanged rows verbatim and flips only the expected rows (purity OK)', async () => {
    const inPath = join(dir, 'decision-log.jsonl');
    const outPath = join(dir, 'replayed.jsonl');
    const flipsOutPath = join(dir, 'flips.jsonl');
    writeJsonl(inPath, [
      // 1. Unchanged kana admit.
      logRow(),
      // 2. 洋楽-tagged Latin row previously recovered via admit-jp-detail —
      //    the veto now drops it (allowed flip).
      logRow({
        selSongNo: '200002',
        selSongNoRaw: '200-002',
        naviGroupId: '2000',
        title: 'MY WAY',
        artist: 'FRANK SINATRA',
        reason: 'admit-jp-detail',
        detailFlipRisk: false,
        detail: {
          naviGroupId: '2000',
          selSongNo: '200002',
          songName: 'MY WAY',
          artistName: 'FRANK SINATRA',
          genreNames: [YOUGAKU],
        },
      }),
      // 3. Curated DROP override (no genreNames at all — allowed flip).
      logRow({
        selSongNo: '154010',
        selSongNoRaw: '154010',
        naviGroupId: '3000',
        title: 'KUNIN MO NA ANG LAHAT SA AKIN',
        artist: 'ANGELINE QUINTO',
        reason: 'admit-jp-detail',
        detailFlipRisk: false,
        detail: {
          naviGroupId: '3000',
          selSongNo: '154010',
          songName: 'KUNIN MO NA ANG LAHAT SA AKIN',
          artistName: 'ANGELINE QUINTO',
        },
      }),
      // 4. Detail-less fetch-failure row replays listing-only, unchanged.
      logRow({
        selSongNo: '400004',
        selSongNoRaw: '400-004',
        naviGroupId: '4000',
        title: 'さくら',
        artist: 'ケツメイシ',
        detailFetchFailed: true,
        detail: undefined,
      }),
      // 5. Curated ALLOW recovery (2026-06-12): the sweep dropped LEveL as
      //    foreign-korean; the override now admits it (allowed drop→admit flip).
      logRow({
        selSongNo: '623552',
        selSongNoRaw: '623552',
        naviGroupId: '1004806',
        title: 'LEveL',
        artist: 'SawanoHiroyuki[nZk]:TOMORROW X TOGETHER',
        decision: 'drop',
        reason: 'foreign-korean',
        detailFlipRisk: false,
        detail: {
          naviGroupId: '1004806',
          selSongNo: '623552',
          songName: 'LEveL',
          artistName: 'SawanoHiroyuki[nZk]:TOMORROW X TOGETHER',
          genreNames: ['アニメ', '魔法・ファンタジー'],
          tieupNames: ['俺だけレベルアップな件'],
        },
      }),
    ]);

    const stats = await runReplay({ inPath, outPath, flipsOutPath, corpusPath: undefined });

    expect(stats.rows).toBe(5);
    expect(stats.changed).toBe(3);
    expect(stats.admitToDrop).toBe(2);
    expect(stats.dropToAdmit).toBe(1);
    expect(stats.violationCount).toBe(0);
    expect(Object.fromEntries(stats.reasonPairs)).toEqual({
      'admit-jp-detail → drop-ascii-only': 1,
      'admit-jp-detail → reviewed-drop': 1,
      'foreign-korean → reviewed-allow': 1,
    });

    const replayed = readJsonl(outPath);
    expect(replayed).toHaveLength(5);
    // Order preserved; non-verdict fields verbatim (incl. the compacted detail).
    expect(replayed.map((r) => r.selSongNo)).toEqual([
      '100001',
      '200002',
      '154010',
      '400004',
      '623552',
    ]);
    expect(replayed[0]).toEqual(logRow());
    expect(replayed[1].decision).toBe('drop');
    expect(replayed[1].reason).toBe('drop-ascii-only');
    expect(replayed[1].detail.genreNames).toEqual([YOUGAKU]); // detail untouched
    expect(replayed[2].decision).toBe('drop');
    expect(replayed[2].reason).toBe('reviewed-drop');
    expect(replayed[3].decision).toBe('admit');
    expect(replayed[3].reason).toBe('admit-jpop-kana');
    expect(replayed[4].decision).toBe('admit');
    expect(replayed[4].reason).toBe('reviewed-allow');

    const flips = readJsonl(flipsOutPath);
    expect(flips.map((f) => [f.selSongNo, f.kind, f.newReason])).toEqual([
      ['200002', 'admit->drop', 'drop-ascii-only'],
      ['154010', 'admit->drop', 'reviewed-drop'],
      ['623552', 'drop->admit', 'reviewed-allow'],
    ]);
    // No stray .tmp files left at the final paths' side.
    expect(existsSync(`${outPath}.tmp`)).toBe(false);
    expect(existsSync(`${flipsOutPath}.tmp`)).toBe(false);
  });

  it('counts purity violations for unexpected flips in BOTH directions', async () => {
    const inPath = join(dir, 'decision-log.jsonl');
    const outPath = join(dir, 'replayed.jsonl');
    const flipsOutPath = join(dir, 'flips.jsonl');
    writeJsonl(inPath, [
      // admit→drop with neither 洋楽 nor curated DROP: a Hangul foreign-name
      // makes the current classifier drop a row the old log admitted.
      logRow({
        selSongNo: '500005',
        selSongNoRaw: '500-005',
        naviGroupId: '5000',
        detail: {
          naviGroupId: '5000',
          selSongNo: '500005',
          songName: 'よるにかける',
          artistNameForeign: '한글',
        },
      }),
      // drop→admit: the old log dropped a row the current classifier recovers.
      logRow({
        selSongNo: '600006',
        selSongNoRaw: '600-006',
        naviGroupId: '6000',
        title: 'Plain Latin',
        artist: 'SomeJpAct',
        decision: 'drop',
        reason: 'drop-ascii-only',
        detail: {
          naviGroupId: '6000',
          selSongNo: '600006',
          songName: 'Plain Latin',
          artistName: 'SomeJpAct',
        },
      }),
    ]);

    const stats = await runReplay({ inPath, outPath, flipsOutPath, corpusPath: undefined });

    expect(stats.changed).toBe(2);
    expect(stats.admitToDrop).toBe(1);
    expect(stats.dropToAdmit).toBe(1);
    expect(stats.violationCount).toBe(2);
    expect(stats.violations[0]).toMatch(/not a 洋楽-vetoed admit-jp-detail row/);
    expect(stats.violations[1]).toMatch(/forbidden drop→admit flip/);
  });

  it('fails fast on an unparseable decision-log line', async () => {
    const inPath = join(dir, 'decision-log.jsonl');
    writeFileSync(inPath, `${JSON.stringify(logRow())}\n{not json\n`, 'utf8');
    await expect(
      runReplay({
        inPath,
        outPath: join(dir, 'replayed.jsonl'),
        flipsOutPath: join(dir, 'flips.jsonl'),
        corpusPath: undefined,
      }),
    ).rejects.toThrow(/unparseable decision-log line 2/);
  });
});
