/**
 * SEARCH-PARITY GOLDEN GATE (T4-2)
 * =================================
 * Guards against SILENT drift between the two independent search paths:
 *
 *   - Path A (client): apps/web/src/lib/search.ts `buildIndex` + `searchLocalIndex`
 *     (MiniSearch fuzzy/prefix + compactSearchText processTerm + expandSearchQuery),
 *     then the production vendor filter `filterByVendors` and result cap — exactly
 *     the offline fallback in results.ts `resolveBrowseCandidates` + `finalizeResults`.
 *   - Path B (worker): apps/worker/src/index.ts `handleRequest` over a SQLite corpus
 *     built by @karaoke/data-store (search_tokens term/prefix/gram/initial weighted
 *     ranking + karaoke-number handling).
 *
 * Both paths consume the SAME committed corpus (apps/web/public/data/songs.json):
 * Path A builds a MiniSearch index from it; Path B imports it into an in-memory
 * SQLite DB. The two ranking engines are entirely separate (they share only the
 * @karaoke/search primitives), so a change to one can quietly move the top results
 * a user sees without any existing test noticing. This gate measures the CURRENT
 * per-query divergence and freezes it as a baseline: the rule is "no worse than
 * today", not "identical".
 *
 * WHY apps/web: Path A lives in this app and is imported as native production
 * source (zero indirection — the fragile MiniSearch config is exercised as-is).
 * Path B is consumed through the worker's public `handleRequest` export
 * (@karaoke/worker) plus @karaoke/data-store; both are wired as test-only
 * devDependencies (resolved from source via vitest/tsconfig aliases). The fixture
 * lives next to the corpus it reads. No production module imports these test deps.
 *
 * METRICS (per query, top-10 of each path):
 *   - jaccard  = |A ∩ B| / |A ∪ B|  (both-empty is defined as 1.0 = perfect parity)
 *   - top1Match = A[0] === B[0]      (both-empty is true)
 * Ties are absorbed by the set-based Jaccard; only top1Match is order-sensitive.
 *
 * GATE: current jaccard must not drop below baseline (per query AND on the mean),
 * and a query whose baseline top-1 agreed must keep agreeing. A corpus change is
 * detected by a sha256 mismatch and fails with an explicit regenerate instruction.
 *
 * REGENERATING THE BASELINE (do this ONLY for an intentional ranking/corpus change,
 * and review the diff — a shrinking jaccard is a real regression, not a rubber stamp):
 *
 *     UPDATE_PARITY_SNAPSHOT=1 pnpm --filter @karaoke/web exec vitest run \
 *       src/lib/search-parity.golden.test.ts
 *
 * COST: building the 25.8k MiniSearch index + SQLite corpus dominates (~20-30s),
 * done once in beforeAll and shared by every assertion. Kept in its own file with
 * a generous hook timeout so it can be excluded from fast unit runs if needed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { type SearchDatabase, handleRequest } from '@karaoke/worker';
import type MiniSearch from 'minisearch';
import { beforeAll, describe, expect, it } from 'vitest';
import { filterByVendors } from './filter.js';
import { type SearchVendor, buildIndex, searchLocalIndex } from './search.js';

const CORPUS_REL = 'apps/web/public/data/songs.json';
const CORPUS_PATH = fileURLToPath(new URL('../../public/data/songs.json', import.meta.url));
const QUERIES_PATH = fileURLToPath(
  new URL('./fixtures/search-parity-queries.json', import.meta.url),
);
const SMOKE_PATH = fileURLToPath(new URL('./fixtures/search-parity-smoke.json', import.meta.url));
const SNAPSHOT_PATH = fileURLToPath(
  new URL('./__snapshots__/search-parity.baseline.json', import.meta.url),
);

const TOP_N = 10;
const SMOKE_TOP_N = 3;
const JACCARD_EPS = 1e-9;
const SETUP_TIMEOUT_MS = 180_000;
const UPDATE = process.env.UPDATE_PARITY_SNAPSHOT === '1';

interface GoldenQuery {
  id: string;
  category: string;
  query: string;
  vendors?: SearchVendor[];
  note: string;
}
type VendorNumberKey = 'tj' | 'ky' | 'joysound';
interface SmokeCase {
  id: string;
  query: string;
  vendors?: SearchVendor[];
  /**
   * STABLE identity: at least one vendor karaoke number. Resolved to the
   * current record id at setup by `resolveSmokeExpectId`. Pins by number
   * instead of the POSITIONAL blog-* id, which reshuffles whenever a crawl
   * re-touches a blog page (see docs/ROADMAP.md history).
   */
  expectNumbers: Partial<Record<VendorNumberKey, string>>;
  /**
   * Self-documenting cross-check on the number-resolved record — asserted to
   * match, NOT a fuzzy fallback (resolution is strictly BY NUMBER).
   */
  expectTitle: string;
  expectArtist: string;
  note: string;
}
interface QuerySnapshot {
  query: string;
  vendors: SearchVendor[];
  jaccard: number;
  top1Match: boolean;
  web: string[];
  worker: string[];
}
interface Snapshot {
  _readme: string;
  corpus: { path: string; sha256: string; records: number };
  aggregate: { queryCount: number; meanJaccard: number; top1MatchRate: number };
  queries: Record<string, QuerySnapshot>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const goldenQueries = readJson<{ queries: GoldenQuery[] }>(QUERIES_PATH).queries;
const smokeCases = readJson<{ cases: SmokeCase[] }>(SMOKE_PATH).cases;

let corpusHash: string;
let recordCount: number;
let index: MiniSearch<SongRecord>;
let byId: Map<string, SongRecord>;
let db: SearchDatabase;
let sqlite: SongDatabase;
/** Smoke id -> the corpus record id its stable karaoke-number key resolves to (built in beforeAll). */
let resolvedSmokeIds: Map<string, string>;

/**
 * Minimal sync→async adapter over node:sqlite that satisfies the worker's
 * `SearchDatabase` contract (prepare→bind→all). Equivalent to the worker's own
 * SqliteSearchDatabase, reimplemented here so the gate depends only on the
 * worker's PUBLIC surface (`handleRequest`) and not its internal adapter file.
 */
function makeWorkerDb(database: SongDatabase): SearchDatabase {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bound = (
        params: readonly (string | number | null)[],
      ): ReturnType<SearchDatabase['prepare']> => ({
        bind: (...values: (string | number | null)[]) => bound(values),
        all: async <T = Record<string, unknown>>() => ({
          results: statement.all(...params) as T[],
        }),
      });
      return bound([]);
    },
  };
}

/** Path A: MiniSearch offline fallback exactly as results.ts assembles it —
 *  including the vendor scope `resolveBrowseCandidates` passes into
 *  `searchLocalIndex` (number-recall vendor filter). */
function webTopIds(query: string, vendors: SearchVendor[], limit: number): string[] {
  const hits = searchLocalIndex(index, query, { vendors: new Set(vendors) });
  const records: SongRecord[] = [];
  for (const hit of hits) {
    const record = byId.get(String(hit.id));
    if (record !== undefined) records.push(record);
  }
  return filterByVendors(records, new Set(vendors))
    .slice(0, limit)
    .map((record) => record.id);
}

/** Path B: worker `/api/search` over the in-memory SQLite corpus. */
async function workerTopIds(
  query: string,
  vendors: SearchVendor[],
  limit: number,
): Promise<string[]> {
  const url = new URL('https://parity.test/api/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  if (vendors.length > 0) url.searchParams.set('vendor', vendors.join(','));
  const response = await handleRequest(new Request(url), { db });
  const body = (await response.json()) as { items: SongRecord[] };
  return body.items.map((item) => item.id);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  return intersection / union.size;
}

function top1Match(a: readonly string[], b: readonly string[]): boolean {
  return a[0] === b[0];
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Resolve a smoke case's STABLE karaoke-number key to the single corpus record
 * it identifies today. Resolution is strictly BY NUMBER (tj/ky/joysound is
 * stable identity); `expectTitle`/`expectArtist` are a self-documenting
 * cross-check that the number still points at the documented song, NOT a fuzzy
 * fallback. Throws (naming the smoke id) if the key pins no number, resolves to
 * zero or multiple records, or the resolved record's title/artist have drifted
 * — so a stale fixture fails loudly at setup instead of silently asserting the
 * wrong record.
 */
function resolveSmokeExpectId(smoke: SmokeCase, records: readonly SongRecord[]): string {
  const wanted: [VendorNumberKey, string][] = [];
  for (const vendor of ['tj', 'ky', 'joysound'] as const) {
    const number = smoke.expectNumbers[vendor];
    if (number !== undefined) wanted.push([vendor, number]);
  }
  if (wanted.length === 0) {
    throw new Error(
      `smoke "${smoke.id}": expectNumbers pins no vendor number; a smoke case must carry at least one tj/ky/joysound karaoke number.`,
    );
  }
  const matches = records.filter((record) =>
    wanted.every(([vendor, number]) => record.karaoke_numbers[vendor] === number),
  );
  const record = matches[0];
  if (matches.length !== 1 || record === undefined) {
    throw new Error(
      `smoke "${smoke.id}": stable key ${JSON.stringify(smoke.expectNumbers)} resolved to ${matches.length} corpus records (${JSON.stringify(matches.map((m) => m.id))}), expected exactly 1. Re-pin from the current corpus.`,
    );
  }
  if (record.title_primary !== smoke.expectTitle || record.artist_primary !== smoke.expectArtist) {
    throw new Error(
      `smoke "${smoke.id}": record ${record.id} (resolved by number) carries title/artist ${JSON.stringify(record.title_primary)} / ${JSON.stringify(record.artist_primary)}, but the fixture documents ${JSON.stringify(smoke.expectTitle)} / ${JSON.stringify(smoke.expectArtist)}. The number now points at a different song — update the fixture or investigate the corpus.`,
    );
  }
  return record.id;
}

let current: Snapshot;
let baseline: Snapshot;

beforeAll(async () => {
  const raw = readFileSync(CORPUS_PATH);
  corpusHash = createHash('sha256').update(raw).digest('hex');
  const records = JSON.parse(raw.toString('utf8')) as SongRecord[];
  recordCount = records.length;

  // Resolve every smoke case's stable karaoke-number key to a current record id
  // (loud failure here if any key is stale/ambiguous — see resolveSmokeExpectId).
  resolvedSmokeIds = new Map(
    smokeCases.map((smoke) => [smoke.id, resolveSmokeExpectId(smoke, records)] as const),
  );

  index = buildIndex(records);
  byId = new Map(records.map((record) => [record.id, record] as const));
  sqlite = openSongDatabase(':memory:');
  createSongDatabase(sqlite);
  importSongs(sqlite, records);
  db = makeWorkerDb(sqlite);

  const queries: Record<string, QuerySnapshot> = {};
  let jaccardSum = 0;
  let top1Count = 0;
  for (const gq of goldenQueries) {
    const vendors = gq.vendors ?? [];
    const web = webTopIds(gq.query, vendors, TOP_N);
    const worker = await workerTopIds(gq.query, vendors, TOP_N);
    const j = jaccard(web, worker);
    const t1 = top1Match(web, worker);
    jaccardSum += j;
    if (t1) top1Count += 1;
    queries[gq.id] = { query: gq.query, vendors, jaccard: round6(j), top1Match: t1, web, worker };
  }

  current = {
    _readme:
      'AUTO-GENERATED baseline for search-parity.golden.test.ts. Regenerate with UPDATE_PARITY_SNAPSHOT=1 (see the test file header). jaccard/top1Match are the FROZEN divergence floor; web/worker lists are the top-10 ids at generation time (informational, for reading divergences). Do not hand-edit.',
    corpus: { path: CORPUS_REL, sha256: corpusHash, records: recordCount },
    aggregate: {
      queryCount: goldenQueries.length,
      meanJaccard: round6(jaccardSum / goldenQueries.length),
      top1MatchRate: round6(top1Count / goldenQueries.length),
    },
    queries,
  };

  if (UPDATE) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  }
  baseline = readJson<Snapshot>(SNAPSHOT_PATH);
}, SETUP_TIMEOUT_MS);

describe('search-parity gate: corpus identity', () => {
  it('matches the corpus the baseline was generated against', () => {
    const regenHint =
      'Regenerate the parity baseline: UPDATE_PARITY_SNAPSHOT=1 pnpm --filter @karaoke/web exec vitest run src/lib/search-parity.golden.test.ts';
    expect(
      corpusHash,
      `Corpus ${CORPUS_REL} changed (sha256 ${corpusHash} != baseline ${baseline.corpus.sha256}). ${regenHint}`,
    ).toBe(baseline.corpus.sha256);
    expect(recordCount, `Corpus record count changed. ${regenHint}`).toBe(baseline.corpus.records);
  });
});

describe('search-parity gate: per-query top-10 divergence is no worse than baseline', () => {
  it('has a baseline entry for every fixture query (and vice versa)', () => {
    expect(Object.keys(current.queries).sort()).toEqual(Object.keys(baseline.queries).sort());
  });

  for (const gq of goldenQueries) {
    it(`${gq.id} — ${gq.category}`, () => {
      const now = current.queries[gq.id];
      const base = baseline.queries[gq.id];
      expect(now, `no current result for ${gq.id}`).toBeDefined();
      expect(base, `no baseline for ${gq.id}; regenerate the snapshot`).toBeDefined();
      if (now === undefined || base === undefined) return;

      // Jaccard must not decrease (a smaller top-10 overlap = new silent drift).
      expect(
        now.jaccard,
        `jaccard for "${gq.query}" dropped: ${now.jaccard} < baseline ${base.jaccard}\n  web=${JSON.stringify(now.web)}\n  worker=${JSON.stringify(now.worker)}`,
      ).toBeGreaterThanOrEqual(base.jaccard - JACCARD_EPS);

      // A top-1 agreement in the baseline must not regress to disagreement.
      if (base.top1Match) {
        expect(
          now.top1Match,
          `top-1 agreement for "${gq.query}" regressed (was aligned): web[0]=${now.web[0]} worker[0]=${now.worker[0]}`,
        ).toBe(true);
      }
    });
  }
});

describe('search-parity gate: aggregate metrics are no worse than baseline', () => {
  it('mean Jaccard and top-1 match rate do not regress', () => {
    expect(current.aggregate.meanJaccard).toBeGreaterThanOrEqual(
      baseline.aggregate.meanJaccard - JACCARD_EPS,
    );
    expect(current.aggregate.top1MatchRate).toBeGreaterThanOrEqual(
      baseline.aggregate.top1MatchRate - JACCARD_EPS,
    );
  });
});

describe('search-parity relevance smoke: obvious matches rank in the top 3 on BOTH paths', () => {
  for (const smoke of smokeCases) {
    it(`${smoke.id}: "${smoke.query}"`, async () => {
      // Resolved from the stable karaoke-number key in beforeAll (not a
      // positional blog-* id); assert the SAME record ranks top-3 as before.
      const expectId = resolvedSmokeIds.get(smoke.id);
      expect(
        expectId,
        `smoke "${smoke.id}" was not resolved to a corpus id during setup`,
      ).toBeDefined();
      if (expectId === undefined) return;
      const vendors = smoke.vendors ?? [];
      const web = webTopIds(smoke.query, vendors, SMOKE_TOP_N);
      const worker = await workerTopIds(smoke.query, vendors, SMOKE_TOP_N);
      expect(
        web,
        `MiniSearch path missed ${expectId} (${smoke.expectTitle} / ${smoke.expectArtist}) in top ${SMOKE_TOP_N}: ${JSON.stringify(web)}`,
      ).toContain(expectId);
      expect(
        worker,
        `worker path missed ${expectId} (${smoke.expectTitle} / ${smoke.expectArtist}) in top ${SMOKE_TOP_N}: ${JSON.stringify(worker)}`,
      ).toContain(expectId);
    });
  }
});

describe('smoke stable-key resolver fails loudly on a broken key', () => {
  // Pure-function guard for resolveSmokeExpectId. The loud-failure path is what
  // turns a stale fixture into a clear, named error instead of a silent wrong
  // assertion, so it is worth pinning directly. Synthetic records keep this
  // independent of the heavy corpus build in beforeAll.
  function makeRecord(
    id: string,
    numbers: Partial<Record<VendorNumberKey, string>>,
    title: string,
    artist: string,
  ): SongRecord {
    return {
      id,
      source_url: `https://example.test/${id}`,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: null,
      karaoke_numbers: {
        tj: numbers.tj ?? null,
        ky: numbers.ky ?? null,
        joysound: numbers.joysound ?? null,
      },
      crawled_at: '2026-01-01T00:00:00.000Z',
    };
  }

  const fakeRecords: SongRecord[] = [
    makeRecord('rec-1', { tj: '100', ky: '200' }, 'Song One', 'Artist One'),
    makeRecord('rec-2', { tj: '300', joysound: '400' }, 'Song Two', 'Artist Two'),
    makeRecord('rec-dupe-a', { ky: '999' }, 'Dup A', 'Artist Dup'),
    makeRecord('rec-dupe-b', { ky: '999' }, 'Dup B', 'Artist Dup'),
  ];
  const base = { query: 'q', note: 'n' } as const;

  it('resolves a valid single-number key to the matching record id', () => {
    expect(
      resolveSmokeExpectId(
        {
          id: 's-ok',
          ...base,
          expectNumbers: { tj: '100' },
          expectTitle: 'Song One',
          expectArtist: 'Artist One',
        },
        fakeRecords,
      ),
    ).toBe('rec-1');
  });

  it('throws (naming the smoke id) when a number matches zero records', () => {
    expect(() =>
      resolveSmokeExpectId(
        {
          id: 's-missing',
          ...base,
          expectNumbers: { tj: '000000' },
          expectTitle: 'Song One',
          expectArtist: 'Artist One',
        },
        fakeRecords,
      ),
    ).toThrow(/s-missing.*resolved to 0 corpus records/);
  });

  it('throws when a number matches multiple records', () => {
    expect(() =>
      resolveSmokeExpectId(
        {
          id: 's-dupe',
          ...base,
          expectNumbers: { ky: '999' },
          expectTitle: 'Dup A',
          expectArtist: 'Artist Dup',
        },
        fakeRecords,
      ),
    ).toThrow(/s-dupe.*resolved to 2 corpus records/);
  });

  it('throws when the resolved record title/artist have drifted from the fixture', () => {
    expect(() =>
      resolveSmokeExpectId(
        {
          id: 's-drift',
          ...base,
          expectNumbers: { tj: '100' },
          expectTitle: 'Wrong Title',
          expectArtist: 'Artist One',
        },
        fakeRecords,
      ),
    ).toThrow(/s-drift.*different song/);
  });

  it('throws when the key pins no vendor number', () => {
    expect(() =>
      resolveSmokeExpectId(
        {
          id: 's-empty',
          ...base,
          expectNumbers: {},
          expectTitle: 'Song One',
          expectArtist: 'Artist One',
        },
        fakeRecords,
      ),
    ).toThrow(/s-empty.*pins no vendor number/);
  });
});
