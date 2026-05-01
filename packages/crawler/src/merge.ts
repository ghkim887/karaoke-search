import {
  type Category,
  type KaraokeNumbers,
  type SongRecord,
  applyCategoryExclusivity as applyCategoryExclusivitySet,
} from '@karaoke/schema';
import { normalize } from './normalize.js';

/**
 * Source priority (lower number = higher priority). Single source of truth
 * for tiebreaks across this file. The order `blog > namu > tj` is retained
 * from v1, but ONLY for tiebreaking on the same field — not as a global
 * merge precedence rule. Per-field ownership chains live in `mergeCluster`.
 */
const SOURCE_RANK: Record<string, number> = {
  blog: 1,
  namu: 2,
  tj: 3,
};

/**
 * Source slug derived from the `id` prefix (everything before the first `-`).
 * The schema's `id` pattern is `^[a-z0-9-]+-\d+$`, so the slug may itself
 * contain `-` only if the source convention uses it; for the v1 blog source
 * (`blog-449-0`) the slug is `blog`.
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
 * Tier C primary-artist token splitter. Returns the lead chunk of an
 * `artist_primary` string with collab / featuring / collaborator suffixes
 * stripped, then run through `normalize()`. Used by `tierCKey` to cluster
 * records whose canonical artist agrees but whose feat./collab decoration
 * differs (e.g. `椎名もた(Feat.鏡音リン)` vs `椎名もた｜ぽわぽわP` — both
 * tokenize to `normalize('椎名もた')`).
 *
 * Split delimiters (first occurrence wins):
 *   `(Feat.` / `(feat.` / `(Prod.` / `(prod.` — opening paren + collab tag
 *   `｜` — full-width vertical bar (blog adapter convention for collab)
 *   ` & ` — ampersand with surrounding whitespace
 *   `, ` — comma + space
 *   ` with ` — whitespace-bounded
 *   ` feat. ` / ` Feat. ` — whitespace-bounded
 *
 * Non-goal: this is NOT a general artist-string parser. It targets the
 * specific decoration patterns observed in TJ-direct + blog-adapter output
 * for cross-source Tier C clustering only.
 */
function primaryArtistToken(artist: string): string {
  if (!artist) return '';
  const splitRe = /\([Ff]eat\.|\([Pp]rod\.|｜|\s+&\s+|,\s|\s+with\s+|\s+[Ff]eat\.\s+/;
  const m = splitRe.exec(artist);
  const lead = m ? artist.slice(0, m.index) : artist;
  return normalize(lead.trim());
}

/**
 * Tier C cluster key — `normalize(title_primary) | primaryArtistToken(artist_primary)`.
 * Returns `null` when either field is empty after normalization, in which
 * case the record is unkeyable for Tier C and stays a singleton.
 */
function tierCKey(r: SongRecord): string | null {
  const t = normalize(r.title_primary);
  const a = primaryArtistToken(r.artist_primary);
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

/**
 * Source prefix derived from the substring of `id` before the first `-`
 * (e.g. `tj-52498` → `tj`, `blog-487-1` → `blog`, `tjpdf-12345` → `tjpdf`).
 * Used by Tier C's cross-source gate: a Tier C cluster fires only when at
 * least two distinct prefixes are represented, blocking same-source twins
 * (e.g. two TJ releases of `방탄소년단(Feat.Nicki Minaj)` vs `방탄소년단`)
 * from wrongly merging.
 */
function sourcePrefix(r: SongRecord): string {
  const dash = r.id.indexOf('-');
  return dash === -1 ? r.id : r.id.slice(0, dash);
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

// --- Union-Find ----------------------------------------------------------

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

// --- Per-field ownership ------------------------------------------------

/**
 * Pick the first non-null value found by walking `ownerOrder` source slugs
 * in priority order. Within a slug, multiple records' contributions are
 * scanned in input order; the first non-null hit wins.
 */
function pickByOwnership<T>(
  cluster: SongRecord[],
  ownerOrder: string[],
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
 *    vendor, the highest-priority source's value wins (chain blog→namu→tj).
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
  const vendors: ('tj' | 'ky' | 'joysound')[] = ['tj', 'ky', 'joysound'];
  const result: KaraokeNumbers = { tj: null, ky: null, joysound: null };

  for (const vendor of vendors) {
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

function mergeCluster(
  cluster: SongRecord[],
  wasTierB: boolean,
  wasTierC: boolean,
  conflicts: MergeConflict[],
): SongRecord {
  if (cluster.length === 0) throw new Error('empty cluster');

  const titleArtistChain = ['tj', 'blog', 'namu'];
  // `tj` is an explicit member of the Korean-fields chain (lowest priority)
  // because the TJ-direct adapter's `searchSong` translit pass (PR-1) writes
  // `title_ko` / `artist_ko`. Pre-PR-1 the field fell through `pickByOwnership`'s
  // unlisted-source fallback, which is order-dependent and silently
  // ambiguous if a future source also writes Korean fields. Listing `tj`
  // here makes the priority `blog > namu > tj` explicit.
  const koChain = ['blog', 'namu', 'tj'];

  // Tier C clusters reuse Tier B's vendor-conflict reporting under the same
  // `tierBKey` shape so existing PR-body aggregation continues to work.
  const tierBClusterKey = wasTierB || wasTierC ? tierBKey(cluster[0] as SongRecord) : null;

  // `crawled_at`: take the LATEST timestamp across the cluster (max).
  let latestCrawledAt = cluster[0]?.crawled_at ?? '';
  for (const r of cluster) {
    if (r.crawled_at > latestCrawledAt) latestCrawledAt = r.crawled_at;
  }

  const merged: SongRecord = {
    id: pickByPriority(cluster, (r) => r.id),
    source_url: pickByPriority(cluster, (r) => r.source_url),
    title_primary:
      pickByOwnership(cluster, titleArtistChain, (r) => r.title_primary) ??
      // Field is non-null in the schema; this fallback should be unreachable
      // but is kept type-safe.
      cluster[0]?.title_primary ??
      '',
    title_ko: pickByOwnership(cluster, koChain, (r) => r.title_ko),
    artist_primary:
      pickByOwnership(cluster, titleArtistChain, (r) => r.artist_primary) ??
      cluster[0]?.artist_primary ??
      '',
    artist_ko: pickByOwnership(cluster, koChain, (r) => r.artist_ko),
    karaoke_numbers: mergeKaraokeNumbers(cluster, tierBClusterKey, conflicts),
    categories: mergeCategories(cluster),
    crawled_at: latestCrawledAt,
  };

  // Tier C: emit one structured warning per cluster (NOT per record-pair) so
  // the cross-source merge surfaces in the crawl PR body. Sunset per §3.C.
  if (wasTierC) {
    const cKey = tierCKey(cluster[0] as SongRecord) ?? tierBClusterKey ?? '';
    conflicts.push({
      cluster_key: cKey,
      field: 'tier_c_merge',
      values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
      winner: merged.id,
    });
  }

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
 *   Tier B are grouped by `normalize(title) | primaryArtistToken(artist)`
 *   — the latter strips collab/feat. decoration so e.g. `椎名もた(Feat.鏡音リン)`
 *   matches `椎名もた｜ぽわぽわP`. A Tier C cluster fires ONLY when ≥ 2
 *   distinct source prefixes are represented (gate against same-source
 *   twin-release false positives). Each fired cluster emits a
 *   `MergeConflict { field: 'tier_c_merge' }` for crawl-PR-body visibility
 *   (sunset cadence per design doc §3.C).
 *
 *   Per-cluster ownership: each output field is taken from the
 *   highest-priority contributing source per the spec's per-field table.
 *   See `mergeCluster` for the chains.
 *
 * Determinism: cluster output is sorted by
 *   1) `karaoke_numbers.tj ?? '￿'` ascending — TJ-less records go last.
 *   2) `normalize(title_primary)` ascending — locale-stable string compare.
 *   3) `id` ascending.
 * The U+FFFF sentinel is the highest BMP code point, larger than any TJ#
 * (which are ASCII digits), so null-tj records reliably sort to the end.
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
  const tjIndex = new Map<string, number[]>();
  const kyIndex = new Map<string, number[]>();
  const joyIndex = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const r = records[i]!;
    if (r.karaoke_numbers.tj !== null) {
      const arr = tjIndex.get(r.karaoke_numbers.tj);
      if (arr) arr.push(i);
      else tjIndex.set(r.karaoke_numbers.tj, [i]);
    }
    if (r.karaoke_numbers.ky !== null) {
      const arr = kyIndex.get(r.karaoke_numbers.ky);
      if (arr) arr.push(i);
      else kyIndex.set(r.karaoke_numbers.ky, [i]);
    }
    if (r.karaoke_numbers.joysound !== null) {
      const arr = joyIndex.get(r.karaoke_numbers.joysound);
      if (arr) arr.push(i);
      else joyIndex.set(r.karaoke_numbers.joysound, [i]);
    }
  }

  for (const indexes of [tjIndex, kyIndex, joyIndex]) {
    for (const idxs of indexes.values()) {
      if (idxs.length < 2) continue;
      // biome-ignore lint/style/noNonNullAssertion: length >= 2
      const first = idxs[0]!;
      for (let k = 1; k < idxs.length; k++) {
        // biome-ignore lint/style/noNonNullAssertion: k in bounds
        uf.union(first, idxs[k]!);
      }
    }
  }

  // --- Tier B: fallback for records still in singleton clusters ---
  // A record is "still alone" iff its UF root only points to itself among
  // the input set. Compute cluster sizes first, then group singletons by
  // tierBKey and union them.
  const sizeByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }

  const tierBGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = tierBKey(records[i]!);
    const arr = tierBGroups.get(key);
    if (arr) arr.push(i);
    else tierBGroups.set(key, [i]);
  }

  // Track which roots were formed via Tier B so we can scope conflict
  // detection to those clusters only.
  const tierBRoots = new Set<number>();
  for (const idxs of tierBGroups.values()) {
    if (idxs.length < 2) continue;
    // biome-ignore lint/style/noNonNullAssertion: length >= 2
    const first = idxs[0]!;
    for (let k = 1; k < idxs.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: k in bounds
      uf.union(first, idxs[k]!);
    }
    tierBRoots.add(uf.find(first));
  }

  // --- Tier C: cross-source residual-singleton clustering ---
  // After Tier B, recompute cluster sizes; records still in singletons go
  // through Tier C's `tierCKey` grouping. Gate on cross-source membership
  // (≥ 2 distinct source prefixes) — without the gate, two same-source
  // records like `tj-98374 IDOL/방탄소년단` and `tj-98392 IDOL/방탄소년단(Feat.Nicki Minaj)`
  // would wrongly merge.
  const sizeAfterB = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    sizeAfterB.set(root, (sizeAfterB.get(root) ?? 0) + 1);
  }

  const tierCGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (sizeAfterB.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = tierCKey(records[i]!);
    if (key === null) continue;
    const arr = tierCGroups.get(key);
    if (arr) arr.push(i);
    else tierCGroups.set(key, [i]);
  }

  const tierCRoots = new Set<number>();
  for (const idxs of tierCGroups.values()) {
    if (idxs.length < 2) continue;
    // Cross-source gate: skip clusters where every member shares one prefix.
    const prefixes = new Set<string>();
    for (const i of idxs) {
      // biome-ignore lint/style/noNonNullAssertion: i in bounds
      prefixes.add(sourcePrefix(records[i]!));
    }
    if (prefixes.size < 2) continue;
    // biome-ignore lint/style/noNonNullAssertion: length >= 2
    const first = idxs[0]!;
    for (let k = 1; k < idxs.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: k in bounds
      uf.union(first, idxs[k]!);
    }
    tierCRoots.add(uf.find(first));
  }

  // --- Materialize clusters ---
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const arr = clusters.get(root);
    if (arr) arr.push(i);
    else clusters.set(root, [i]);
  }

  const merged: SongRecord[] = [];
  for (const [root, idxs] of clusters) {
    // biome-ignore lint/style/noNonNullAssertion: idx in bounds
    const cluster = idxs.map((i) => records[i]!);
    const wasTierB = tierBRoots.has(root);
    const wasTierC = tierCRoots.has(root);
    merged.push(mergeCluster(cluster, wasTierB, wasTierC, conflicts));
  }

  // Deterministic sort. See docblock above for the rule.
  merged.sort((a, b) => {
    const at = a.karaoke_numbers.tj ?? '￿';
    const bt = b.karaoke_numbers.tj ?? '￿';
    if (at < bt) return -1;
    if (at > bt) return 1;
    const an = normalize(a.title_primary);
    const bn = normalize(b.title_primary);
    if (an < bn) return -1;
    if (an > bn) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return { records: merged, conflicts };
}
