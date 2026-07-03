import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { getLeadComponent } from './clustering.js';
import { normalize } from './normalize.js';
import {
  REVIEWED_TIER_E_JOYS_BY_TJ,
  REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS,
  REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER,
  reviewedTierFPairKey,
  VENDORS,
  type NonJoysoundVendor,
  type Vendor,
} from './reviewedMergePairs.js';

/**
 * Source priority (lower number = higher priority). Single source of truth
 * for tiebreaks across this file. The order blog > tj > tjpdf > joysound
 * is retained for known active corpus sources, with unknown legacy or
 * experimental prefixes falling back to lowest priority instead of shaping
 * merge semantics.
 *
 * joysound is intentionally lowest priority: it joins the merge primarily
 * to union its karaoke_numbers.joysound cell. Listing it here gives
 * pickByPriority a deterministic tiebreak without allowing JOYSOUND to
 * displace existing sources.
 */
const SOURCE_RANK: Record<string, number> = {
  blog: 1,
  tj: 2,
  tjpdf: 3,
  joysound: 4,
};

const TITLE_ARTIST_CHAIN = ['tj', 'blog', 'tjpdf', 'joysound'] as const;

// `tj` is an explicit member of the Korean-fields chain (lowest priority)
// because the TJ-direct adapter's `searchSong` translit pass (PR-1) writes
// `title_ko` / `artist_ko`. Pre-PR-1 the field fell through `pickByOwnership`'s
// unlisted-source fallback, which is order-dependent and silently ambiguous if
// a future source also writes Korean fields. Listing `tj` here makes the
// priority `blog > tj > tjpdf > joysound` explicit.
const KO_CHAIN = ['blog', 'tj', 'tjpdf', 'joysound'] as const;

/**
 * Source slug derived from the `id` prefix (everything before the first `-`).
 * The schema's `id` pattern is `^[a-z0-9-]+-\d+$`, so the slug may itself
 * contain `-` only if the source convention uses it; for the v1 blog source
 * (`blog-449-0`) the slug is `blog`. Examples: `tj-52498` → `tj`,
 * `blog-487-1` → `blog`, `tjpdf-12345` → `tjpdf`.
 *
 * Used for two distinct purposes:
 *   1. Per-field ownership and source-priority tiebreaks in `pickByOwnership`,
 *      `pickByPriority`, and `mergeKaraokeNumbers` (lookup against
 *      `SOURCE_RANK`).
 *   2. Tier C/D cross-source gating: soft clusters fire only when ≥ 2
 *      distinct slugs are represented, blocking same-source twins (e.g. two
 *      TJ releases of `방탄소년단(Feat.Nicki Minaj)` vs `방탄소년단`) from
 *      wrongly merging.
 */
function sourceSlug(r: SongRecord): string {
  const dash = r.id.indexOf('-');
  return dash === -1 ? r.id : r.id.slice(0, dash);
}

function sourceRank(slug: string): number {
  return SOURCE_RANK[slug] ?? Number.POSITIVE_INFINITY;
}

/**
 * Dash / prolonged-sound-mark fold applied ON TOP of `normalize()` for the
 * merger's Tier B/C/D clustering keys ONLY (deliberately NOT in the shared
 * `normalize()` — aliases.ts / clustering.ts / search keying keep their
 * semantics).
 *
 * Motivation: TJ's catalog writes the katakana long vowel `ー` (U+30FC) as an
 * ASCII hyphen (e.g. `特者生存ワンダラダ-!!` vs JOYSOUND's
 * `特者生存ワンダラダー!!`), splitting the same song into two records when no
 * karaoke number is shared. `normalize()` already strips every punctuation
 * dash (U+002D, U+FF0D, U+2010/2011, U+2013/2014/2015, U+2212 — all outside
 * `\p{L}\p{N}\p{M}`; U+FF70 `ｰ` NFKC-folds to U+30FC first), but U+30FC
 * itself is category Lm (Letter, modifier) and SURVIVES. Stripping the whole
 * dash class here folds `ダ-` / `ダー` / `ダ` to the same key. On the
 * `normalize()`-composed key parts (Tier B title/artist, Tier C title) the
 * pre-stripped punctuation-dash members are defense-in-depth against future
 * `normalize()` changes; on the Tier C ARTIST side — which composes over
 * `normalizeForMatch`, where punctuation survives — those same members are
 * LIVE (see `tierCKey`).
 */
const CLUSTER_DASH_FOLD_RE = /[-ー‐‑–—―−ｰ]/g;

function foldDashes(s: string): string {
  return s.replace(CLUSTER_DASH_FOLD_RE, '');
}

/** `normalize()` + dash fold — the merger's clustering-key normalization. */
function clusterKeyPart(s: string): string {
  return foldDashes(normalize(s));
}

/** Tier B clustering key (used for residuals after Tier A union-find). */
function tierBKey(r: SongRecord): string {
  return `${clusterKeyPart(r.title_primary)}|${clusterKeyPart(r.artist_primary)}`;
}

/**
 * Pre-fold Tier B key (plain `normalize()`, no dash fold). Used to decide
 * whether a Tier B group was brought together BY the fold — see the
 * cross-source gate in `mergeRecords`.
 */
function tierBKeyUnfolded(r: SongRecord): string {
  return `${normalize(r.title_primary)}|${normalize(r.artist_primary)}`;
}

/**
 * Tier C cluster key —
 * `clusterKeyPart(title_primary) | foldDashes(getLeadComponent(artist_primary))`.
 * Returns `null` when either field is empty after normalization, in which
 * case the record is unkeyable for Tier C and stays a singleton.
 *
 * Fix A.2 (2026-05-01): the lead-component extraction is now sourced from
 * the canonical `getLeadComponent` helper in the shared `clustering.ts` module
 * — the same helper the parser's lead-admit rule consumes. The previous
 * inline `primaryArtistToken` had a SUBSET of `splitArtistCollab`'s delimiter
 * regex (no `×` or `＆`), risking silent divergence: the same artist string
 * could produce different lead tokens between the merger's clustering key and
 * the parser's admit rule. Unifying through `getLeadComponent` eliminates
 * that drift class.
 */
function tierCKey(r: SongRecord): string | null {
  const t = clusterKeyPart(r.title_primary);
  // `getLeadComponent` returns `normalizeForMatch(lead)` (whitespace-strip +
  // lowercase + NFKC — punctuation KEPT; see clustering.ts), NOT a
  // `normalize()`d token. The dash fold is applied on top WITHOUT touching
  // the shared helper (the parser's lead-admit rule consumes it with
  // un-folded semantics). Because punctuation survives `normalizeForMatch`,
  // the ASCII/punctuation-dash members of CLUSTER_DASH_FOLD_RE are LIVE on
  // this artist side (not defense-in-depth as on the `normalize()`d title
  // side): `normalizeForMatch('X-Japan')` keeps the hyphen and `foldDashes`
  // strips it, so `X-Japan` vs `XJAPAN` leads now collide. This broadening
  // is INTENDED — Tier C unions stay cross-source-gated, so same-source
  // dash-variant leads never merge on this path alone.
  const a = foldDashes(getLeadComponent(r.artist_primary));
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

const CONTEXT_SUFFIX_RE = /\s*[\(（]([^()（）]{1,180})[\)）]\s*$/u;
const CONTEXT_ROLE_RE =
  /(?:^|[^a-z])(?:op|ed|ost|opening|ending|theme)(?:$|[^a-z])|ＯＰ|ＥＤ|ＯＳＴ|主題歌|挿入歌|オープニング|エンディング|テーマ/iu;
const CONTEXT_VERSION_RE =
  /(?:tv\s*size|tvサイズ|テレビ.*サイズ|サイズ|\bsize\b|anime\s*ver\.?|アニメ\s*ver\.?|movie\s*ver\.?|short\s*ver\.?|remix|リミックス|cover|カバー|version|\bver\.?\b|バージョン|m@ster|acoustic|live|instrumental)/iu;
const CONTEXT_ROLE_TOKEN_RE =
  /(?<![a-z])(?:op|ed|ost|opening|ending|theme)(?:\s*[\d０-９]+)?(?=$|[^a-z])|(?:ＯＰ|ＥＤ|ＯＳＴ|主題歌|挿入歌|オープニング|エンディング|テーマ)(?:\s*[\d０-９]+)?/giu;
const CONTEXT_SEASON_ONLY_RE =
  /(?:第\s*)?[\d０-９一二三四五六七八九十]+\s*期|season\s*[\d０-９]+|シーズン\s*[\d０-９一二三四五六七八九十]+|[\d０-９]+(?:st|nd|rd|th)?/giu;
const CONTEXT_NON_TEXT_RE = /[\s\-–—_:：/\\・!！.。'"“”‘’、,，]/gu;

function hasNonRoleContextText(inner: string): boolean {
  return (
    inner
      .replace(CONTEXT_ROLE_TOKEN_RE, '')
      .replace(CONTEXT_SEASON_ONLY_RE, '')
      .replace(CONTEXT_NON_TEXT_RE, '')
      .trim() !== ''
  );
}

function stripContextSuffix(title: string): { title: string; changed: boolean } {
  let current = title;
  let changed = false;
  while (true) {
    const match = current.match(CONTEXT_SUFFIX_RE);
    if (!match) break;
    const inner = match[1]?.trim() ?? '';
    // Version/size markers win over role/context markers inside the same
    // parenthetical: `テレビオープニングサイズ` contains `オープニング`, but
    // denotes a distinct karaoke cut and must stay keyed separately.
    if (CONTEXT_VERSION_RE.test(inner)) break;
    if (!CONTEXT_ROLE_RE.test(inner)) break;
    // Bare `(OP)` / `(ED)` / `(Ending)` labels are version-like risk. Strip
    // only when a work/franchise name is present alongside the role token.
    if (!hasNonRoleContextText(inner)) break;
    current = current.slice(0, match.index).trimEnd();
    changed = true;
  }
  return { title: current, changed };
}

function tierDKey(r: SongRecord): string | null {
  const stripped = stripContextSuffix(r.title_primary).title;
  const t = clusterKeyPart(stripped);
  const a = clusterKeyPart(r.artist_primary);
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

/**
 * Structured warning emitted when records cluster via Tier B (fuzzy
 * title+artist) AND disagree on a vendor field neither side used as the
 * clustering key. The merger does NOT abort — highest-priority source wins
 * per the ownership table — but the warning is surfaced for the crawl PR
 * body summary.
 *
 * The `'tier_c_merge'`, `'tier_d_context_title_merge'`,
 * `'tier_e_artist_credit_merge'`, `'tier_f_postcrawl_split_merge'`, and
 * `'tier_g_auto_residual_merge'` field
 * values document successful soft merges (one marker emitted per cluster, not
 * per record-pair) so the merge surfaces
 * in the crawl PR body for review. Sunset cadence per
 * `2026-05-01-kpop-leak-and-merge-fix-design.md` §3.C: 4 weeks of clean
 * cross-source output, then downgrade to a per-cluster log line.
 */
export interface MergeConflict {
  /**
   * Soft-merge cluster key. Tier B/C keys use `clusterKeyPart(title)|...`; Tier
   * D keys use `clusterKeyPart(refinedStripContext(title))|clusterKeyPart(artist)`;
   * Tier E keys use `tj:<number>|joysound:<number>` from the reviewed pair;
   * Tier F keys use `<vendor>:<number>|joysound:<number>` from the post-crawl
   * reviewed split-pair allowlist. Tier G keys use
   * `auto:<vendor>:<number>|joysound:<number>` from conservative residual
   * title/artist rules.
   * Conflict `cluster_key` strings are FOLDED since 2026-06-13 — cosmetic for
   * PR-body aggregation.
   */
  cluster_key: string;
  field:
    | 'tj'
    | 'ky'
    | 'joysound'
    | 'tier_c_merge'
    | 'tier_d_context_title_merge'
    | 'tier_e_artist_credit_merge'
    | 'tier_f_postcrawl_split_merge'
    | 'tier_g_auto_residual_merge';
  values: { source: string; value: string }[];
  /** The value that wins per source priority, or the merged record id for marker rows. */
  winner: string;
}

export interface MergeResult {
  records: SongRecord[];
  conflicts: MergeConflict[];
}

/**
 * Filter out soft-merge marker entries so the headline "merge conflicts" count
 * reported to the crawl PR body / CLI stdout reflects only true vendor-number
 * disagreements.
 *
 * Fix B.1 (2026-05-01): Tier C merges are NOT disagreements — they're
 * successful soft-merges flagged for visibility. Tier D context-title merges
 * and Tier E/F/G reviewed/rule pair merges follow the same marker semantics.
 * The full conflicts list (and any `sample` slice) keeps marker entries for
 * forensic inspection; only the headline `total` is filtered. Centralised here
 * so `pipeline.ts` and `cli.ts` share one definition.
 */
export function headlineConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  return conflicts.filter(
    (c) =>
      c.field !== 'tier_c_merge' &&
      c.field !== 'tier_d_context_title_merge' &&
      c.field !== 'tier_e_artist_credit_merge' &&
      c.field !== 'tier_f_postcrawl_split_merge' &&
      c.field !== 'tier_g_auto_residual_merge',
  );
}

// --- Union-Find ----------------------------------------------------------

function isReviewedTierFJoySideShape(
  vendor: NonJoysoundVendor,
  number: string,
  joysound: string,
  joy: SongRecord,
): boolean {
  if (joy.karaoke_numbers.joysound !== joysound || joy.karaoke_numbers[vendor] !== null) {
    return false;
  }
  if (nonNullVendorNumberCount(joy) === 1) return true;

  const allowedExtra = REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS.get(
    reviewedTierFPairKey(vendor, number, joysound),
  );
  if (allowedExtra === undefined) return false;

  for (const extraVendor of ['tj', 'ky'] as const satisfies readonly NonJoysoundVendor[]) {
    if (extraVendor === vendor) continue;
    const actual = joy.karaoke_numbers[extraVendor];
    const expected = allowedExtra[extraVendor] ?? null;
    if (actual !== expected) return false;
  }
  return true;
}

type VendorIndexes = Record<Vendor, Map<string, number[]>>;

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      // biome-ignore lint/style/noNonNullAssertion: index is always within bounds
      root = this.parent[root]!;
    }
    // Path compression.
    let cur = i;
    while (this.parent[cur] !== root) {
      // biome-ignore lint/style/noNonNullAssertion: index is always within bounds
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function addToIndex(index: Map<string, number[]>, key: string, recordIndex: number): void {
  const existing = index.get(key);
  if (existing) existing.push(recordIndex);
  else index.set(key, [recordIndex]);
}

function buildVendorIndexes(records: SongRecord[]): VendorIndexes {
  const indexes: VendorIndexes = {
    tj: new Map<string, number[]>(),
    ky: new Map<string, number[]>(),
    joysound: new Map<string, number[]>(),
  };

  for (let i = 0; i < records.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const r = records[i]!;
    for (const vendor of VENDORS) {
      const value = r.karaoke_numbers[vendor];
      if (value !== null) addToIndex(indexes[vendor], value, i);
    }
  }

  return indexes;
}

function unionIndexedDuplicates(uf: UnionFind, indexes: Iterable<Map<string, number[]>>): void {
  for (const index of indexes) {
    for (const idxs of index.values()) {
      if (idxs.length < 2) continue;
      // biome-ignore lint/style/noNonNullAssertion: length >= 2
      const first = idxs[0]!;
      for (let k = 1; k < idxs.length; k++) {
        // biome-ignore lint/style/noNonNullAssertion: k in bounds
        uf.union(first, idxs[k]!);
      }
    }
  }
}

function countRoots(uf: UnionFind, size: number): Map<number, number> {
  const sizeByRoot = new Map<number, number>();
  for (let i = 0; i < size; i++) {
    const root = uf.find(i);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }
  return sizeByRoot;
}

function groupSingletonsByKey(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
  keyForRecord: (record: SongRecord) => string | null,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = keyForRecord(records[i]!);
    if (key === null) continue;
    addToIndex(groups, key, i);
  }
  return groups;
}

function unionIndexGroups(uf: UnionFind, groups: Iterable<number[]>): Set<number> {
  const roots = new Set<number>();
  for (const idxs of groups) {
    if (idxs.length < 2) continue;
    // biome-ignore lint/style/noNonNullAssertion: length >= 2
    const first = idxs[0]!;
    for (let k = 1; k < idxs.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: k in bounds
      uf.union(first, idxs[k]!);
    }
    roots.add(uf.find(first));
  }
  return roots;
}

function hasMultipleSourceSlugs(records: SongRecord[], idxs: number[]): boolean {
  const slugs = new Set<string>();
  for (const i of idxs) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    slugs.add(sourceSlug(records[i]!));
  }
  return slugs.size >= 2;
}

function shouldUnionTierCGroup(records: SongRecord[], idxs: number[]): boolean {
  return hasMultipleSourceSlugs(records, idxs);
}

function hasContextStrippedTitle(records: SongRecord[], idxs: number[]): boolean {
  for (const i of idxs) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    if (stripContextSuffix(records[i]!.title_primary).changed) return true;
  }
  return false;
}

function shouldUnionTierDGroup(records: SongRecord[], idxs: number[]): boolean {
  return hasMultipleSourceSlugs(records, idxs) && hasContextStrippedTitle(records, idxs);
}

function singletonVendorIndex(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
  vendor: Vendor,
): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const value = records[i]!.karaoke_numbers[vendor];
    if (value !== null) index.set(value, i);
  }
  return index;
}

function tierEClusterKey(tj: string, joysound: string): string {
  return `tj:${tj}|joysound:${joysound}`;
}

function tierFClusterKey(vendor: NonJoysoundVendor, number: string, joysound: string): string {
  return `${vendor}:${number}|joysound:${joysound}`;
}

function tierGClusterKey(vendor: NonJoysoundVendor, number: string, joysound: string): string {
  return `auto:${vendor}:${number}|joysound:${joysound}`;
}

function nonNullVendorNumberCount(record: SongRecord): number {
  let count = 0;
  for (const vendor of VENDORS) {
    if (record.karaoke_numbers[vendor] !== null) count += 1;
  }
  return count;
}

function collectTierEReviewedStrongGroups(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const tjIndex = singletonVendorIndex(records, uf, sizeByRoot, 'tj');
  const joysoundIndex = singletonVendorIndex(records, uf, sizeByRoot, 'joysound');

  for (const [tj, joysoundValues] of REVIEWED_TIER_E_JOYS_BY_TJ) {
    const tjIdx = tjIndex.get(tj);
    if (tjIdx === undefined) continue;
    for (const joysound of joysoundValues) {
      const joyIdx = joysoundIndex.get(joysound);
      if (joyIdx === undefined || joyIdx === tjIdx) continue;
      // Tier E was reviewed specifically as raw TJ official ↔ raw JOYSOUND
      // official evidence. A blog/manual singleton carrying one of the same
      // numbers should not widen this 65-pair data change implicitly.
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      if (sourceSlug(records[tjIdx]!) !== 'tj' || sourceSlug(records[joyIdx]!) !== 'joysound')
        continue;
      const idxs = [tjIdx, joyIdx];
      if (!hasMultipleSourceSlugs(records, idxs)) continue;
      groups.set(tierEClusterKey(tj, joysound), idxs);
    }
  }

  return groups;
}

function collectTierFPostcrawlReviewedGroups(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const targetIndexes: Record<NonJoysoundVendor, Map<string, number>> = {
    tj: singletonVendorIndex(records, uf, sizeByRoot, 'tj'),
    ky: singletonVendorIndex(records, uf, sizeByRoot, 'ky'),
  };
  const joysoundIndex = singletonVendorIndex(records, uf, sizeByRoot, 'joysound');

  for (const [vendorNumberKey, joysoundValues] of REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER) {
    const [vendor, number] = vendorNumberKey.split(':') as [NonJoysoundVendor, string];
    const targetIdx = targetIndexes[vendor].get(number);
    if (targetIdx === undefined) continue;
    for (const joysound of joysoundValues) {
      const joyIdx = joysoundIndex.get(joysound);
      if (joyIdx === undefined || joyIdx === targetIdx) continue;
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      const target = records[targetIdx]!;
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      const joy = records[joyIdx]!;

      // Preserve the audit scope: target side must still be a single TJ/KY-only
      // row, and the JOYSOUND side must not already carry that same provider.
      if (nonNullVendorNumberCount(target) !== 1) continue;
      if (target.karaoke_numbers[vendor] !== number || target.karaoke_numbers.joysound !== null)
        continue;
      // The reviewed surface is a split pair, not an implicit triple merge:
      // the JOYSOUND-side row must stay JOY-only unless this exact pair also
      // lists an explicit, already-reviewed extra provider number.
      if (!isReviewedTierFJoySideShape(vendor, number, joysound, joy)) continue;

      const cluster = [target, joy];
      if (collectVendorNumberConflicts(cluster).length > 0) continue;
      groups.set(tierFClusterKey(vendor, number, joysound), [targetIdx, joyIdx]);
    }
  }

  return groups;
}

// --- Tier G: conservative automatic residual TJ/KY↔JOYSOUND rules --------

const AUTO_TITLE_LEGACY_CHAR_MAP: ReadonlyMap<string, string> = new Map([
  ['亞', '亜'],
  ['惡', '悪'],
  ['壓', '圧'],
  ['圍', '囲'],
  ['壹', '一'],
  ['榮', '栄'],
  ['驛', '駅'],
  ['櫻', '桜'],
  ['奧', '奥'],
  ['應', '応'],
  ['歐', '欧'],
  ['溫', '温'],
  ['價', '価'],
  ['樂', '楽'],
  ['氣', '気'],
  ['峽', '峡'],
  ['鄕', '郷'],
  ['曉', '暁'],
  ['廣', '広'],
  ['黑', '黒'],
  ['碎', '砕'],
  ['雜', '雑'],
  ['樣', '様'],
  ['兒', '児'],
  ['實', '実'],
  ['寫', '写'],
  ['從', '従'],
  ['澁', '渋'],
  ['敍', '叙'],
  ['將', '将'],
  ['燒', '焼'],
  ['條', '条'],
  ['乘', '乗'],
  ['淨', '浄'],
  ['眞', '真'],
  ['圖', '図'],
  ['數', '数'],
  ['靑', '青'],
  ['靜', '静'],
  ['聲', '声'],
  ['攝', '摂'],
  ['戰', '戦'],
  ['纖', '繊'],
  ['總', '総'],
  ['臺', '台'],
  ['瀧', '滝'],
  ['單', '単'],
  ['團', '団'],
  ['彈', '弾'],
  ['晝', '昼'],
  ['蟲', '虫'],
  ['廳', '庁'],
  ['鐵', '鉄'],
  ['轉', '転'],
  ['傳', '伝'],
  ['燈', '灯'],
  ['德', '徳'],
  ['獨', '独'],
  ['突', '突'],
  ['霸', '覇'],
  ['發', '発'],
  ['濱', '浜'],
  ['拂', '払'],
  ['佛', '仏'],
  ['邊', '辺'],
  ['變', '変'],
  ['辨', '弁'],
  ['瓣', '弁'],
  ['寶', '宝'],
  ['豐', '豊'],
  ['沒', '没'],
  ['萬', '万'],
  ['默', '黙'],
  ['藥', '薬'],
  ['譯', '訳'],
  ['豫', '予'],
  ['龍', '竜'],
  ['兩', '両'],
  ['獵', '猟'],
  ['戀', '恋'],
  ['朗', '朗'],
  ['﨑', '崎'],
  ['瀨', '瀬'],
  ['惠', '恵'],
  ['螢', '蛍'],
  ['泪', '涙'],
  ['讚', '讃'],
] as const);

const AUTO_LEGACY_CHAR_RE = new RegExp(
  `[${[...AUTO_TITLE_LEGACY_CHAR_MAP.keys()].map(escapeRegExp).join('')}]`,
  'gu',
);
const AUTO_DECORATIVE_ANGLE_RE =
  /\s*《(?:本人映像|本人歌唱映像|レコおと|アニメカラオケ|ガイドボーカル|生演奏|うたいり|家庭用カラオケ)[^《》]*》\s*$/iu;
const AUTO_ARTIST_COLLAB_RE = /[\(（\)）,，、/\\&＆＋+×]|\b(?:feat\.?|featuring|with|cv\.?)\b/iu;
const AUTO_ARTIST_UNSAFE_CREDIT_RE = /[,，、/\\&＆＋+×]|\b(?:feat\.?|featuring|with|cv\.?)\b/iu;
const AUTO_VOICE_CREDIT_RE = /(?:^|[\s(（\[【:/・])cv\.?\s*[:：.)）]?/iu;
const AUTO_UNSAFE_SHORT_ARTIST_RE = /^\d{1,2}$/u;
const AUTO_UNSAFE_TITLE_KEYS = new Set(['notitle', 'untitled', '無題']);
const AUTO_UNSAFE_TITLE_SURFACE_RE =
  /[+＋]|(?:tv\s*size|tvサイズ|テレビ.*サイズ|\bsize\b|anime\s*ver\.?|アニメ\s*ver\.?|movie\s*ver\.?|short\s*ver\.?|remix|リミックス|mix|ミックス|club\s*edit|edit|エディット|cover|カバー|version|\bver\.?\b|バージョン|ヴァージョン|シングル|single|m@ster|acoustic|live|instrumental)/iu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldLegacyChars(s: string): string {
  return s.replace(AUTO_LEGACY_CHAR_RE, (ch) => AUTO_TITLE_LEGACY_CHAR_MAP.get(ch) ?? ch);
}

function stripAutoTitleSuffixes(title: string): string {
  let current = title;
  let changed = true;
  while (changed) {
    changed = false;

    const withoutDecor = current.replace(AUTO_DECORATIVE_ANGLE_RE, '').trimEnd();
    if (withoutDecor !== current) {
      current = withoutDecor;
      changed = true;
      continue;
    }

    const context = stripContextSuffix(current);
    if (context.changed) {
      current = context.title;
      changed = true;
    }

    // Do not strip kana-only parentheticals here. Some are readings, but others
    // are distinct karaoke cuts or work/version context (`シングル・ヴァージョン`,
    // `ヒプノシスマイク`). Automatic Tier G stays conservative; reading-only
    // folds can move to a reviewed allowlist/tier later.
  }
  return current;
}

function autoMergeTitleKey(record: SongRecord): string {
  return clusterKeyPart(foldLegacyChars(stripAutoTitleSuffixes(record.title_primary)));
}

function isUnsafeAutoTitleKey(key: string): boolean {
  return AUTO_UNSAFE_TITLE_KEYS.has(key);
}

function hasUnsafeAutoTitleSurface(value: string): boolean {
  return AUTO_UNSAFE_TITLE_SURFACE_RE.test(value);
}

function autoMergeArtistKey(value: string): string {
  return clusterKeyPart(foldLegacyChars(value));
}

function hasUnsafeShortArtistKey(value: string): boolean {
  return AUTO_UNSAFE_SHORT_ARTIST_RE.test(autoMergeArtistKey(value));
}

function hasCollabArtistSurface(value: string): boolean {
  return AUTO_ARTIST_COLLAB_RE.test(value);
}

function artistBoundarySurface(value: string): string {
  return foldLegacyChars(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function hasSafeExpandedArtistPrefix(targetArtistRaw: string, joyArtistRaw: string): boolean {
  const targetArtist = autoMergeArtistKey(targetArtistRaw);
  const joyArtist = autoMergeArtistKey(joyArtistRaw);
  if (targetArtist.length < 3) return false;
  if (AUTO_UNSAFE_SHORT_ARTIST_RE.test(targetArtist)) return false;
  if (AUTO_VOICE_CREDIT_RE.test(joyArtistRaw)) return false;
  if (
    AUTO_ARTIST_UNSAFE_CREDIT_RE.test(targetArtistRaw) ||
    AUTO_ARTIST_UNSAFE_CREDIT_RE.test(joyArtistRaw)
  ) {
    return false;
  }
  if (!joyArtist.startsWith(targetArtist)) return false;

  const targetSurface = artistBoundarySurface(targetArtistRaw);
  const joySurface = artistBoundarySurface(joyArtistRaw);
  if (!joySurface.startsWith(targetSurface)) return false;
  const next = joySurface[targetSurface.length];
  // Safe automatic prefix expansion is limited to explicit separated credits,
  // e.g. `GACKT(Gackt)` or `Group(member list)`. Plain lexical prefixes such
  // as `ALI` -> `AliA` need manual review.
  return next === undefined || /^[\(（\[【{｛<＜]/u.test(next);
}

function safeKoBridge(target: SongRecord, joy: SongRecord): boolean {
  if (target.artist_ko === null || joy.artist_ko === null) return false;
  if (koDisplayKey(target.artist_ko) !== koDisplayKey(joy.artist_ko)) return false;
  // Prevent feature-artist leakage such as `MISIA(Feat.HIDE(GReeeeN))` ↔
  // `GReeeeN`: Korean display names are safe only for simple, non-collab
  // primary artist surfaces.
  if (hasCollabArtistSurface(target.artist_primary) || hasCollabArtistSurface(joy.artist_primary)) {
    return false;
  }
  if (
    hasUnsafeShortArtistKey(target.artist_primary) ||
    hasUnsafeShortArtistKey(joy.artist_primary)
  ) {
    return false;
  }
  return true;
}

function safeAutoArtistEvidence(target: SongRecord, joy: SongRecord): boolean {
  const targetArtist = autoMergeArtistKey(target.artist_primary);
  const joyArtist = autoMergeArtistKey(joy.artist_primary);
  if (targetArtist !== '' && targetArtist === joyArtist) return true;
  // Only boundary-separated prefix expansion is treated as a rule-safe
  // alias/credit expansion (`Gackt` → `GACKT(Gackt)`, group → group(member
  // list)). Infix/lexical prefix containment such as character(CV:voice actor)
  // or `ALI` → `AliA` still needs raw review.
  if (hasSafeExpandedArtistPrefix(target.artist_primary, joy.artist_primary)) {
    return true;
  }
  return safeKoBridge(target, joy);
}

function isAutoMergeTarget(record: SongRecord, vendor: NonJoysoundVendor): boolean {
  return (
    nonNullVendorNumberCount(record) === 1 &&
    record.karaoke_numbers[vendor] !== null &&
    record.karaoke_numbers.joysound === null
  );
}

function isAutoMergeJoySide(record: SongRecord): boolean {
  // Keep the rule-generated surface JOY-only. Exact reviewed exceptions that
  // import a third provider belong in Tier F, not this broad rule tier.
  return record.karaoke_numbers.joysound !== null && nonNullVendorNumberCount(record) === 1;
}

function collectTierGAutoResidualGroups(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const joyByTitle = new Map<string, number[]>();
  const targets: { vendor: NonJoysoundVendor; number: string; idx: number; titleKey: string }[] =
    [];

  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const record = records[i]!;
    if (hasUnsafeAutoTitleSurface(record.title_primary)) continue;
    const titleKey = autoMergeTitleKey(record);
    if (titleKey === '' || isUnsafeAutoTitleKey(titleKey)) continue;

    if (isAutoMergeJoySide(record)) {
      addToIndex(joyByTitle, titleKey, i);
      continue;
    }

    for (const vendor of ['tj', 'ky'] as const satisfies readonly NonJoysoundVendor[]) {
      if (!isAutoMergeTarget(record, vendor)) continue;
      const number = record.karaoke_numbers[vendor];
      if (number === null) continue;
      targets.push({ vendor, number, idx: i, titleKey });
    }
  }

  const candidatesByTarget = new Map<number, number[]>();
  const targetsByJoy = new Map<string, number[]>();
  for (const target of targets) {
    // biome-ignore lint/style/noNonNullAssertion: indexes came from records
    const targetRecord = records[target.idx]!;
    const joyCandidates = (joyByTitle.get(target.titleKey) ?? []).filter((joyIdx) => {
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      const joy = records[joyIdx]!;
      return safeAutoArtistEvidence(targetRecord, joy);
    });
    candidatesByTarget.set(target.idx, joyCandidates);
    for (const joyIdx of joyCandidates) addToIndex(targetsByJoy, String(joyIdx), target.idx);
  }

  for (const target of targets) {
    const joyCandidates = candidatesByTarget.get(target.idx);
    if (joyCandidates?.length !== 1) continue;
    const joyIdx = joyCandidates[0];
    if (joyIdx === undefined) continue;
    if ((targetsByJoy.get(String(joyIdx)) ?? []).length !== 1) continue;

    // biome-ignore lint/style/noNonNullAssertion: indexes came from records
    const targetRecord = records[target.idx]!;
    // biome-ignore lint/style/noNonNullAssertion: indexes came from records
    const joyRecord = records[joyIdx]!;
    const joysound = joyRecord.karaoke_numbers.joysound;
    if (joysound === null) continue;
    const cluster = [targetRecord, joyRecord];
    if (collectVendorNumberConflicts(cluster).length > 0) continue;
    groups.set(tierGClusterKey(target.vendor, target.number, joysound), [target.idx, joyIdx]);
  }

  return groups;
}

interface VendorNumberConflict {
  vendor: Vendor;
  contributions: { slug: string; value: string }[];
  winner: string;
}

function collectVendorNumberConflicts(cluster: SongRecord[]): VendorNumberConflict[] {
  const out: VendorNumberConflict[] = [];
  for (const vendor of VENDORS) {
    const contributions: { slug: string; value: string }[] = [];
    for (const r of cluster) {
      const value = r.karaoke_numbers[vendor];
      if (value !== null) contributions.push({ slug: sourceSlug(r), value });
    }
    if (new Set(contributions.map((c) => c.value)).size <= 1) continue;

    let winner = contributions[0];
    if (!winner) continue;
    let winnerRank = sourceRank(winner.slug);
    for (let i = 1; i < contributions.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const c = contributions[i]!;
      const rank = sourceRank(c.slug);
      if (rank < winnerRank) {
        winner = c;
        winnerRank = rank;
      }
    }
    out.push({ vendor, contributions, winner: winner.value });
  }
  return out;
}

function recordTierDBlockedConflicts(
  conflicts: MergeConflict[],
  clusterKey: string,
  cluster: SongRecord[],
): void {
  for (const conflict of collectVendorNumberConflicts(cluster)) {
    conflicts.push({
      cluster_key: clusterKey,
      field: conflict.vendor,
      values: conflict.contributions.map((c) => ({ source: c.slug, value: c.value })),
      winner: conflict.winner,
    });
  }
}

function collectClusters(uf: UnionFind, size: number): Map<number, number[]> {
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const root = uf.find(i);
    const arr = clusters.get(root);
    if (arr) arr.push(i);
    else clusters.set(root, [i]);
  }
  return clusters;
}

// --- Per-field ownership ------------------------------------------------

/**
 * Pick the first non-null value found by walking `ownerOrder` source slugs
 * in priority order. Within a slug, multiple records' contributions are
 * scanned in input order; the first non-null hit wins.
 */
function pickByOwnership<T>(
  cluster: SongRecord[],
  ownerOrder: readonly string[],
  field: (r: SongRecord) => T | null,
): T | null {
  for (const slug of ownerOrder) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug) {
        const v = field(r);
        if (v !== null) return v;
      }
    }
  }
  // Fallback: any record in the cluster from a non-listed source.
  for (const r of cluster) {
    const v = field(r);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Pick a string field by source priority — the highest-priority contributing
 * source's value wins. Used for `id` and `source_url` (the v1 tiebreak rule
 * retained for stable cross-source attribution).
 */
function pickByPriority(cluster: SongRecord[], field: (r: SongRecord) => string): string {
  let winner = cluster[0];
  if (!winner) throw new Error('empty cluster');
  let winnerRank = sourceRank(sourceSlug(winner));
  for (let i = 1; i < cluster.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by cluster length
    const r = cluster[i]!;
    const rank = sourceRank(sourceSlug(r));
    if (rank < winnerRank) {
      winner = r;
      winnerRank = rank;
    }
  }
  return field(winner);
}

/**
 * Merge a cluster's vendor numbers field-by-field.
 *
 *  - For each vendor (tj/ky/joysound), union all non-null contributions.
 *  - When multiple records contribute DIFFERENT non-null values for the SAME
 *    vendor, the highest-priority source's value wins (chain blog→tj→tjpdf→joysound).
 *  - If `tierBClusterKey` is non-null AND disagreement is detected on a
 *    vendor field that was NOT the clustering key, emit a `MergeConflict`.
 *    (Tier A clusters can't disagree on the joining vendor — they share it
 *    by construction — but they CAN disagree on other vendors; those are
 *    silently resolved by priority since the cluster identity is solid.)
 */
function mergeKaraokeNumbers(
  cluster: SongRecord[],
  tierBClusterKey: string | null,
  conflicts: MergeConflict[],
): KaraokeNumbers {
  const result: KaraokeNumbers = { tj: null, ky: null, joysound: null };

  for (const vendor of VENDORS) {
    // Collect (slug, value) pairs of non-null contributions.
    const contributions: { slug: string; value: string }[] = [];
    for (const r of cluster) {
      const v = r.karaoke_numbers[vendor];
      if (v !== null) {
        contributions.push({ slug: sourceSlug(r), value: v });
      }
    }
    if (contributions.length === 0) continue;

    // Highest-priority winner for this vendor.
    let winner = contributions[0];
    if (!winner) continue;
    let winnerRank = sourceRank(winner.slug);
    for (let i = 1; i < contributions.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const c = contributions[i]!;
      const rank = sourceRank(c.slug);
      if (rank < winnerRank) {
        winner = c;
        winnerRank = rank;
      }
    }
    result[vendor] = winner.value;

    // Conflict detection: Tier B cluster + disagreeing non-null values.
    if (tierBClusterKey !== null) {
      const distinctValues = new Set(contributions.map((c) => c.value));
      if (distinctValues.size > 1) {
        conflicts.push({
          cluster_key: tierBClusterKey,
          field: vendor,
          values: contributions.map((c) => ({ source: c.slug, value: c.value })),
          winner: winner.value,
        });
      }
    }
  }

  return result;
}

/**
 * Union the cluster's `artist_aliases` arrays (preserving first-seen order),
 * filter out any alias equal to the merged record's `artist_primary`, and
 * return undefined when the union is empty (the schema prefers absence over
 * `[]` for storage compactness — see §2.B of the alias-dedup spec).
 *
 * The canonical-only filter (`a === mergedArtistPrimary`) is correct because
 * upstream propagation (Phase 3 of `resolveArtistAliases`) guarantees that by
 * the time records reach the merger, any re-keyed record's `artist_primary` is
 * already the canonical surface form. The loser's canonical therefore equals
 * the winner's canonical, so filtering on the merged primary is sufficient to
 * suppress self-aliases without any additional lookup.
 */
function mergeArtistAliases(
  cluster: SongRecord[],
  mergedArtistPrimary: string,
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of cluster) {
    const aliases = r.artist_aliases;
    if (!aliases) continue;
    for (const a of aliases) {
      if (a === mergedArtistPrimary) continue;
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Pick the cluster member whose `title_ko` was selected by `pickByOwnership`
 * walking `koChain`. Both passes walk the chain in identical order so the
 * chosen donor is always the same record whose `title_ko` wins the merge —
 * keeping the trio (`title_ko`, `title_ko_source`, `title_ko_confidence`) and
 * `media_context_ko` coherent on a single record.
 *
 * Two-pass strategy:
 *   1. Prefer a record that has a non-null `title_ko` AND matches a chain slug.
 *   2. Latin-titled fallback: `title_ko` may be null but `media_context_ko`
 *      may be set (e.g. an anime track with a Latin title whose only Korean
 *      signal is the media-context parenthetical).
 *
 * Returns `null` when the cluster has no KO signal at all (all fields absent).
 */
function pickKoDonor(cluster: SongRecord[], koChain: readonly string[]): SongRecord | null {
  // Pass 1: record whose title_ko was selected.
  for (const slug of koChain) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug && r.title_ko !== null) return r;
    }
  }
  // Pass 2: Latin-titled fallback — title_ko is null but media_context_ko set.
  for (const slug of koChain) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug && r.media_context_ko !== undefined) return r;
    }
  }
  // Fallback: any record in the cluster with a media_context_ko (non-listed source).
  for (const r of cluster) {
    if (r.media_context_ko !== undefined) return r;
  }
  return null;
}

function latestCrawledAt(cluster: SongRecord[]): string {
  let latest = cluster[0]?.crawled_at ?? '';
  for (const r of cluster) {
    if (r.crawled_at > latest) latest = r.crawled_at;
  }
  return latest;
}

function optionalKoFields(koDonor: SongRecord | null): Partial<SongRecord> {
  return {
    // Optional KO-pipeline fields: spread from the single donor so the trio
    // (media_context_ko, title_ko_source, title_ko_confidence) stays coherent.
    // Absence is preferred over undefined/null (schema uses optional, not nullable).
    ...(koDonor?.media_context_ko !== undefined
      ? { media_context_ko: koDonor.media_context_ko }
      : {}),
    ...(koDonor?.title_ko_source !== undefined ? { title_ko_source: koDonor.title_ko_source } : {}),
    ...(koDonor?.title_ko_confidence !== undefined
      ? { title_ko_confidence: koDonor.title_ko_confidence }
      : {}),
  };
}

function recordTierCConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  tierBClusterKey: string | null,
): void {
  // Tier C: emit one structured warning per cluster (NOT per record-pair) so
  // the cross-source merge surfaces in the crawl PR body. Sunset per §3.C.
  const cKey = tierCKey(cluster[0] as SongRecord) ?? tierBClusterKey ?? '';
  conflicts.push({
    cluster_key: cKey,
    field: 'tier_c_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierDConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_d_context_title_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierEConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_e_artist_credit_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierFConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_f_postcrawl_split_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierGConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_g_auto_residual_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function compareNullableTj(a: string | null, b: string | null): number {
  // Null TJ records sort last regardless of the other side's codepoint.
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (a !== null && b !== null) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function compareMergedRecords(a: SongRecord, b: SongRecord): number {
  const tjOrder = compareNullableTj(a.karaoke_numbers.tj, b.karaoke_numbers.tj);
  if (tjOrder !== 0) return tjOrder;

  const an = normalize(a.title_primary);
  const bn = normalize(b.title_primary);
  if (an < bn) return -1;
  if (an > bn) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortMergedRecords(records: SongRecord[]): void {
  records.sort(compareMergedRecords);
}

/**
 * Conservative Korean display-key normalization used ONLY by cross-record
 * `artist_ko` propagation (NOT the shared `normalize()`): NFKC + locale-
 * independent lowercase + strip ALL whitespace. It deliberately KEEPS
 * punctuation and script, so it treats spacing differences as equivalent
 * (`마키하라 노리유키` ≡ `마키하라노리유키`) while treating spelling differences
 * (`마키하라 노리유키` ≠ `하타 모토히로`) as a genuine conflict. `normalize()`
 * is wrong here — its `\p{L}\p{N}\p{M}` strip would fold distinct punctuation
 * apart and is meant for identity keying, not Korean display agreement.
 */
function koDisplayKey(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, '');
}

/**
 * Cross-record `artist_ko` propagation (spec 2026-06-14). Runs AFTER clusters
 * are materialized: standalone JOYSOUND rows by the same artist are NOT in the
 * same song cluster (no shared karaoke number, different title), so the
 * per-cluster `KO_CHAIN` fill in `mergeCluster` cannot reach them.
 *
 * This is NOT a song merge — it never unions karaoke numbers or collapses
 * rows. It only fills a MISSING `artist_ko` when:
 *   - records share the conservative full-artist identity key
 *     `normalize(artist_primary)` (empty-after-normalize keys are unkeyable
 *     and never propagate), AND
 *   - every donor (record with a non-null `artist_ko`) for that key agrees
 *     after `koDisplayKey` (whitespace-insensitive). If donors disagree the
 *     ENTIRE key group is skipped — no partial fill, no source-based choice.
 *
 * When safe, the display value is chosen by the KO ownership source priority
 * (`SOURCE_RANK`: blog > tj > tjpdf > joysound), with an `id`-ascending
 * tie-break for determinism, then outer whitespace is trimmed. Existing
 * non-null `artist_ko` values are NEVER overwritten — even by a higher-priority
 * donor. Records are not mutated: filled rows are returned as fresh objects and
 * untouched rows pass through by reference.
 */
function propagateArtistKo(records: SongRecord[]): SongRecord[] {
  // Group record indexes by the conservative full-artist identity key.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = normalize(records[i]!.artist_primary);
    if (key === '') continue; // unkeyable — never propagate across empties
    addToIndex(groups, key, i);
  }

  // Per group, decide the single safe display value to fill (if any).
  const fillByIndex = new Map<number, string>();
  for (const idxs of groups.values()) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const donors = idxs.map((i) => records[i]!).filter((r) => r.artist_ko !== null);
    if (donors.length === 0) continue;

    // Conflict guard: all donor values must agree (whitespace-insensitive).
    const displayKeys = new Set(donors.map((r) => koDisplayKey(r.artist_ko as string)));
    if (displayKeys.size > 1) continue;

    // Pick the display value by KO ownership priority, id-ascending tie-break.
    let winner = donors[0];
    if (!winner) continue;
    let winnerRank = sourceRank(sourceSlug(winner));
    for (let k = 1; k < donors.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const d = donors[k]!;
      const rank = sourceRank(sourceSlug(d));
      if (rank < winnerRank || (rank === winnerRank && d.id < winner.id)) {
        winner = d;
        winnerRank = rank;
      }
    }
    const value = (winner.artist_ko as string).trim();
    // Schema requires artist_ko minLength 1; never fill with an empty surface.
    if (value === '') continue;

    for (const i of idxs) {
      // biome-ignore lint/style/noNonNullAssertion: i in bounds
      if (records[i]!.artist_ko === null) fillByIndex.set(i, value);
    }
  }

  if (fillByIndex.size === 0) return records;

  return records.map((r, i) => {
    const fill = fillByIndex.get(i);
    return fill === undefined ? r : { ...r, artist_ko: fill };
  });
}

// --- Declarative tier pipeline (T2-2) ------------------------------------
//
// Tier A (hard per-vendor union) is handled inline in mergeRecords. The
// soft/reviewed/auto tiers B..G are described once as TIER_PIPELINE entries and
// executed by a single driver loop, so adding a tier is appending one entry.

/** Soft-match tier identifiers, in pipeline order. */
type TierName = 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/**
 * Which soft tier (if any) formed a cluster, plus the tier-specific cluster key
 * for the reviewed/auto tiers (E/F/G). B/C/D carry `null` — their soft key is
 * derived from cluster content at merge time. Replaces the former 10 positional
 * boolean+key arguments to `mergeCluster`.
 */
interface ClusterTier {
  name: TierName;
  clusterKey: string | null;
}

/**
 * One planned union: the record indexes to union, and the cluster key to
 * associate with the resulting root (`null` when the tier derives its soft key
 * from cluster content rather than from the plan).
 */
interface PlannedUnion {
  idxs: number[];
  clusterKey: string | null;
}

interface TierContext {
  records: SongRecord[];
  uf: UnionFind;
  /** Cluster sizes snapshotted immediately before this tier runs. */
  sizeByRoot: Map<number, number>;
  conflicts: MergeConflict[];
}

interface TierDescriptor {
  name: TierName;
  /**
   * Decide this tier's unions against the current UF snapshot, applying the
   * tier's own gates. May emit blocked-conflict rows (Tier D). Returns the
   * groups to union; the driver performs the unions and records membership.
   */
  plan: (ctx: TierContext) => PlannedUnion[];
  /** Resolve the soft cluster key for a cluster this tier formed. */
  softKey: (cluster: SongRecord[], clusterKey: string | null) => string | null;
  /**
   * When true, a `null` from `softKey` means "not applicable — fall through to
   * a lower-priority tier" (mirrors the `&& key !== null` guards the former
   * ternary applied to the reviewed/auto tiers). When false the (possibly null)
   * `softKey` result is this tier's final answer.
   */
  softKeyFallThroughOnNull: boolean;
  /** Emit this tier's soft-merge marker conflict (one per formed cluster). */
  marker?: (
    conflicts: MergeConflict[],
    cluster: SongRecord[],
    mergedId: string,
    softKey: string | null,
  ) => void;
}

/** Wrap a `collect*` group map as plans that carry each group's cluster key. */
function plannedFromGroups(groups: Map<string, number[]>): PlannedUnion[] {
  const plans: PlannedUnion[] = [];
  for (const [clusterKey, idxs] of groups) plans.push({ idxs, clusterKey });
  return plans;
}

function planTierB(ctx: TierContext): PlannedUnion[] {
  const { records, uf, sizeByRoot } = ctx;
  const groups = groupSingletonsByKey(records, uf, sizeByRoot, tierBKey);
  const plans: PlannedUnion[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Dash-fold cross-source gate: a group brought together only BY the fold
    // (≥ 2 distinct unfolded keys) unions unconditionally only when ≥ 2 source
    // slugs are present; otherwise its unfolded-key partitions union
    // independently (pre-fold behavior). See the mergeRecords docblock.
    const partitions = new Map<string, number[]>();
    for (const i of idxs) {
      // biome-ignore lint/style/noNonNullAssertion: i in bounds
      addToIndex(partitions, tierBKeyUnfolded(records[i]!), i);
    }
    const unionable: Iterable<number[]> =
      partitions.size === 1 || hasMultipleSourceSlugs(records, idxs) ? [idxs] : partitions.values();
    for (const group of unionable) plans.push({ idxs: group, clusterKey: null });
  }
  return plans;
}

function planTierC(ctx: TierContext): PlannedUnion[] {
  const { records, uf, sizeByRoot } = ctx;
  const groups = groupSingletonsByKey(records, uf, sizeByRoot, tierCKey);
  const plans: PlannedUnion[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Cross-source gate (preserves the BTS-IDOL guard).
    if (!shouldUnionTierCGroup(records, idxs)) continue;
    plans.push({ idxs, clusterKey: null });
  }
  return plans;
}

function planTierD(ctx: TierContext): PlannedUnion[] {
  const { records, uf, sizeByRoot, conflicts } = ctx;
  const groups = groupSingletonsByKey(records, uf, sizeByRoot, tierDKey);
  const plans: PlannedUnion[] = [];
  for (const [clusterKey, idxs] of groups) {
    if (idxs.length < 2) continue;
    if (!shouldUnionTierDGroup(records, idxs)) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const cluster = idxs.map((i) => records[i]!);
    if (collectVendorNumberConflicts(cluster).length > 0) {
      // Blocked group: stays split, emit vendor-number conflicts for review.
      recordTierDBlockedConflicts(conflicts, clusterKey, cluster);
      continue;
    }
    plans.push({ idxs, clusterKey: null });
  }
  return plans;
}

const TIER_PIPELINE: readonly TierDescriptor[] = [
  {
    name: 'B',
    plan: planTierB,
    softKey: (cluster) => tierBKey(cluster[0] as SongRecord),
    softKeyFallThroughOnNull: false,
  },
  {
    name: 'C',
    plan: planTierC,
    softKey: (cluster) => tierBKey(cluster[0] as SongRecord),
    softKeyFallThroughOnNull: false,
    marker: (conflicts, cluster, id, softKey) =>
      recordTierCConflict(conflicts, cluster, id, softKey),
  },
  {
    name: 'D',
    plan: planTierD,
    softKey: (cluster) => tierDKey(cluster[0] as SongRecord),
    softKeyFallThroughOnNull: false,
    marker: (conflicts, cluster, id, softKey) =>
      recordTierDConflict(conflicts, cluster, id, softKey ?? ''),
  },
  {
    name: 'E',
    plan: (ctx) =>
      plannedFromGroups(collectTierEReviewedStrongGroups(ctx.records, ctx.uf, ctx.sizeByRoot)),
    softKey: (_cluster, clusterKey) => clusterKey,
    softKeyFallThroughOnNull: true,
    marker: (conflicts, cluster, id, softKey) =>
      recordTierEConflict(conflicts, cluster, id, softKey ?? ''),
  },
  {
    name: 'F',
    plan: (ctx) =>
      plannedFromGroups(collectTierFPostcrawlReviewedGroups(ctx.records, ctx.uf, ctx.sizeByRoot)),
    softKey: (_cluster, clusterKey) => clusterKey,
    softKeyFallThroughOnNull: true,
    marker: (conflicts, cluster, id, softKey) =>
      recordTierFConflict(conflicts, cluster, id, softKey ?? ''),
  },
  {
    name: 'G',
    plan: (ctx) =>
      plannedFromGroups(collectTierGAutoResidualGroups(ctx.records, ctx.uf, ctx.sizeByRoot)),
    softKey: (_cluster, clusterKey) => clusterKey,
    softKeyFallThroughOnNull: true,
    marker: (conflicts, cluster, id, softKey) =>
      recordTierGConflict(conflicts, cluster, id, softKey ?? ''),
  },
];

const TIER_BY_NAME: Record<TierName, TierDescriptor> = Object.fromEntries(
  TIER_PIPELINE.map((tier) => [tier.name, tier]),
) as Record<TierName, TierDescriptor>;

/**
 * Soft-key resolution priority (highest first): G > F > E > D > C > B. Because
 * later tiers only union records that were still singletons, each formed
 * cluster belongs to exactly one tier, so this walk resolves the one member
 * tier's key — reproducing the former nested ternary (including its
 * fall-through-to-null on a reviewed/auto tier that lacks a key).
 */
const SOFT_KEY_ORDER: readonly TierName[] = ['G', 'F', 'E', 'D', 'C', 'B'];

function resolveSoftClusterKey(
  cluster: SongRecord[],
  tier: ClusterTier | undefined,
): string | null {
  if (tier === undefined) return null;
  for (const name of SOFT_KEY_ORDER) {
    if (name !== tier.name) continue;
    const desc = TIER_BY_NAME[name];
    const key = desc.softKey(cluster, tier.clusterKey);
    if (desc.softKeyFallThroughOnNull && key === null) continue;
    return key;
  }
  return null;
}

function mergeCluster(
  cluster: SongRecord[],
  tier: ClusterTier | undefined,
  conflicts: MergeConflict[],
): SongRecord {
  if (cluster.length === 0) throw new Error('empty cluster');

  // Tier C/D clusters reuse Tier B's vendor-conflict reporting surface under a
  // folded soft-key shape so existing PR-body aggregation continues to work.
  const softClusterKey = resolveSoftClusterKey(cluster, tier);

  const mergedArtistPrimary =
    pickByOwnership(cluster, TITLE_ARTIST_CHAIN, (r) => r.artist_primary) ??
    cluster[0]?.artist_primary ??
    '';
  const mergedAliases = mergeArtistAliases(cluster, mergedArtistPrimary);
  // Pick the single donor record for the KO optional-field trio so that
  // title_ko_source, title_ko_confidence, and media_context_ko stay paired
  // with the record whose title_ko was selected. This preserves the schema
  // cross-field constraint (title_ko_confidence valid only when
  // title_ko_source === 'llm-translated') because both fields travel together
  // from a donor that already satisfied the constraint.
  const koDonor = pickKoDonor(cluster, KO_CHAIN);
  const merged: SongRecord = {
    id: pickByPriority(cluster, (r) => r.id),
    source_url: pickByPriority(cluster, (r) => r.source_url),
    title_primary:
      pickByOwnership(cluster, TITLE_ARTIST_CHAIN, (r) => r.title_primary) ??
      // Field is non-null in the schema; this fallback should be unreachable
      // but is kept type-safe.
      cluster[0]?.title_primary ??
      '',
    title_ko: pickByOwnership(cluster, KO_CHAIN, (r) => r.title_ko),
    artist_primary: mergedArtistPrimary,
    artist_ko: pickByOwnership(cluster, KO_CHAIN, (r) => r.artist_ko),
    // Spec 2026-05-04: union artist_aliases across the cluster, filtering out
    // any alias that equals the merged canonical (defense-in-depth — the
    // resolver already excludes this case, but a Tier C cluster could pick a
    // non-resolver-emitted canonical via `pickByOwnership`).
    ...(mergedAliases !== undefined ? { artist_aliases: mergedAliases } : {}),
    karaoke_numbers: mergeKaraokeNumbers(cluster, softClusterKey, conflicts),
    crawled_at: latestCrawledAt(cluster),
    ...optionalKoFields(koDonor),
  };

  // Emit the forming tier's soft-merge marker (one per cluster). Tier B has no
  // marker; its disagreements surface via mergeKaraokeNumbers above.
  if (tier) TIER_BY_NAME[tier.name].marker?.(conflicts, cluster, merged.id, softClusterKey);

  return merged;
}

// --- Public API ----------------------------------------------------------

/**
 * Seven-tier dedup + per-field-ownership merge.
 *
 *   Tier A (hard match): per-vendor union-find. Records sharing a non-null
 *   value on the same vendor field (`karaoke_numbers.tj` / `.ky` /
 *   `.joysound`) are unioned. Per-vendor — TJ #100 and KY #100 are unrelated.
 *
 *   Tier B (soft match): records still in singleton clusters after Tier A
 *   are grouped by the FOLDED key
 *   `clusterKeyPart(title_primary) + "|" + clusterKeyPart(artist_primary)`
 *   (`normalize()` + dash/long-vowel fold) and unioned. Groups brought
 *   together BY the fold (≥ 2 distinct unfolded keys) additionally require
 *   ≥ 2 distinct source slugs — same-source dash-variant twins stay split
 *   (see the gate comment in the implementation). Records with no peer
 *   remain standalone.
 *
 *   Tier C (cross-source primary-token match): residual singletons after
 *   Tier B are grouped by the folded key
 *   `clusterKeyPart(title) | foldDashes(getLeadComponent(artist))`
 *   — the latter strips collab/feat. decoration so e.g. `椎名もた(Feat.鏡音リン)`
 *   matches `椎名もた｜ぽわぽわP`. A Tier C cluster fires ONLY when ≥ 2 distinct
 *   source prefixes are represented (cross-source case). Same-source clusters
 *   never union: this preserves the BTS-IDOL guard (`tj-98374 IDOL/방탄소년단`
 *   vs `tj-98392 IDOL/방탄소년단(Feat.Nicki Minaj)` are distinct releases that
 *   share a primary token). Each fired cluster emits a
 *   `MergeConflict { field: 'tier_c_merge' }` for crawl-PR-body visibility
 *   (sunset cadence per design doc §3.C).
 *
 *   Tier D (guarded context-suffix title match): residual singletons after
 *   Tier C are grouped by
 *   `clusterKeyPart(refinedStripContext(title)) | clusterKeyPart(full artist)`.
 *   This catches TJ-style trailing work-role parentheticals such as
 *   `(化物語 OP)` / `('プロセカ' OST)` when JOYSOUND has the bare title. It
 *   fires only cross-source, only when at least one title actually stripped,
 *   preserves version/size/remix/etc. suffixes, and blocks auto-union when the
 *   candidate group has multiple non-null values for the same vendor field.
 *   Successful groups emit `tier_d_context_title_merge`; blocked groups stay
 *   split and emit ordinary vendor-number conflicts for review.
 *
 *   Tier E (reviewed strong artist-credit pairs): residual singletons after
 *   Tier D are joined only when their TJ/JOYSOUND numbers match the exact
 *   65-pair raw-reviewed allowlist. This intentionally avoids a broad
 *   artist-containment rule because raw tieup/credit fields are not retained
 *   in `SongRecord`; reviewed-but-not-strong and multi-variant cases stay
 *   split. Successful groups emit `tier_e_artist_credit_merge`.
 *
 *   Tier F (post-crawl reviewed residual split pairs): residual singletons after
 *   Tier E are joined only when their TJ/KY and JOYSOUND numbers match the
 *   exact 2026-06-15 broad-audit `proposed_strong` allowlist after additional
 *   recomputed safety filters. This captures same-song single-provider splits
 *   without broadening title-only, fuzzy, reverse-containment, or multi-candidate
 *   queues. Successful groups emit `tier_f_postcrawl_split_merge`.
 *
 *   Tier G (automatic residual rule pairs): residual singletons after Tier F
 *   are joined only when a TJ/KY-only target and a JOY-only candidate have a
 *   one-to-one normalized title key and strong artist evidence: exact artist,
 *   target artist contained in the JOYSOUND expanded credit, or a guarded
 *   simple-surface `artist_ko` bridge. The title key folds observed old/new
 *   kanji variants, safe context suffixes, and JOYSOUND display decorations,
 *   but deliberately does NOT strip reading-only, version/remix/mix, `+`, or
 *   edit/single suffixes. Title-only, medium-token, reverse-containment,
 *   provider-conflict, multi-candidate, short numeric artist, and JOY-side
 *   extra-provider cases remain split. Successful groups emit
 *   `tier_g_auto_residual_merge`.
 *
 *   Per-cluster ownership: each output field is taken from the
 *   highest-priority contributing source per the spec's per-field table.
 *   See `mergeCluster` for the chains.
 *
 * Determinism: cluster output is sorted by
 *   1) `karaoke_numbers.tj` ascending — null TJ records sort last (explicit
 *      null-handling, see Fix A.1 in the sort comparator below).
 *   2) `normalize(title_primary)` ascending — locale-stable string compare.
 *   3) `id` ascending.
 *
 * Conflict warnings (Tier B vendor-number disagreements + Tier C/D/E/F/G cluster
 * fires + Tier D blocked vendor-number disagreements) are returned in
 * `result.conflicts`. Console output is forbidden — callers aggregate them.
 */
export function mergeRecords(records: SongRecord[]): MergeResult {
  const conflicts: MergeConflict[] = [];
  const n = records.length;
  if (n === 0) return { records: [], conflicts };

  const uf = new UnionFind(n);

  // --- Tier A: per-vendor union-find ---
  // Three separate index maps. TJ and KY values that happen to match
  // numerically must NOT cluster.
  const vendorIndexes = buildVendorIndexes(records);
  unionIndexedDuplicates(
    uf,
    VENDORS.map((vendor) => vendorIndexes[vendor]),
  );

  // --- Tiers B..G: declarative soft/reviewed/auto pipeline ---
  // Each tier snapshots the current cluster sizes, plans its unions against that
  // snapshot (applying its own cross-source / conflict gates and emitting any
  // Tier D blocked-conflict rows), then the driver performs the unions and
  // records which tier formed each resulting root. Because later tiers only
  // touch records that are still singletons, no earlier cluster ever grows, so
  // each formed root belongs to exactly one tier — a single membership map
  // replaces the former six wasTier* root sets plus three clusterKey maps.
  //
  // `countRoots` runs once per tier here — the same six passes as the former
  // unrolled Tier B..G blocks (sizeByRoot, sizeAfterB..sizeAfterF), now a loop.
  //
  // Tier semantics (unchanged):
  //   B fuzzy title+artist with dash-fold cross-source gate; C cross-source
  //   primary-token; D guarded context-suffix title (blocked groups emit
  //   vendor-number conflicts); E/F reviewed exact-pair allowlists; G
  //   conservative automatic residual rules. See the docblock above mergeRecords
  //   and each plan* function for the full rules.
  const membershipByRoot = new Map<number, ClusterTier>();
  for (const tier of TIER_PIPELINE) {
    const sizeByRoot = countRoots(uf, n);
    const plans = tier.plan({ records, uf, sizeByRoot, conflicts });
    for (const plan of plans) {
      for (const root of unionIndexGroups(uf, [plan.idxs])) {
        membershipByRoot.set(root, { name: tier.name, clusterKey: plan.clusterKey });
      }
    }
  }

  // --- Materialize clusters ---
  const clusters = collectClusters(uf, n);

  const merged: SongRecord[] = [];
  for (const [root, idxs] of clusters) {
    // biome-ignore lint/style/noNonNullAssertion: idx in bounds
    const cluster = idxs.map((i) => records[i]!);
    merged.push(mergeCluster(cluster, membershipByRoot.get(root), conflicts));
  }

  // Cross-record artist_ko propagation (spec 2026-06-14). Runs after clusters
  // are materialized (standalone JOYSOUND rows by the same artist are NOT in
  // the same song cluster) and before the deterministic sort. Fills a missing
  // artist_ko across records sharing the full-artist identity key when donors
  // agree; never unions rows or overwrites existing values.
  const propagated = propagateArtistKo(merged);

  // Deterministic sort. See docblock above for the rule.
  //
  // Fix A.1 (2026-05-01): null-TJ tiebreak is now explicit — null records
  // sort AFTER any non-null TJ regardless of codepoint. The previous version
  // used `r.karaoke_numbers.tj ?? '￿'` (U+FFFF) as a "push to end" sentinel.
  // That worked for ASCII-digit TJ codes (the only kind in production today)
  // because no ASCII string compares larger than U+FFFF. But supplementary-
  // plane chars (codepoint > U+FFFF, e.g. `'𠀀1'`) sort LOWER than `'￿'`
  // in JS string comparison — their leading UTF-16 surrogate falls in
  // U+D800–DBFF, which is below U+FFFF. A future TJ vendor change to non-
  // ASCII codes (or a hostile fixture) would silently flip the sort. Explicit
  // null-handling removes the tripwire.
  sortMergedRecords(propagated);

  return { records: propagated, conflicts };
}
