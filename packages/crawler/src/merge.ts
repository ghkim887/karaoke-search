import { applyCategoryExclusivity as applyCategoryExclusivitySet } from '@karaoke/category-rules';
import type { Category, KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { getLeadComponent } from './clustering.js';
import { normalize } from './normalize.js';

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
 *   2. Tier C cross-source gating: a Tier C cluster fires only when ≥ 2
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

/** Tier B clustering key (used for residuals after Tier A union-find). */
function tierBKey(r: SongRecord): string {
  return `${normalize(r.title_primary)}|${normalize(r.artist_primary)}`;
}

/**
 * Tier C cluster key — `normalize(title_primary) | getLeadComponent(artist_primary)`.
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
  const t = normalize(r.title_primary);
  const a = getLeadComponent(r.artist_primary);
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

/**
 * Does `artist_primary` carry a `(Feat. X)` / `(feat. X)` / `(Prod. X)` /
 * `(prod. X)` parenthetical? Uses the same inner-paren shape as `FEAT_PAREN_RE`
 * in `clustering.ts` (outer `\s*` dropped because
 * `.test()` doesn't need anchoring) so the merger's feat-asymmetry detection
 * is consistent with the parser's collab-component splitter.
 *
 * Used by the Tier C cross-source gate's feat-asymmetry exception (Bug 3 fix
 * 2026-05-03): same-source clusters where EXACTLY ONE member has a feat-paren
 * and the others do NOT are admitted, since the same source publishing the
 * same song with-and-without a feat. credit is the 40mP-class duplicate
 * pattern. The BTS-IDOL guard is preserved because both BTS-IDOL records
 * share the same feat-decoration state (both with, or both without) — the
 * asymmetry condition fails.
 */
function hasFeatParen(artist: string): boolean {
  return /\(\s*(?:feat|prod)\.\s*[^()]+?\)/i.test(artist);
}

/**
 * Structured warning emitted when records cluster via Tier B (fuzzy
 * title+artist) AND disagree on a vendor field neither side used as the
 * clustering key. The merger does NOT abort — highest-priority source wins
 * per the ownership table — but the warning is surfaced for the crawl PR
 * body summary.
 *
 * The `'tier_c_merge'` field value documents a cross-source Tier C merge
 * (one conflict emitted per cluster, not per record-pair) so the merge
 * surfaces in the crawl PR body for review. Sunset cadence per
 * `2026-05-01-kpop-leak-and-merge-fix-design.md` §3.C: 4 weeks of clean
 * cross-source output, then downgrade to a per-cluster log line.
 */
export interface MergeConflict {
  /** Tier B cluster key — `normalize(title)|normalize(artist)`. */
  cluster_key: string;
  field: 'tj' | 'ky' | 'joysound' | 'tier_c_merge';
  values: { source: string; value: string }[];
  /** The value that wins per source priority. */
  winner: string;
}

export interface MergeResult {
  records: SongRecord[];
  conflicts: MergeConflict[];
}

/**
 * Filter out `tier_c_merge` entries so the headline "merge conflicts" count
 * reported to the crawl PR body / CLI stdout reflects only true vendor-number
 * disagreements.
 *
 * Fix B.1 (2026-05-01): Tier C merges are NOT disagreements — they're
 * successful soft-merges flagged for visibility. The full conflicts list
 * (and any `sample` slice) keeps Tier C entries for forensic inspection per
 * spec §3.C; only the headline `total` is filtered. Centralised here so
 * `pipeline.ts` and `cli.ts` share one definition.
 */
export function headlineConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  return conflicts.filter((c) => c.field !== 'tier_c_merge');
}

// --- Union-Find ----------------------------------------------------------

const VENDORS = ['tj', 'ky', 'joysound'] as const satisfies readonly (keyof KaraokeNumbers)[];

type Vendor = (typeof VENDORS)[number];

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

function hasVocaloidFeatAsymmetry(records: SongRecord[], idxs: number[]): boolean {
  let withFeat = 0;
  let withoutFeat = 0;
  let allVocaloid = true;
  for (const i of idxs) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const r = records[i]!;
    if (hasFeatParen(r.artist_primary)) withFeat++;
    else withoutFeat++;
    if (!r.categories.includes('vocaloid')) allVocaloid = false;
  }
  return withFeat === 1 && withoutFeat >= 1 && allVocaloid;
}

function shouldUnionTierCGroup(records: SongRecord[], idxs: number[]): boolean {
  return hasMultipleSourceSlugs(records, idxs) || hasVocaloidFeatAsymmetry(records, idxs);
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
 * Array-flavored adapter over `applyCategoryExclusivitySet` (priority:
 * vocaloid > anime > jpop). Used by the merger's `mergeCategories` and by
 * `merge.test.ts`. The rationale for the priority is that PDF-section signal
 * (vocaloid) is more specific than blog-adapter keyword matching (anime),
 * which in turn is more specific than the catch-all `jpop`.
 *
 * Examples:
 *   ['jpop']                       -> ['jpop']      (unchanged)
 *   ['jpop', 'anime']              -> ['anime']
 *   ['jpop', 'vocaloid']           -> ['vocaloid']
 *   ['anime', 'vocaloid']          -> ['vocaloid']  (vocaloid wins)
 *   ['jpop', 'anime', 'vocaloid']  -> ['vocaloid']
 */
export function applyCategoryExclusivity(cats: Category[]): Category[] {
  const set = new Set(cats);
  applyCategoryExclusivitySet(set);
  return [...set].sort();
}

function mergeCategories(cluster: SongRecord[]): Category[] {
  const set = new Set<Category>();
  for (const r of cluster) {
    for (const c of r.categories) set.add(c);
  }
  applyCategoryExclusivitySet(set);
  return [...set].sort();
}

/**
 * Union the cluster's `artist_aliases` arrays (preserving first-seen order),
 * filter out any alias equal to the merged record's `artist_primary`, and
 * return undefined when the union is empty (the schema prefers absence over
 * `[]` for storage compactness — see `applyCategoryExclusivity` mirror in
 * §2.B of the alias-dedup spec).
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

function mergeCluster(
  cluster: SongRecord[],
  wasTierB: boolean,
  wasTierC: boolean,
  conflicts: MergeConflict[],
): SongRecord {
  if (cluster.length === 0) throw new Error('empty cluster');

  // Tier C clusters reuse Tier B's vendor-conflict reporting under the same
  // `tierBKey` shape so existing PR-body aggregation continues to work.
  const tierBClusterKey = wasTierB || wasTierC ? tierBKey(cluster[0] as SongRecord) : null;

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
    karaoke_numbers: mergeKaraokeNumbers(cluster, tierBClusterKey, conflicts),
    categories: mergeCategories(cluster),
    crawled_at: latestCrawledAt(cluster),
    ...optionalKoFields(koDonor),
  };

  if (wasTierC) recordTierCConflict(conflicts, cluster, merged.id, tierBClusterKey);

  return merged;
}

// --- Public API ----------------------------------------------------------

/**
 * Three-tier dedup + per-field-ownership merge.
 *
 *   Tier A (hard match): per-vendor union-find. Records sharing a non-null
 *   value on the same vendor field (`karaoke_numbers.tj` / `.ky` /
 *   `.joysound`) are unioned. Per-vendor — TJ #100 and KY #100 are unrelated.
 *
 *   Tier B (soft match): records still in singleton clusters after Tier A
 *   are grouped by the `normalize(title_primary) + "|" + normalize(artist_primary)`
 *   key and unioned. Records with no peer remain standalone.
 *
 *   Tier C (cross-source primary-token match): residual singletons after
 *   Tier B are grouped by `normalize(title) | getLeadComponent(artist)`
 *   — the latter strips collab/feat. decoration so e.g. `椎名もた(Feat.鏡音リン)`
 *   matches `椎名もた｜ぽわぽわP`. A Tier C cluster fires when ≥ 2 distinct
 *   source prefixes are represented (cross-source case) OR when a same-source
 *   cluster satisfies the feat-asymmetry+vocaloid exception (Bug 3 fix
 *   2026-05-03): EXACTLY ONE member has a `(Feat. X)` / `(Prod. X)` paren
 *   while the others do not, AND every member is tagged `vocaloid`. This
 *   catches the 40mP-class same-source duplicate (same Vocaloid producer
 *   track published twice — once crediting the voicebank, once without) while
 *   the `vocaloid` gate blocks BTS-IDOL (`jpop`, feat-asymmetric same-source
 *   pair that is a genuinely distinct collab release). Each fired cluster emits
 *   a `MergeConflict { field: 'tier_c_merge' }` for crawl-PR-body visibility
 *   (sunset cadence per design doc §3.C).
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
 * Conflict warnings (Tier B vendor-number disagreements + Tier C cluster
 * fires) are returned in `result.conflicts`. Console output is forbidden —
 * callers aggregate them.
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

  // --- Tier B: fallback for records still in singleton clusters ---
  // A record is "still alone" iff its UF root only points to itself among
  // the input set. Compute cluster sizes first, then group singletons by
  // tierBKey and union them.
  const sizeByRoot = countRoots(uf, n);
  const tierBGroups = groupSingletonsByKey(records, uf, sizeByRoot, tierBKey);

  // Track which roots were formed via Tier B so we can scope conflict
  // detection to those clusters only.
  const tierBRoots = unionIndexGroups(uf, tierBGroups.values());

  // --- Tier C: cross-source residual-singleton clustering ---
  // After Tier B, compute cluster sizes; records still in singletons go
  // through Tier C's `tierCKey` grouping. Gate on cross-source membership
  // (≥ 2 distinct source prefixes) — without the gate, two same-source
  // records like `tj-98374 IDOL/방탄소년단` and `tj-98392 IDOL/방탄소년단(Feat.Nicki Minaj)`
  // would wrongly merge.
  //
  // Fix A.5 (2026-05-01): size-after-B and tier-C grouping are computed in
  // a single pass. The previous version iterated the corpus 3× (size, group,
  // and a third pass during materialization); on a 26k-record corpus that
  // was 3 × O(n) where one pass would suffice. This still does TWO passes
  // because `sizeAfterB.get(root)` requires every root to be counted before
  // any singleton is filtered — so we count, then group.
  const sizeAfterB = countRoots(uf, n);
  const tierCGroups = groupSingletonsByKey(records, uf, sizeAfterB, tierCKey);
  const tierCRoots = new Set<number>();
  for (const idxs of tierCGroups.values()) {
    if (idxs.length < 2) continue;
    // Cross-source gate: clusters where ≥2 distinct source prefixes are
    // represented always admit. Same-source clusters require an additional
    // signal of duplication.
    if (!shouldUnionTierCGroup(records, idxs)) continue;
    for (const root of unionIndexGroups(uf, [idxs])) tierCRoots.add(root);
  }

  // --- Materialize clusters ---
  const clusters = collectClusters(uf, n);

  const merged: SongRecord[] = [];
  for (const [root, idxs] of clusters) {
    // biome-ignore lint/style/noNonNullAssertion: idx in bounds
    const cluster = idxs.map((i) => records[i]!);
    const wasTierB = tierBRoots.has(root);
    const wasTierC = tierCRoots.has(root);
    merged.push(mergeCluster(cluster, wasTierB, wasTierC, conflicts));
  }

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
  sortMergedRecords(merged);

  return { records: merged, conflicts };
}
