import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeCorpus,
  analyzeJoysoundListing,
  analyzeTjDatabase,
  compareCorpora,
  readDropListKeys,
  runCli,
} from './lib/corpus-audit-guardrails.mjs';

function readJsonl(path) {
  const raw = readFileSync(path, 'utf8').trim();
  return raw.length === 0 ? [] : raw.split(/\r?\n/u).map((line) => JSON.parse(line));
}

function record(overrides = {}) {
  return {
    id: 'base-1',
    source_url: 'https://example.test/source',
    title_primary: 'さよなら',
    title_ko: null,
    artist_primary: '米津玄師',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('corpus audit guardrails', () => {
  it('separates TJ database false-positive and false-negative audit queues with official evidence', () => {
    const records = [
      record({
        id: 'tj-100',
        title_primary: '사랑',
        artist_primary: 'BTS',
        karaoke_numbers: { tj: '100', ky: null, joysound: null },
      }),
      record({
        id: 'tj-200',
        title_primary: 'Different Product Title',
        artist_primary: 'JP Artist',
        karaoke_numbers: { tj: '200', ky: null, joysound: null },
      }),
      record({
        id: 'blog-300',
        title_primary: 'ASCII SONG',
        artist_primary: 'Latin Project',
        karaoke_numbers: { tj: '300', ky: null, joysound: null },
      }),
      record({
        id: 'tj-400',
        title_primary: 'duplicate one',
        artist_primary: 'JP Artist',
        karaoke_numbers: { tj: '400', ky: null, joysound: null },
      }),
      record({
        id: 'blog-401',
        title_primary: 'duplicate two',
        artist_primary: 'JP Artist',
        karaoke_numbers: { tj: '400', ky: null, joysound: null },
      }),
    ];
    const tjCatalog = [
      { pro: '100', indexTitle: '사랑', indexSong: 'BTS' },
      { pro: '200', indexTitle: 'Official Title', indexSong: 'JP Artist' },
      { pro: '400', indexTitle: 'duplicate one', indexSong: 'JP Artist' },
      { pro: '500', indexTitle: 'さくら', indexSong: '米津玄師', nationalcode: '' },
      { pro: '600', indexTitle: 'Latin Missing', indexSong: 'JPN Artist' },
      { pro: '700', indexTitle: '사랑', indexSong: 'Korean Artist' },
    ];
    const cache = {
      proEnrichmentMap: {
        100: { nationalcode: 'KOR' },
        200: { nationalcode: 'JPN' },
        400: { nationalcode: 'JPN' },
        500: { nationalcode: 'JPN' },
      },
      artistNationalityMap: {
        jpartist: { code: 'JPN' },
        jpnartist: { code: 'JPN' },
      },
    };

    const report = analyzeTjDatabase({ records, tjCatalog, cache });

    expect(report.summary.currentCorpus).toMatchObject({
      totalRecords: 5,
      recordsWithTjNumber: 5,
      directTjSourceRecords: 3,
      tjpdfSourceRecords: 0,
      blogRecordsWithTjNumber: 2,
      duplicateTjNumbers: 1,
    });
    expect(report.falsePositive.buckets.officialNonJpnPro.count).toBe(1);
    expect(report.falsePositive.buckets.titleArtistConflict.count).toBe(2);
    expect(report.falsePositive.buckets.asciiOnlyWeakEvidence.count).toBe(1);
    expect(report.falsePositive.samples.officialNonJpnPro[0]).toMatchObject({
      tj: '100',
      current_id: 'tj-100',
      official_nationalcode: 'KOR',
      suggested_verdict: 'DROP_FALSE_POSITIVE',
    });
    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(1);
    expect(report.falseNegative.buckets.artistJpnMissing.count).toBe(1);
    expect(report.falseNegative.samples.exactProJpnMissing[0]).toMatchObject({
      tj: '500',
      official_title: 'さくら',
      priority: 'P0',
      suggested_verdict: 'ADD_FALSE_NEGATIVE',
    });
    expect(report.falseNegative.samples.artistJpnMissing[0]).toMatchObject({
      tj: '600',
      priority: 'P1',
    });
  });

  it('flags missing official TJ numbers when the same song already exists without a TJ number', () => {
    const report = analyzeTjDatabase({
      records: [
        record({
          id: 'blog-no-tj',
          title_primary: 'さくら',
          artist_primary: '米津玄師',
          karaoke_numbers: { tj: null, ky: null, joysound: null },
        }),
      ],
      tjCatalog: [{ pro: '500', indexTitle: 'さくら', indexSong: '米津玄師' }],
      cache: { proEnrichmentMap: { 500: { nationalcode: 'JPN' } }, artistNationalityMap: {} },
    });

    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(1);
    expect(report.falseNegative.buckets.sameSongNoTjNumber.count).toBe(1);
    expect(report.falseNegative.samples.sameSongNoTjNumber[0]).toMatchObject({
      tj: '500',
      current_id: 'blog-no-tj',
      suggested_verdict: 'ADD_FALSE_NEGATIVE',
    });
  });

  it('keeps policy-excluded same-song TJ misses as review edges instead of automatic adds', () => {
    const report = analyzeTjDatabase({
      records: [
        record({
          id: 'blog-no-tj-korean-act',
          title_primary: 'Hollow',
          artist_primary: 'Stray Kids',
          karaoke_numbers: { tj: null, ky: null, joysound: null },
        }),
      ],
      tjCatalog: [{ pro: '52910', indexTitle: 'Hollow', indexSong: 'Stray Kids' }],
      cache: { proEnrichmentMap: { 52910: { nationalcode: 'JPN' } }, artistNationalityMap: {} },
    });

    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(0);
    expect(report.falseNegative.buckets.policyExcludedOfficialJpn.count).toBe(1);
    expect(report.falseNegative.buckets.sameSongNoTjNumber.count).toBe(1);
    expect(report.falseNegative.samples.sameSongNoTjNumber[0]).toMatchObject({
      tj: '52910',
      current_id: 'blog-no-tj-korean-act',
      suggested_verdict: 'POLICY_EDGE',
    });
  });

  it('uses maintained TJ production drop lists for policy-excluded official misses', () => {
    const report = analyzeTjDatabase({
      records: [],
      tjCatalog: [
        { pro: '1', indexTitle: 'Supernatural', indexSong: 'NewJeans' },
        { pro: '2', indexTitle: 'Love Lee', indexSong: 'AKMU' },
        { pro: '3', indexTitle: '미아', indexSong: 'IU' },
        { pro: '4', indexTitle: '海闊天空', indexSong: 'BEYOND' },
      ],
      cache: {
        proEnrichmentMap: {
          1: { nationalcode: 'JPN' },
          2: { nationalcode: 'JPN' },
          3: { nationalcode: 'JPN' },
          4: { nationalcode: 'JPN' },
        },
        artistNationalityMap: {},
      },
    });

    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(0);
    expect(report.falseNegative.buckets.policyExcludedOfficialJpn.count).toBe(4);
    expect(report.falseNegative.samples.policyExcludedOfficialJpn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tj: '1', official_artist: 'NewJeans' }),
        expect.objectContaining({ tj: '2', official_artist: 'AKMU' }),
        expect.objectContaining({ tj: '3', official_artist: 'IU' }),
        expect.objectContaining({ tj: '4', official_artist: 'BEYOND' }),
      ]),
    );
  });

  it('keeps artist-cache-only generic and split-collab TJ misses as policy review edges', () => {
    const report = analyzeTjDatabase({
      records: [],
      tjCatalog: [
        { pro: '10', indexTitle: '아이돌 노래', indexSong: 'Various Artists' },
        { pro: '11', indexTitle: 'Collab Song', indexSong: 'Maroon5,LISA' },
      ],
      cache: {
        proEnrichmentMap: {},
        artistNationalityMap: {
          variousartists: { code: 'JPN' },
          lisa: { code: 'JPN' },
        },
      },
    });

    expect(report.falseNegative.buckets.artistJpnMissing.count).toBe(0);
    expect(report.falseNegative.buckets.policyExcludedOfficialJpn.count).toBe(2);
    expect(report.falseNegative.samples.policyExcludedOfficialJpn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tj: '10',
          official_artist: 'Various Artists',
          official_nationalcode: '',
          suggested_verdict: 'POLICY_EDGE',
        }),
        expect.objectContaining({
          tj: '11',
          official_artist: 'Maroon5,LISA',
          suggested_verdict: 'POLICY_EDGE',
        }),
      ]),
    );
  });

  it('keeps exact-pro JPN generic and feature-only collab official misses as policy edges', () => {
    const report = analyzeTjDatabase({
      records: [],
      tjCatalog: [
        { pro: '20', indexTitle: 'Generic Exact', indexSong: 'Various Artists' },
        { pro: '21', indexTitle: 'Feature Exact', indexSong: 'Maroon5,LISA' },
        { pro: '22', indexTitle: 'Unknown Exact', indexSong: 'Unknown Artist' },
        { pro: '23', indexTitle: 'Compact Generic Exact', indexSong: 'VariousArtists' },
      ],
      cache: {
        proEnrichmentMap: {
          20: { nationalcode: 'JPN' },
          21: { nationalcode: 'JPN' },
          22: { nationalcode: 'JPN' },
          23: { nationalcode: 'JPN' },
        },
        artistNationalityMap: {
          lisa: { code: 'JPN' },
        },
      },
    });

    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(0);
    expect(report.falseNegative.buckets.policyExcludedOfficialJpn.count).toBe(4);
    expect(report.falseNegative.samples.policyExcludedOfficialJpn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tj: '20',
          official_artist: 'Various Artists',
          suggested_verdict: 'POLICY_EDGE',
        }),
        expect.objectContaining({
          tj: '21',
          official_artist: 'Maroon5,LISA',
          suggested_verdict: 'POLICY_EDGE',
        }),
        expect.objectContaining({
          tj: '22',
          official_artist: 'Unknown Artist',
          suggested_verdict: 'POLICY_EDGE',
        }),
        expect.objectContaining({
          tj: '23',
          official_artist: 'VariousArtists',
          suggested_verdict: 'POLICY_EDGE',
        }),
      ]),
    );
  });

  it('flags current TJ corpus rows from production drop-list artists even with pro JPN evidence', () => {
    const report = analyzeTjDatabase({
      records: [
        record({
          id: 'tj-30',
          title_primary: 'Love Lee',
          artist_primary: 'AKMU',
          karaoke_numbers: { tj: '30', ky: null, joysound: null },
        }),
      ],
      tjCatalog: [{ pro: '30', indexTitle: 'Love Lee', indexSong: 'AKMU' }],
      cache: { proEnrichmentMap: { 30: { nationalcode: 'JPN' } }, artistNationalityMap: {} },
    });

    expect(report.falsePositive.buckets.knownKoreanAct.count).toBe(1);
    expect(report.falsePositive.samples.knownKoreanAct[0]).toMatchObject({
      tj: '30',
      current_artist: 'AKMU',
      suggested_verdict: 'DROP_FALSE_POSITIVE',
    });
  });

  it('uses only production lead artist-cache evidence for automatic TJ JPN decisions', () => {
    const report = analyzeTjDatabase({
      records: [
        record({
          id: 'tj-101',
          title_primary: 'Collab Song',
          artist_primary: 'Jonas Blue,MAX',
          karaoke_numbers: { tj: '101', ky: null, joysound: null },
        }),
      ],
      tjCatalog: [
        { pro: '101', indexTitle: 'Collab Song', indexSong: 'Jonas Blue,MAX' },
        { pro: '102', indexTitle: 'Japanese Lead', indexSong: 'imase & MAX' },
      ],
      cache: {
        proEnrichmentMap: {},
        artistNationalityMap: {
          max: { code: 'JPN' },
          imase: { code: 'JPN' },
        },
      },
    });

    expect(report.falsePositive.buckets.asciiOnlyWeakEvidence.count).toBe(1);
    expect(report.falsePositive.samples.asciiOnlyWeakEvidence[0]).toMatchObject({
      tj: '101',
      current_artist: 'Jonas Blue,MAX',
      artist_cache_code: '',
      artist_cache_any_code: 'JPN',
    });
    expect(report.falseNegative.buckets.artistJpnMissing.count).toBe(1);
    expect(report.falseNegative.samples.artistJpnMissing[0]).toMatchObject({
      tj: '102',
      official_artist: 'imase & MAX',
      suggested_verdict: 'ADD_FALSE_NEGATIVE',
    });
  });

  it('skips TJ false-negative script heuristics when exact pro evidence is non-JPN', () => {
    const report = analyzeTjDatabase({
      records: [],
      tjCatalog: [{ pro: '300', indexTitle: 'テスト', indexSong: 'Unknown Artist' }],
      cache: { proEnrichmentMap: { 300: { nationalcode: 'KOR' } }, artistNationalityMap: {} },
    });

    expect(report.falseNegative.buckets.strongScriptJpMissing.count).toBe(0);
    expect(report.falseNegative.buckets.weakEvidenceMissing.count).toBe(0);
    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(0);
  });

  it('does not treat known Korean/Western official-JPN rows as automatic TJ false negatives', () => {
    const report = analyzeTjDatabase({
      records: [],
      tjCatalog: [
        { pro: '52910', indexTitle: 'Hollow', indexSong: 'Stray Kids' },
        { pro: '68048', indexTitle: 'Lights', indexSong: '防弾少年団' },
        { pro: '68041', indexTitle: 'Buenos Aires', indexSong: 'IZ*ONE' },
        { pro: '74008', indexTitle: 'HOME', indexSong: 'Charlie Puth(Feat.宇多田ヒカル)' },
      ],
      cache: {
        proEnrichmentMap: {
          52910: { nationalcode: 'JPN' },
          68048: { nationalcode: 'JPN' },
          68041: { nationalcode: 'JPN' },
          74008: { nationalcode: 'JPN' },
        },
        artistNationalityMap: {},
      },
    });

    expect(report.falseNegative.buckets.exactProJpnMissing.count).toBe(0);
    expect(report.falseNegative.buckets.policyExcludedOfficialJpn.count).toBe(4);
    expect(report.falseNegative.samples.policyExcludedOfficialJpn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tj: '52910',
          official_artist: 'Stray Kids',
          suggested_verdict: 'POLICY_EDGE',
        }),
        expect.objectContaining({
          tj: '74008',
          official_artist: 'Charlie Puth(Feat.宇多田ヒカル)',
          suggested_verdict: 'POLICY_EDGE',
        }),
      ]),
    );
  });

  it('writes separate TJ false-positive and false-negative JSONL plus human TSV review queues', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-tj-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const catalogPath = join(dir, 'tj-catalog.json');
    const cachePath = join(dir, 'tj-search-cache.json');
    const reportPath = join(dir, 'tj-db-summary.json');
    const fpIssuesPath = join(dir, 'current-false-positive-issues.jsonl');
    const fnIssuesPath = join(dir, 'official-false-negative-issues.jsonl');
    const reviewDir = join(dir, 'review-queues');

    writeFileSync(
      corpusPath,
      `${JSON.stringify([
        record({
          id: 'tj-100',
          title_primary: '사랑',
          artist_primary: 'BTS',
          karaoke_numbers: { tj: '100', ky: null, joysound: null },
        }),
      ])}\n`,
    );
    writeFileSync(
      catalogPath,
      `${JSON.stringify([
        { pro: '100', indexTitle: '사랑', indexSong: 'BTS' },
        { pro: '500', indexTitle: 'さくら', indexSong: '米津玄師' },
        { pro: '900', indexTitle: 'Plain Weak Missing', indexSong: 'Plain Singer' },
      ])}\n`,
    );
    writeFileSync(
      cachePath,
      `${JSON.stringify({
        proEnrichmentMap: {
          100: { nationalcode: 'KOR' },
          500: { nationalcode: 'JPN' },
        },
        artistNationalityMap: {},
      })}\n`,
    );

    try {
      runCli([
        'tj-db',
        '--corpus',
        corpusPath,
        '--tj-catalog',
        catalogPath,
        '--cache',
        cachePath,
        '--out',
        reportPath,
        '--fp-issues-out',
        fpIssuesPath,
        '--fn-issues-out',
        fnIssuesPath,
        '--review-dir',
        reviewDir,
      ]);

      expect(JSON.parse(readFileSync(reportPath, 'utf8')).summary.currentCorpus).toMatchObject({
        recordsWithTjNumber: 1,
      });
      expect(readJsonl(fpIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mode: 'tj-db-false-positive',
            bucket: 'officialNonJpnPro',
            tj: '100',
            suggested_verdict: 'DROP_FALSE_POSITIVE',
          }),
        ]),
      );
      expect(readJsonl(fnIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mode: 'tj-db-false-negative',
            bucket: 'exactProJpnMissing',
            tj: '500',
            suggested_verdict: 'ADD_FALSE_NEGATIVE',
          }),
        ]),
      );
      expect(readFileSync(join(reviewDir, 'review-fp-high.tsv'), 'utf8')).toContain(
        'artist_cache_any_code',
      );
      expect(readFileSync(join(reviewDir, 'review-fp-high.tsv'), 'utf8')).toContain(
        'reviewer_verdict',
      );
      expect(readFileSync(join(reviewDir, 'review-fn-high.tsv'), 'utf8')).toContain(
        'exactProJpnMissing',
      );
      expect(readJsonl(fnIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bucket: 'weakEvidenceMissing', tj: '900' }),
        ]),
      );
      expect(readFileSync(join(reviewDir, 'review-fn-medium.tsv'), 'utf8')).not.toContain(
        'weakEvidenceMissing',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when required production drop-list source is missing', () => {
    expect(() =>
      readDropListKeys('../../packages/crawler/src/adapters/tj-media-direct/missingDropList.ts'),
    ).toThrow(/required TJ production drop-list source is missing/u);
  });

  it('refuses TJ review queue child outputs that would overwrite input files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-tj-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const catalogPath = join(dir, 'tj-catalog.json');
    const reviewDir = join(dir, 'review-queues');
    const cachePath = join(reviewDir, 'review-fn-medium.tsv');
    const reportPath = join(dir, 'summary.json');
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(corpusPath, '[]\n');
    writeFileSync(
      catalogPath,
      `${JSON.stringify([{ pro: '900', indexTitle: 'Plain Weak Missing', indexSong: 'Unknown Artist' }])}\n`,
    );
    writeFileSync(cachePath, '{"proEnrichmentMap":{},"artistNationalityMap":{}}\n');

    try {
      expect(() =>
        runCli([
          'tj-db',
          '--corpus',
          corpusPath,
          '--tj-catalog',
          catalogPath,
          '--cache',
          cachePath,
          '--out',
          reportPath,
          '--review-dir',
          reviewDir,
        ]),
      ).toThrow(/refusing to write audit output over input path/u);
      expect(readFileSync(cachePath, 'utf8')).toBe(
        '{"proEnrichmentMap":{},"artistNationalityMap":{}}\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps weak policy-excluded TJ misses out of the medium human review queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-tj-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const catalogPath = join(dir, 'tj-catalog.json');
    const reportPath = join(dir, 'summary.json');
    const fnIssuesPath = join(dir, 'official-false-negative-issues.jsonl');
    const reviewDir = join(dir, 'review-queues');
    writeFileSync(corpusPath, '[]\n');
    writeFileSync(
      catalogPath,
      `${JSON.stringify([{ pro: '74055', indexTitle: 'Sideways', indexSong: 'Charlie Puth' }])}\n`,
    );

    try {
      runCli([
        'tj-db',
        '--corpus',
        corpusPath,
        '--tj-catalog',
        catalogPath,
        '--out',
        reportPath,
        '--fn-issues-out',
        fnIssuesPath,
        '--review-dir',
        reviewDir,
      ]);
      expect(readJsonl(fnIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bucket: 'policyExcludedOfficialJpn',
            tj: '74055',
            priority: 'P4',
            suggested_verdict: 'POLICY_EDGE',
          }),
        ]),
      );
      expect(readFileSync(join(reviewDir, 'review-fn-medium.tsv'), 'utf8')).not.toContain(
        'policyExcludedOfficialJpn',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps official JOYSOUND source records distinct from inherited JOYSOUND numbers', () => {
    const report = analyzeCorpus([
      record({ id: 'blog-1', karaoke_numbers: { tj: null, ky: null, joysound: '12345' } }),
      record({
        id: 'joysound-900',
        source_url: 'https://www.joysound.com/web/search/song/900',
        karaoke_numbers: { tj: null, ky: null, joysound: '90000' },
      }),
      record({ id: 'blog-2', title_primary: 'Set The Tone', artist_primary: 'BTS' }),
      record({ id: 'blog-3', title_primary: 'WE WILL ROCK YOU', artist_primary: 'QUEEN' }),
      record({ id: 'tj-1', title_primary: '사랑', artist_primary: 'Various Artists' }),
    ]);

    expect(report.summary.total).toBe(5);
    expect(report.summary.officialJoysoundSourceRecords).toBe(1);
    expect(report.summary.recordsWithJoysoundNumber).toBe(2);
    expect(report.summary.officialJoysoundSourceRecordsWithNumber).toBe(1);
    expect(report.summary.nonOfficialRecordsWithJoysoundNumber).toBe(1);
    expect(report.sourceCounts).toEqual({ blog: 3, joysound: 1, tj: 1 });
    expect(report.buckets.knownKoreanAct.count).toBe(1);
    expect(report.buckets.knownWesternAct.count).toBe(1);
    expect(report.buckets.hangulNoJapaneseScript.count).toBe(1);
    expect(report.buckets.genericArtistNoJapaneseScript.count).toBe(1);
    expect(report.samples.knownKoreanAct[0]).toMatchObject({ id: 'blog-2', artist_primary: 'BTS' });
  });

  it('audits JOYSOUND full-listing rows for duplicate keys, overlaps, conflicts, and high-risk leak buckets', () => {
    const baseline = [
      record({
        id: 'blog-1',
        title_primary: 'さよなら',
        artist_primary: '米津玄師',
        karaoke_numbers: { tj: null, ky: null, joysound: '11111' },
      }),
      record({
        id: 'blog-2',
        title_primary: 'Baseline Title',
        artist_primary: 'Baseline Artist',
        karaoke_numbers: { tj: null, ky: null, joysound: '99999' },
      }),
    ];
    const rows = [
      { naviGroupId: 'n1', selSongNo: '11111', songName: 'さよなら', artistName: '米津玄師' },
      { naviGroupId: 'n2', selSongNo: '22222', songName: 'Set The Tone', artistName: 'BLACKPINK' },
      {
        naviGroupId: 'n3',
        selSongNo: '33333',
        songName: 'KEEP PASSING THE OPEN WINDOWS',
        artistName: 'QUEEN',
      },
      {
        naviGroupId: 'n4',
        selSongNo: '44444',
        songName: 'Upper flower',
        artistName: 'Western Artist',
      },
      {
        naviGroupId: 'n4',
        selSongNo: '44444',
        songName: 'Set The Tone',
        artistName: 'BLACKPINK',
      },
      {
        naviGroupId: 'n5',
        selSongNo: '99999',
        songName: 'Different Title',
        artistName: 'Different Artist',
      },
    ];

    const report = analyzeJoysoundListing(rows, { baselineRecords: baseline });

    expect(report.summary.totalRows).toBe(6);
    expect(report.summary.uniqueKeys).toBe(5);
    expect(report.summary.duplicateKeys).toBe(1);
    expect(report.buckets.existingJoysoundNumberOverlap.count).toBe(2);
    expect(report.buckets.existingJoysoundNumberConflict.count).toBe(1);
    expect(report.samples.existingJoysoundNumberOverlap[0]).toMatchObject({ selSongNo: '11111' });
    expect(report.samples.existingJoysoundNumberConflict[0]).toMatchObject({
      selSongNo: '99999',
      baseline: [{ id: 'blog-2', title_primary: 'Baseline Title' }],
    });
    expect(report.buckets.knownKoreanAct.count).toBe(2);
    expect(report.buckets.knownWesternAct.count).toBe(1);
    expect(report.buckets.latinVocaloidSubstringRisk.count).toBe(1);
  });

  it('matches hyphenated JOYSOUND listing numbers against dashless baseline corpus numbers', () => {
    const baseline = [
      record({
        id: 'blog-overlap',
        title_primary: 'さよなら',
        artist_primary: '米津玄師',
        karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
      }),
      record({
        id: 'blog-conflict',
        title_primary: 'Baseline Title',
        artist_primary: 'Baseline Artist',
        karaoke_numbers: { tj: null, ky: null, joysound: '290002' },
      }),
    ];
    const rows = [
      // Same dashless number as baseline, same title/artist -> overlap only (no conflict).
      { naviGroupId: 'n1', selSongNo: '190-001', songName: 'さよなら', artistName: '米津玄師' },
      // Same dashless number as baseline, different title/artist -> overlap AND conflict.
      {
        naviGroupId: 'n2',
        selSongNo: '290-002',
        songName: 'Different Title',
        artistName: 'Different Artist',
      },
    ];

    const report = analyzeJoysoundListing(rows, { baselineRecords: baseline });

    expect(report.buckets.existingJoysoundNumberOverlap.count).toBe(2);
    expect(report.buckets.existingJoysoundNumberConflict.count).toBe(1);
    expect(report.samples.existingJoysoundNumberConflict[0]).toMatchObject({
      selSongNo: '290-002',
      baseline: [{ id: 'blog-conflict', title_primary: 'Baseline Title' }],
    });
  });

  it('compares baseline and candidate product corpora without hiding removals, mutations, or suspicious additions', () => {
    const baseline = [
      record({ id: 'keep', title_primary: 'さよなら', artist_primary: '米津玄師' }),
      record({ id: 'remove-me', title_primary: '残るべき曲', artist_primary: 'Aimer' }),
      record({ id: 'mutate-me', title_primary: 'Rich Title', title_ko: '풍부한 제목' }),
    ];
    const candidate = [
      record({ id: 'keep', title_primary: 'さよなら', artist_primary: '米津玄師' }),
      record({ id: 'mutate-me', title_primary: 'Rich Title', title_ko: null }),
      record({
        id: 'joysound-new',
        source_url: 'https://www.joysound.com/web/search/song/new',
        title_primary: 'Set The Tone',
        artist_primary: 'TWICE',
        karaoke_numbers: { tj: null, ky: null, joysound: '55555' },
      }),
    ];

    const report = compareCorpora(baseline, candidate);

    expect(report.summary).toMatchObject({
      baselineCount: 3,
      candidateCount: 3,
      added: 1,
      removed: 1,
      mutatedExisting: 1,
      richFieldLoss: 1,
      officialJoysoundAdditions: 1,
    });
    expect(report.removedSamples[0]).toMatchObject({ id: 'remove-me' });
    expect(report.mutatedSamples[0]).toMatchObject({ id: 'mutate-me' });
    expect(report.richFieldLossSamples[0].lostFields).toContain('title_ko');
    expect(report.richFieldLossSamples[0].before).toMatchObject({ title_ko: '풍부한 제목' });
    expect(report.richFieldLossSamples[0].after).toMatchObject({ title_ko: null });
    expect(report.suspiciousAdditions.buckets.knownKoreanAct.count).toBe(1);
  });

  it('flags duplicate IDs on both sides before relying on map-based corpus deltas', () => {
    const baseline = [record({ id: 'dupe' }), record({ id: 'dupe', title_primary: '別タイトル' })];
    const candidate = [
      record({ id: 'dupe' }),
      record({ id: 'dupe', artist_primary: '別アーティスト' }),
    ];

    const report = compareCorpora(baseline, candidate);

    expect(report.summary.duplicateBaselineIds).toBe(1);
    expect(report.summary.duplicateCandidateIds).toBe(1);
    expect(report.duplicateIdSamples.baseline[0]).toMatchObject({ id: 'dupe', count: 2 });
    expect(report.duplicateIdSamples.candidate[0]).toMatchObject({ id: 'dupe', count: 2 });
  });

  it('refuses to write an audit report over any input corpus path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-audit-'));
    const corpusPath = join(dir, 'songs.json');
    writeFileSync(corpusPath, `${JSON.stringify([record({ id: 'safe' })])}\n`);

    try {
      expect(() => runCli(['corpus', '--in', corpusPath, '--out', corpusPath])).toThrow(
        /refusing to write audit output over input path/u,
      );
      expect(JSON.parse(readFileSync(corpusPath, 'utf8'))[0]).toMatchObject({ id: 'safe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write through a symlink output path that could overwrite inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'report-link.json');
    writeFileSync(corpusPath, `${JSON.stringify([record({ id: 'safe' })])}\n`);

    try {
      try {
        symlinkSync(corpusPath, outputPath);
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          ['EACCES', 'EPERM'].includes(err.code)
        ) {
          return;
        }
        throw err;
      }

      expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
      expect(() => runCli(['corpus', '--in', corpusPath, '--out', outputPath])).toThrow(
        /refusing to write audit output through symlink/u,
      );
      expect(JSON.parse(readFileSync(corpusPath, 'utf8'))[0]).toMatchObject({ id: 'safe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes full issue JSONL for one-by-one corpus and JOYSOUND listing review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const listingPath = join(dir, 'listing.jsonl');
    const corpusReportPath = join(dir, 'corpus-report.json');
    const corpusIssuesPath = join(dir, 'corpus-issues.jsonl');
    const listingReportPath = join(dir, 'listing-report.json');
    const listingIssuesPath = join(dir, 'listing-issues.jsonl');

    writeFileSync(
      corpusPath,
      `${JSON.stringify([
        record({ id: 'blog-1', artist_primary: 'BTS' }),
        record({ id: 'blog-2', title_primary: 'WE WILL ROCK YOU', artist_primary: 'QUEEN' }),
      ])}\n`,
    );
    writeFileSync(
      listingPath,
      [
        JSON.stringify({
          naviGroupId: 'n1',
          selSongNo: '11111',
          songName: 'Set The Tone',
          artistName: 'BLACKPINK',
        }),
        JSON.stringify({
          naviGroupId: 'n1',
          selSongNo: '11111',
          songName: 'WE WILL ROCK YOU',
          artistName: 'QUEEN',
        }),
      ].join('\n'),
    );

    try {
      runCli([
        'corpus',
        '--in',
        corpusPath,
        '--out',
        corpusReportPath,
        '--issues-out',
        corpusIssuesPath,
      ]);
      runCli([
        'joysound-listing',
        '--in',
        listingPath,
        '--baseline',
        corpusPath,
        '--out',
        listingReportPath,
        '--issues-out',
        listingIssuesPath,
      ]);

      expect(readJsonl(corpusIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mode: 'corpus',
            bucket: 'knownKoreanAct',
            record: expect.objectContaining({ id: 'blog-1' }),
          }),
          expect.objectContaining({
            mode: 'corpus',
            bucket: 'knownWesternAct',
            record: expect.objectContaining({ id: 'blog-2' }),
          }),
        ]),
      );
      expect(readJsonl(listingIssuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mode: 'joysound-listing',
            bucket: 'knownKoreanAct',
            row: expect.objectContaining({ selSongNo: '11111' }),
          }),
          expect.objectContaining({
            mode: 'joysound-listing',
            bucket: 'duplicateKey',
            row: expect.objectContaining({ selSongNo: '11111' }),
          }),
          expect.objectContaining({
            mode: 'joysound-listing',
            bucket: 'knownWesternAct',
            row: expect.objectContaining({ selSongNo: '11111' }),
          }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes full issue JSONL for merge-delta gates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-audit-'));
    const baselinePath = join(dir, 'baseline.json');
    const candidatePath = join(dir, 'candidate.json');
    const reportPath = join(dir, 'merge-report.json');
    const issuesPath = join(dir, 'merge-issues.jsonl');

    writeFileSync(
      baselinePath,
      `${JSON.stringify([
        record({ id: 'remove-me' }),
        record({ id: 'mutate-me', title_ko: '풍부한 제목' }),
        record({ id: 'dupe' }),
        record({ id: 'dupe', title_primary: '別タイトル' }),
      ])}\n`,
    );
    writeFileSync(
      candidatePath,
      `${JSON.stringify([
        record({ id: 'mutate-me', title_ko: null }),
        record({ id: 'dupe' }),
        record({ id: 'dupe', artist_primary: '別アーティスト' }),
        record({
          id: 'joysound-new',
          source_url: 'https://www.joysound.com/web/search/song/new',
          artist_primary: 'TWICE',
        }),
      ])}\n`,
    );

    try {
      runCli([
        'merge-delta',
        '--baseline',
        baselinePath,
        '--candidate',
        candidatePath,
        '--out',
        reportPath,
        '--issues-out',
        issuesPath,
      ]);

      expect(readJsonl(issuesPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'removed',
            record: expect.objectContaining({ id: 'remove-me' }),
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'duplicateBaselineId',
            id: 'dupe',
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'duplicateCandidateId',
            id: 'dupe',
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'mutatedExisting',
            id: 'mutate-me',
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'richFieldLoss',
            id: 'mutate-me',
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'added',
            record: expect.objectContaining({ id: 'joysound-new' }),
          }),
          expect.objectContaining({
            mode: 'merge-delta',
            bucket: 'suspiciousAddition.knownKoreanAct',
            record: expect.objectContaining({ id: 'joysound-new' }),
          }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write issue JSONL over any input corpus path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-audit-'));
    const corpusPath = join(dir, 'songs.json');
    const reportPath = join(dir, 'report.json');
    writeFileSync(corpusPath, `${JSON.stringify([record({ id: 'safe' })])}\n`);

    try {
      expect(() =>
        runCli(['corpus', '--in', corpusPath, '--out', reportPath, '--issues-out', corpusPath]),
      ).toThrow(/refusing to write audit output over input path/u);
      expect(JSON.parse(readFileSync(corpusPath, 'utf8'))[0]).toMatchObject({ id: 'safe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
