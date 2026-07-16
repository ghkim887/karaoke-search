import { describe, expect, it } from 'vitest';
import {
  KY_GATES,
  type KyOverridePredicates,
  PHASE_ORDER,
  assertPhaseOrder,
  classifyKyRow,
  kyStepForReason,
} from '../../../src/adapters/ky-kysing/classifier.js';

const NO_OVERRIDES: KyOverridePredicates = { isAllow: () => false, isDrop: () => false };
const allow = (n: string): KyOverridePredicates => ({
  isAllow: (k) => k === n,
  isDrop: () => false,
});
const drop = (n: string): KyOverridePredicates => ({
  isAllow: () => false,
  isDrop: (k) => k === n,
});

describe('classifyKyRow — reason enum branches', () => {
  it('admits a plain Japanese row as admit-index', () => {
    const r = classifyKyRow({
      ky: '44655',
      title: '怪物',
      artist: 'YOASOBI',
      overrides: NO_OVERRIDES,
    });
    expect(r).toEqual({ admit: true, reason: 'admit-index' });
  });

  it('admits a recovered row as admit-title-recovered', () => {
    const r = classifyKyRow({
      ky: '44418',
      title: '366LOVEダイアリー ("KING OF PRISM -Shiny Seven Stars-")',
      artist: '寺島惇太、斉藤壮馬、畠中祐、八代拓、五十嵐雅',
      recovered: true,
      overrides: NO_OVERRIDES,
    });
    expect(r).toEqual({ admit: true, reason: 'admit-title-recovered' });
  });

  it('drops a Korean-drop-list artist (any component) as drop-korean-artist', () => {
    // BTS is on the curated Korean drop list; a JP-looking title cannot rescue it.
    const r = classifyKyRow({ ky: '1', title: 'Film out', artist: 'BTS', overrides: NO_OVERRIDES });
    expect(r).toEqual({ admit: false, reason: 'drop-korean-artist' });
  });

  it('drops a Chinese-drop-list artist as drop-chinese-artist', () => {
    // BEYOND (Hong Kong) is on the curated Chinese drop list.
    const r = classifyKyRow({
      ky: '2',
      title: '海闊天空',
      artist: 'BEYOND',
      overrides: NO_OVERRIDES,
    });
    expect(r).toEqual({ admit: false, reason: 'drop-chinese-artist' });
  });

  it('drops a Korean-script row (Hangul, no JP script) as drop-korean-script', () => {
    // Artist not on any drop list, but the row reads as Korean script.
    const r = classifyKyRow({
      ky: '3',
      title: '봄날',
      artist: '가나다라마',
      overrides: NO_OVERRIDES,
    });
    expect(r).toEqual({ admit: false, reason: 'drop-korean-script' });
  });

  it('does NOT flag a mixed Hangul+kanji row as Korean-script (JP script present)', () => {
    const r = classifyKyRow({ ky: '4', title: '愛', artist: '가나다', overrides: NO_OVERRIDES });
    // Han present → not Korean-script; no drop-list hit → admits.
    expect(r.admit).toBe(true);
  });

  it('drops a simplified-Chinese-only row as drop-simplified-han', () => {
    // 说 is a curated PRC-simplified-only Han (Japanese would use 説).
    const r = classifyKyRow({
      ky: '5',
      title: '说好的',
      artist: '周杰倫',
      overrides: NO_OVERRIDES,
    });
    expect(r).toEqual({ admit: false, reason: 'drop-simplified-han' });
  });

  it('reviewed-allow admits before the drop gates (allow beats drop-list)', () => {
    // BTS would drop-korean-artist, but an exact-number ALLOW admits first.
    const r = classifyKyRow({ ky: '99', title: 'x', artist: 'BTS', overrides: allow('99') });
    expect(r).toEqual({ admit: true, reason: 'reviewed-allow' });
  });

  it('reviewed-drop forces a drop on an otherwise-admittable row', () => {
    const r = classifyKyRow({ ky: '77', title: '怪物', artist: 'YOASOBI', overrides: drop('77') });
    expect(r).toEqual({ admit: false, reason: 'reviewed-drop' });
  });
});

describe('KY classifier gate order', () => {
  it('gates run in the declared PHASE_ORDER', () => {
    expect(KY_GATES.map((g) => g.phase)).toEqual([
      'reviewed-allow',
      'reviewed-drop',
      'drop-list',
      'script-guard',
      'admit',
    ]);
    expect(() => assertPhaseOrder(KY_GATES)).not.toThrow();
  });

  it('assertPhaseOrder rejects a reordered gate array', () => {
    const reordered = [
      KY_GATES[3],
      KY_GATES[0],
      KY_GATES[1],
      KY_GATES[2],
      KY_GATES[4],
    ] as typeof KY_GATES;
    expect(() => assertPhaseOrder(reordered)).toThrow(/order violation/);
  });

  it('PHASE_ORDER covers exactly the gate phases', () => {
    expect(new Set(KY_GATES.map((g) => g.phase))).toEqual(new Set(PHASE_ORDER));
  });
});

describe('kyStepForReason', () => {
  it('maps every reason to its decision-log step', () => {
    expect(kyStepForReason('reviewed-allow')).toBe('reviewed-override');
    expect(kyStepForReason('reviewed-drop')).toBe('reviewed-override');
    expect(kyStepForReason('drop-korean-artist')).toBe('drop-list');
    expect(kyStepForReason('drop-chinese-artist')).toBe('drop-list');
    expect(kyStepForReason('drop-korean-script')).toBe('script-guard');
    expect(kyStepForReason('drop-simplified-han')).toBe('script-guard');
    expect(kyStepForReason('admit-title-recovered')).toBe('truncation-recovery');
    expect(kyStepForReason('admit-index')).toBe('index');
  });
});
