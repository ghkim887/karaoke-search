import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeCorpus,
  analyzeJoysoundListing,
  compareCorpora,
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
    categories: ['jpop'],
    crawled_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('corpus audit guardrails', () => {
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
