import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isKyTruncated,
  parseKyDetailRow,
  parseKyIndexRows,
} from '../../../src/adapters/ky-kysing/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = resolve(HERE, '../../fixtures/ky');
const load = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

describe('isKyTruncated', () => {
  it('flags a trailing two-dot sentinel', () => {
    expect(isKyTruncated('366LOVEダイアリー ("KING OF PRISM -Shiny..')).toBe(true);
    expect(isKyTruncated('寺島惇太、斉藤壮馬、畠中祐、八代拓、五十嵐雅..')).toBe(true);
  });
  it('does not flag a complete title', () => {
    expect(isKyTruncated('* ~アスタリスク~ ("BLEACH"OP)')).toBe(false);
    expect(isKyTruncated('怪物')).toBe(false);
  });
});

describe('parseKyIndexRows — live jp index fixture', () => {
  const rows = parseKyIndexRows(load('index-jp-a-page1.html'));

  it('parses all 200 data rows', () => {
    expect(rows).toHaveLength(200);
    for (const r of rows) {
      expect(r.ky).toMatch(/^[0-9]+$/);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.artist.length).toBeGreaterThan(0);
    }
  });

  it('reads the FULL visible title even when the title= attribute is quote-broken', () => {
    // Row 41905: the server emits an unescaped raw `"` in the title attribute
    // (`title="* ~アスタリスク~ ("`), but the visible cell text is the full title.
    const row = rows.find((r) => r.ky === '41905');
    expect(row).toBeDefined();
    expect(row?.title).toBe('* ~アスタリスク~ ("BLEACH"OP)');
    expect(row?.truncated).toBe(false);
  });

  it('marks a width-truncated row (trailing ..) as truncated', () => {
    const row = rows.find((r) => r.ky === '44418');
    expect(row).toBeDefined();
    expect(row?.title.endsWith('..')).toBe(true);
    expect(row?.truncated).toBe(true);
  });

  it('returns [] for an empty (out-of-range) page', () => {
    expect(parseKyIndexRows(load('index-jp-a-page99-empty.html'))).toEqual([]);
  });
});

describe('parseKyDetailRow — live category=1 detail fixtures', () => {
  it('returns the matching row for a short (untruncated) title', () => {
    const row = parseKyDetailRow(load('detail-41905.html'), '41905');
    expect(row).toEqual({
      ky: '41905',
      title: '* ~アスタリスク~ ("BLEACH"OP)',
      artist: 'ORANGE RANGE',
      truncated: false,
    });
  });

  it('reports truncated:true when the detail view ALSO truncates a long title', () => {
    // Empirical: category=1 applies the same width truncation as the index, so
    // it does not recover this long title — the crawler drops such a row.
    const row = parseKyDetailRow(load('detail-44418.html'), '44418');
    expect(row).not.toBeNull();
    expect(row?.title.endsWith('..')).toBe(true);
    expect(row?.truncated).toBe(true);
  });

  it('returns null when the requested number is not on the page (mismatch)', () => {
    expect(parseKyDetailRow(load('detail-41905.html'), '99999')).toBeNull();
  });
});
