import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Minimal valid SongRecord shape for test fixtures.
function makeRecord(overrides = {}) {
  return {
    id: 'tj-1',
    source_url: 'https://example.com/1',
    title_primary: '愛が見えない',
    title_ko: null,
    artist_primary: 'TestArtist',
    artist_ko: null,
    karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// applyManualFix mirrors the mutation the CLI performs, for unit testing
// without spawning a process.
async function applyManualFix(records, recordId, newTitleKo) {
  const { validateSongRecord } = await import('../packages/schema/dist/index.js');

  const matches = records.filter((r) => r.id === recordId);
  if (matches.length === 0) throw new Error(`record not found: ${recordId}`);
  if (matches.length > 1) throw new Error(`duplicate record_id in corpus: ${recordId}`);

  const target = matches[0];
  target.title_ko = newTitleKo;
  target.title_ko_source = 'manual';
  target.title_ko_confidence = undefined;

  validateSongRecord(target);
  return records;
}

describe('applyManualFix — happy path (non-null title)', () => {
  it('sets title_ko, title_ko_source=manual, removes title_ko_confidence', async () => {
    const records = [
      makeRecord({ id: 'tj-25242', title_ko: null }),
      makeRecord({ id: 'tj-99', title_ko: '무관계' }),
    ];
    await applyManualFix(records, 'tj-25242', '새의 시');
    const r = records.find((x) => x.id === 'tj-25242');
    assert.equal(r.title_ko, '새의 시');
    assert.equal(r.title_ko_source, 'manual');
    assert.equal(r.title_ko_confidence, undefined);
  });

  it('does not touch unrelated records', async () => {
    const records = [
      makeRecord({ id: 'tj-1', title_ko: '기존' }),
      makeRecord({ id: 'tj-2', title_ko: null }),
    ];
    await applyManualFix(records, 'tj-2', '수정됨');
    assert.equal(records[0].title_ko, '기존');
  });
});

describe('applyManualFix — --null flag', () => {
  it('sets title_ko=null, source=manual, removes confidence', async () => {
    const records = [
      makeRecord({
        id: 'tj-10',
        title_ko: '이전 번역',
        title_ko_source: 'llm-translated',
        title_ko_confidence: 'low',
      }),
    ];
    await applyManualFix(records, 'tj-10', null);
    const r = records[0];
    assert.equal(r.title_ko, null);
    assert.equal(r.title_ko_source, 'manual');
    assert.equal(r.title_ko_confidence, undefined);
  });
});

describe('applyManualFix — removes pre-existing title_ko_confidence', () => {
  it('drops confidence that was valid for llm-translated source', async () => {
    const records = [
      makeRecord({
        id: 'tj-54060',
        title_ko: '특자생존 원더라다-!!',
        title_ko_source: 'llm-translated',
        title_ko_confidence: 'medium',
      }),
    ];
    await applyManualFix(records, 'tj-54060', '특자생존 완다라다-!!');
    const r = records[0];
    assert.equal(r.title_ko, '특자생존 완다라다-!!');
    assert.equal(r.title_ko_source, 'manual');
    assert.equal(r.title_ko_confidence, undefined);
  });
});

describe('applyManualFix — error cases', () => {
  it('throws with "record not found" for unknown id', async () => {
    const records = [makeRecord({ id: 'tj-1' })];
    await assert.rejects(
      () => applyManualFix(records, 'tj-9999', '없음'),
      /record not found: tj-9999/,
    );
  });

  it('throws with "duplicate record_id" when corpus has two matching ids', async () => {
    const records = [makeRecord({ id: 'tj-1' }), makeRecord({ id: 'tj-1' })];
    await assert.rejects(
      () => applyManualFix(records, 'tj-1', '중복'),
      /duplicate record_id in corpus: tj-1/,
    );
  });
});

describe('applyManualFix — idempotent re-run', () => {
  it('produces byte-stable JSON output on a second application', async () => {
    const records = [
      makeRecord({ id: 'tj-25242', title_ko: null }),
      makeRecord({ id: 'tj-2', title_ko: '기존' }),
      makeRecord({ id: 'tj-3', title_ko: null }),
    ];

    await applyManualFix(records, 'tj-25242', '새의 시');
    const firstPass = `${JSON.stringify(records, null, 2)}\n`;

    await applyManualFix(records, 'tj-25242', '새의 시');
    const secondPass = `${JSON.stringify(records, null, 2)}\n`;

    assert.equal(firstPass, secondPass);
  });
});
