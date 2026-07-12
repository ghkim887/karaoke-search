// Unit tests for scripts/probe-tjpdf-catalog.mjs — pure envelope parsing,
// exact-pro matching, retry policy, catalog (de)serialization, range/seed
// expansion, and the runProbe orchestration with an injected fetch (no network).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RETRIES,
  collectTjItems,
  loadSeedCodes,
  mapItem,
  parseArgs,
  parseRange,
  parseSearchSongResponse,
  probeOnce,
  readCatalog,
  runProbe,
  selectExactPro,
  serializeCatalog,
  withRetry,
} from './probe-tjpdf-catalog.mjs';

/** Build a minimal Response-like object. */
function resp(bodyObj, status = 200) {
  return {
    status,
    async text() {
      return typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    },
  };
}

/** A flat `{ resultCode:'99', resultData:{ items:[...] } }` envelope. */
function flatEnvelope(items) {
  return {
    resultCode: '99',
    resultMsg: '성공',
    resultData: { itemsTotalCount: items.length, items },
  };
}

/** A 6-bucket array envelope with the items in bucket 1. */
function bucketEnvelope(items) {
  return {
    resultCode: '99',
    resultData: [
      { items1TotalCount: items.length, items1: items },
      { items2TotalCount: 0, items2: [] },
    ],
  };
}

function rawItem(pro, over = {}) {
  return {
    rownumber: 1,
    pro: String(pro),
    indexTitle: `title-${pro}`,
    subTitle: '',
    indexSong: `artist-${pro}`,
    sortTitleKo: `타이틀-${pro}`,
    sortSongKo: `아티스트-${pro}`,
    nationalcode: 'JPN',
    publishdate: '2020-01-01',
    ...over,
  };
}

describe('parseSearchSongResponse', () => {
  it('parses the flat { items } shape', () => {
    const out = parseSearchSongResponse(flatEnvelope([rawItem(28477)]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pro: '28477',
      indexTitle: 'title-28477',
      indexSong: 'artist-28477',
    });
  });

  it('parses the 6-bucket array shape', () => {
    const out = parseSearchSongResponse(bucketEnvelope([rawItem(6899), rawItem(6900)]));
    expect(out.map((x) => x.pro)).toEqual(['6899', '6900']);
  });

  it('treats resultCode 98 as empty', () => {
    expect(parseSearchSongResponse({ resultCode: '98', resultMsg: 'no data' })).toEqual([]);
  });

  it('throws on a non-99/98 resultCode', () => {
    expect(() => parseSearchSongResponse({ resultCode: '20', resultMsg: 'missing param' })).toThrow(
      /resultCode=20/,
    );
  });

  it('throws on a non-object envelope', () => {
    expect(() => parseSearchSongResponse('nope')).toThrow(/not a JSON object/);
  });

  it('throws on an unrecognized resultData shape', () => {
    expect(() => parseSearchSongResponse({ resultCode: '99', resultData: 42 })).toThrow(
      /unexpected shape/,
    );
  });

  it('drops items missing required identifier fields', () => {
    const out = parseSearchSongResponse(
      flatEnvelope([rawItem(1, { indexTitle: '' }), rawItem(2, { indexSong: '' }), rawItem(3)]),
    );
    expect(out.map((x) => x.pro)).toEqual(['3']);
  });
});

describe('collectTjItems', () => {
  it('returns [] for null/undefined/string resultData', () => {
    expect(collectTjItems(null)).toEqual([]);
    expect(collectTjItems(undefined)).toEqual([]);
    expect(collectTjItems('')).toEqual([]);
  });
});

describe('mapItem', () => {
  it('coerces empty optional strings to null but keeps verbatim content', () => {
    const item = mapItem(rawItem(9, { subTitle: '', sortTitleKo: '', publishdate: '' }));
    expect(item.subTitle).toBeNull();
    expect(item.sortTitleKo).toBeNull();
    expect(item.publishdate).toBeNull();
    expect(item.nationalcode).toBe('JPN');
  });

  it('returns null when pro/indexTitle/indexSong are unusable', () => {
    expect(mapItem(rawItem(9, { pro: '' }))).toBeNull();
    expect(mapItem('not an object')).toBeNull();
  });
});

describe('selectExactPro', () => {
  it('picks the exact pro, ignoring neighbors (leading-zero-normalized)', () => {
    const items = [rawItem(87055), rawItem(7055), rawItem(70550)].map(mapItem);
    expect(selectExactPro(items, '7055').pro).toBe('7055');
    expect(selectExactPro(items, '07055').pro).toBe('7055');
  });

  it('returns null when no item matches', () => {
    expect(selectExactPro([mapItem(rawItem(1))], '999')).toBeNull();
  });
});

describe('withRetry', () => {
  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const e = new Error('transient');
          e.retryable = true;
          throw e;
        }
        return 'ok';
      },
      { sleep, baseDelayMs: 10 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    // Linear backoff: 10*1 then 10*2.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it('gives up after MAX_RETRIES on a persistently retryable error', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    await expect(
      withRetry(
        async () => {
          calls += 1;
          const e = new Error('boom');
          e.retryable = true;
          throw e;
        },
        { sleep },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(MAX_RETRIES + 1);
  });

  it('does NOT retry a non-retryable error', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('deterministic'); // no .retryable
        },
        { sleep },
      ),
    ).rejects.toThrow('deterministic');
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('probeOnce', () => {
  it('returns parsed items on a 200 + valid envelope', async () => {
    const fetchFn = async () => resp(flatEnvelope([rawItem(28477)]));
    const items = await probeOnce('28477', { fetchFn });
    expect(items[0].pro).toBe('28477');
  });

  it('marks a 5xx as retryable', async () => {
    const fetchFn = async () => resp('', 503);
    await expect(probeOnce('1', { fetchFn })).rejects.toMatchObject({ retryable: true });
  });

  it('marks a 4xx as non-retryable', async () => {
    const fetchFn = async () => resp('', 404);
    await expect(probeOnce('1', { fetchFn })).rejects.toMatchObject({ retryable: false });
  });

  it('marks a network throw as retryable', async () => {
    const fetchFn = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(probeOnce('1', { fetchFn })).rejects.toMatchObject({ retryable: true });
  });

  it('marks invalid JSON as non-retryable', async () => {
    const fetchFn = async () => resp('<html>not json</html>');
    await expect(probeOnce('1', { fetchFn })).rejects.toMatchObject({ retryable: false });
  });

  it('sends strType=16 and the exact searchTxt', async () => {
    const seen = {};
    const fetchFn = async (url, opts) => {
      seen.url = url;
      seen.body = opts.body;
      seen.ua = opts.headers['User-Agent'];
      return resp(flatEnvelope([rawItem(6899)]));
    };
    await probeOnce('6899', { fetchFn });
    expect(seen.url).toContain('/legacy/api/searchSong');
    expect(seen.body).toContain('searchTxt=6899');
    expect(seen.body).toContain('strType=16');
    expect(seen.ua).toContain('karaoke-search-crawler');
  });
});

describe('parseRange', () => {
  it('expands an inclusive range', () => {
    expect(parseRange('28900..28903')).toEqual(['28900', '28901', '28902', '28903']);
  });
  it('rejects a malformed spec', () => {
    expect(() => parseRange('abc')).toThrow(/A\.\.B/);
  });
  it('rejects start > end', () => {
    expect(() => parseRange('10..5')).toThrow(/start 10 > end 5/);
  });
});

describe('serializeCatalog', () => {
  it('sorts by numeric pro and emits canonical fields, one line each', () => {
    const out = serializeCatalog([
      { pro: '68430', indexTitle: 'b', indexSong: 'x' },
      { pro: '6899', indexTitle: 'a', indexSong: 'y' },
    ]);
    const lines = out.trimEnd().split('\n');
    expect(JSON.parse(lines[0]).pro).toBe('6899');
    expect(JSON.parse(lines[1]).pro).toBe('68430');
    // Canonical field order + null-fill for absent fields.
    expect(Object.keys(JSON.parse(lines[0]))).toEqual([
      'pro',
      'indexTitle',
      'subTitle',
      'indexSong',
      'sortTitleKo',
      'sortSongKo',
      'nationalcode',
      'publishdate',
    ]);
    expect(JSON.parse(lines[0]).nationalcode).toBeNull();
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('parseArgs', () => {
  it('defaults to seed mode', () => {
    const a = parseArgs([]);
    expect(a.range).toBeNull();
    expect(a.fresh).toBe(false);
  });
  it('parses range/fresh/limit', () => {
    const a = parseArgs(['--range', '1..9', '--fresh', '--limit', '5']);
    expect(a.range).toBe('1..9');
    expect(a.fresh).toBe(true);
    expect(a.limit).toBe(5);
  });
  it('rejects unknown flags and bad limit', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--limit', '-1'])).toThrow(/non-negative/);
  });
});

describe('runProbe', () => {
  let dir;
  let catalogPath;
  const noSleep = async () => {};
  const rng = () => 0.5;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-'));
    catalogPath = join(dir, 'catalog.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('seed mode: writes exact hits, records misses, fails coverage on a miss', async () => {
    const fetchFn = async (_url, opts) => {
      const code = new URLSearchParams(opts.body).get('searchTxt');
      if (code === '2') return resp(flatEnvelope([])); // miss
      return resp(flatEnvelope([rawItem(code)]));
    };
    const stats = await runProbe({
      mode: 'seed',
      codes: ['1', '2', '3'],
      catalogPath,
      fetchFn,
      sleep: noSleep,
      rng,
      log: { error() {}, log() {} },
    });
    expect(stats.found).toBe(2);
    expect(stats.misses).toEqual(['2']);
    const entries = readCatalog(catalogPath);
    expect(entries.map((e) => e.pro).sort()).toEqual(['1', '3']);
  });

  it('resume: skips codes already present unless --fresh', async () => {
    writeFileSync(
      catalogPath,
      `${JSON.stringify({ pro: '1', indexTitle: 'old', indexSong: 'a' })}\n`,
      'utf-8',
    );
    let probed = [];
    const fetchFn = async (_url, opts) => {
      const code = new URLSearchParams(opts.body).get('searchTxt');
      probed.push(code);
      return resp(flatEnvelope([rawItem(code)]));
    };
    const stats = await runProbe({
      mode: 'seed',
      codes: ['1', '2'],
      catalogPath,
      fetchFn,
      sleep: noSleep,
      rng,
      log: { error() {}, log() {} },
    });
    expect(probed).toEqual(['2']); // 1 skipped
    expect(stats.skippedExisting).toBe(1);
    // Existing entry preserved.
    const entries = readCatalog(catalogPath);
    expect(entries.find((e) => e.pro === '1').indexTitle).toBe('old');

    // --fresh re-probes everything.
    probed = [];
    await runProbe({
      mode: 'seed',
      codes: ['1', '2'],
      catalogPath,
      fresh: true,
      fetchFn,
      sleep: noSleep,
      rng,
      log: { error() {}, log() {} },
    });
    expect(probed.sort()).toEqual(['1', '2']);
    expect(readCatalog(catalogPath).find((e) => e.pro === '1').indexTitle).toBe('title-1');
  });

  it('range mode: appends only exact hits and stays silent on misses', async () => {
    const fetchFn = async (_url, opts) => {
      const code = new URLSearchParams(opts.body).get('searchTxt');
      // Only 11 exists; 12 returns a neighbor (13) but not itself.
      if (code === '11') return resp(flatEnvelope([rawItem(11)]));
      if (code === '12') return resp(flatEnvelope([rawItem(13)]));
      return resp(flatEnvelope([]));
    };
    const stats = await runProbe({
      mode: 'range',
      codes: parseRange('10..12'),
      catalogPath,
      fetchFn,
      sleep: noSleep,
      rng,
      log: { error() {}, log() {} },
    });
    expect(stats.found).toBe(1);
    expect(stats.misses).toEqual([]); // range misses are silent
    expect(readCatalog(catalogPath).map((e) => e.pro)).toEqual(['11']);
  });

  it('honors --limit', async () => {
    const fetchFn = async (_url, opts) =>
      resp(flatEnvelope([rawItem(new URLSearchParams(opts.body).get('searchTxt'))]));
    const stats = await runProbe({
      mode: 'seed',
      codes: ['1', '2', '3', '4'],
      catalogPath,
      limit: 2,
      fetchFn,
      sleep: noSleep,
      rng,
      log: { error() {}, log() {} },
    });
    expect(stats.toProbe).toBe(2);
    expect(stats.found).toBe(2);
  });
});

describe('loadSeedCodes', () => {
  it('reads the committed seed list as strings', () => {
    const seedPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'data',
      'tjpdf-seed-numbers.json',
    );
    const codes = loadSeedCodes(seedPath);
    expect(codes.length).toBeGreaterThan(600);
    expect(codes.every((c) => typeof c === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Committed seed ↔ catalog consistency (ROADMAP R7). The discovery workflow
// appends every new hit to BOTH scripts/data/tjpdf-seed-numbers.json and
// scripts/data/tjpdf-catalog.jsonl; this pin makes the two files unable to
// drift apart — every seed code must have a catalog entry (else the seed-mode
// probe reports a coverage MISS and exits non-zero), and every catalog code
// must be a seed code (else a `--fresh` re-probe would silently drop it). It is
// a 1:1 set-equality check (not a brittle absolute count), so ordinary
// discovery-sweep additions keep it green without a per-PR bump.
// ---------------------------------------------------------------------------
describe('committed seed ↔ catalog consistency', () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

  it('the committed seed list and catalog cover the exact same TJ code set (1:1)', () => {
    const seedCodes = loadSeedCodes(join(DATA_DIR, 'tjpdf-seed-numbers.json'));
    const catalogCodes = readCatalog(join(DATA_DIR, 'tjpdf-catalog.jsonl')).map((e) =>
      String(e.pro),
    );

    // No duplicates within either file.
    expect(new Set(seedCodes).size, 'seed list has duplicate codes').toBe(seedCodes.length);
    expect(new Set(catalogCodes).size, 'catalog has duplicate pro codes').toBe(catalogCodes.length);

    // 1:1 — identical code sets (hence identical counts).
    const seedSet = new Set(seedCodes);
    const catSet = new Set(catalogCodes);
    const seedOnly = seedCodes.filter((c) => !catSet.has(c));
    const catOnly = catalogCodes.filter((c) => !seedSet.has(c));
    expect(
      seedOnly,
      `seed codes with no catalog entry: ${seedOnly.slice(0, 10).join(', ')}`,
    ).toEqual([]);
    expect(
      catOnly,
      `catalog codes not in the seed list: ${catOnly.slice(0, 10).join(', ')}`,
    ).toEqual([]);
    expect(seedCodes.length).toBe(catalogCodes.length);
  });
});
