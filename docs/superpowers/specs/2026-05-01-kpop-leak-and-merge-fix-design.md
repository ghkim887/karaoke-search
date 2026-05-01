# Crawler bug fixes — KPOP leak + cross-script merge

**Date:** 2026-05-01 (revised — supersedes the v1 of this file)
**Status:** design (approved direction; implementation not yet started)
**HEAD:** `01994c4`
**Author:** planner agent
**Scope:** `packages/crawler/` only — adapter contract unchanged, frontend untouched, no new data sources beyond an additional TJ chart endpoint reachable through the existing `HttpClient`.

> **Revision note.** v1 proposed a single `verdictFromVotes` threshold tightening. Two facts invalidate that framing in isolation: (a) cleanup scope is ~3-5× v1's estimate (459 Hangul + 58 kanji + 68 Latin vs. v1's 186-record sample), and (b) **every JPN-coded artist in the cache has `KOR == 0`** — nothing in the pipeline actively sources KOR votes, so the ratio rule has no data. `JPN ≥ 3` alone keeps every kanji-script Korean leaker (`防弾少年団 13/0/0`, `少女時代 12/0/0`, `東方神起 30/0/0`). v2 layers three mechanisms: hand-curated drop list (deterministic catch), active KOR-vote sweep (feeds the ratio rule), original threshold rule (autoscaling backstop). Bug 2 adds a cross-source constraint to Tier C after measuring 6 same-source false-positive vs 3 cross-source true-win clusters.

---

## 1. Goal + non-goals

Two independent crawler defects are leaking dirty data into the v2 corpus:

1. **KPOP leak.** Cleanup surface **750-900 records** (vs. v1's 277-record 25%-sample). Detection across strategies:
   - **459 Hangul-script** `artist_primary` records (48 distinct artists; dominated by `방탄소년단` 145, `박효신` 88, `AKMU(악뮤)` 62, `IVE(아이브)` 53, `램프` 39).
   - **~58 kanji-script** confirmed leakers: `防弾少年団` (13), `少女時代` (12), `東方神起` (33) — all coded `JPN` with **0 KOR votes** today, admitted via path-1.
   - **~68 Latin-script** KPOP-pattern matches (after stripping LiSA, SEKAI NO OWARI, Roselia, NiziU, Kai, MIMiNARI, FictionJunction YUUKA — legitimately Japanese).
   - **Pure-kanji long tail** (~7,118 records, 738 distinct artists) is mostly legitimate JP (中森明菜, 斉藤和義, 椎名林檎). Not exhaustively curated; drop list only enumerates known-Korean kanji-named groups.
   - **Collateral collabs** (145 BTS records admitted via Japanese MAX duo's JPN tag through `splitArtistCollab`) are bundled into the 750-900 once the lead-component fix lands.

   Root cause is layered: (a) `classifyRecord` (`parser.ts:204-209`) admits when **any** collab component is JPN-tagged with no negative-signal check; (b) `verdictFromVotes` (`enrichArtistMap.ts:196-208`) is `JPN ≥ 1 ∧ KOR == 0` but **nothing actively sources KOR votes** — the per-artist `searchSong?strType=2` scan only runs on artists harvested from JP-tagged catalog rows, so Korean groups never enter it; (c) cache cross-pollination — the same group has multiple normalized keys (`BTS` UNKNOWN 0/0/0, `방탄소년단` JPN 3/0/0 via JPOP-chart bootstrap, `防弾少年団` JPN 13/0/0). Each script form must be enumerated independently.

2. **Cross-script merge failure.** `tj-52498` (`少女A` / `椎名もた(Feat.鏡音リン)` / TJ#52498) and `blog-487-1` (`少女A` / `椎名もた｜ぽわぽわP` / Joysound#672848) are the same song kept separate — Tier A finds no shared vendor; Tier B's `normalize(title)|normalize(artist)` (`merge.ts:37-39`) sees the artist halves disagree. Corpus-wide: **9 Tier C candidates where Tier B failed — 3 cross-source true positives, 6 same-source false positives** (mostly distinct catalog releases).

**Non-goals.**
- Do **not** redesign the adapter contract or per-field ownership chains in `merge.ts`.
- Do **not** add a NEW data source (NamuWiki path is cancelled per CLAUDE.md). The KPOP-chart sweep added in 2.F reuses the existing TJ `/legacy/api/topAndHot100` endpoint already wired up by `bootstrapCharts.ts` — same host, same `HostConfig` rate limit, same `HttpClient`. It is not a new source; it is a second filter on an existing one.
- Do **not** touch `apps/web/` — the frontend renders whatever the merger emits.
- Do **not** touch `scripts/ingest-anisong-pdf.py` — its `applyCategoryExclusivity` call is correct.
- Do **not** chase cross-script title bridging (e.g. JP `少女A` ↔ KO `소녀A` for the same song attributed in different scripts). Of the 583 cross-script-title cases observed, the vast majority are different-artist false-merge candidates; the residual real cases (≤ a handful) need translit-aware Tier D (using `title_ko` / `artist_ko`) which is explicitly future work.

---

## 2. Bug 1 fix design — drop list + threshold rule + KOR-vote sourcing

The original spec framed this as a single threshold fix. The revised design is layered: **deterministic drop list (2.E) catches the top-20 known leakers regardless of vote tally** → **active KOR-vote sourcing (2.F) gives the ratio rule data to operate on** → **threshold rule (2.A) is the autoscaling backstop for everything else** → **collab-split lead-component fix (2.B) and per-`pro` KOR-reject (2.C) close the remaining admit paths**.

### 2.A — Per-artist JPN vote threshold

Retained from v1. The threshold rule alone can't do the job today (zero of 1,532 JPN-coded artists have any KOR vote — empirically verified), but once 2.F seeds KOR votes the rule does meaningful work.

**Decision.** Adopt **`JPN ≥ 3 AND JPN/(JPN+KOR) ≥ 0.7`** for `verdictFromVotes` (`enrichArtistMap.ts:196-208`) to set code `'JPN'`. Below either bar → `'AMBIGUOUS'`.

Vote-distribution histogram across all 1,532 currently `JPN`-coded artists:

```
JPN=1 KOR=0 -> 818  JPN=4 KOR=0 ->  77
JPN=2 KOR=0 -> 224  JPN=5 KOR=0 ->  55
JPN=3 KOR=0 -> 144  JPN>=6 KOR=0 -> 214
```

`JPN ≥ 3` demotes 1,042 of 1,532 (68%) to AMBIGUOUS purely on threshold. **EXO-CBX** (`3/0/0`) survives the threshold on ratio 1.0 — but the drop list catches it deterministically. **Red Velvet** (`3/0/0`), **BIGBANG** (`9/0/0`), **Stray Kids** (`3/0/0`), **방탄소년단** (`3/0/0`), **防弾少年団** (`13/0/0`), **少女時代** (`12/0/0`), **東方神起** (`30/0/0`), **박효신** (`4/0/0`) — all on the drop list.

Why not `JPN ≥ 5`? Drops 1,119 artists; over-corrects on JP long-tail (visual-kei one-album bands, doujin circles, vocaloid-P solo releases) with 3-4 TJ entries.

**Blast radius after 2.A + 2.E + 2.F:** 1,042 demoted to AMBIGUOUS; per-`pro` `nationalcode === 'JPN'` rescue (path 2) catches ~90% of real-JP long-tail. Expected net cleanup: **750-900 records** (target).

### 2.B — Collab-split: any-component vs primary-component

Retained from v1. Lead-component-only admit. Specifically: change `parser.ts:204-209` from the per-component `for` loop to:

```ts
const components = splitArtistCollab(artist);
const lead = components.length >= 2 ? components[1] : components[0];
const leadKey = normalizeForMatch(lead);
if (leadKey !== '') {
  const entry = cache.artistNationalityMap[leadKey];
  if (entry?.code === 'JPN') return 'artist';
}
```

Behavior table (unchanged from v1):

| input | `splitArtistCollab` | old | new |
|---|---|---|---|
| `'MAX(Feat.SUGA of BTS)'` | `[whole, 'MAX', 'SUGA of BTS']` | JPN (MAX) → KEEP | lead='MAX' → JPN → **KEEP** |
| `'方탄소년단'` (=`방탄소년단`) | `['방탄소년단']` | JPN(3/0/0) → KEEP — leak | drop list 2.E rejects FIRST → **DROP** |
| `'宇多田ヒカル & SKY-HI'` | `[whole, '宇多田ヒカル', 'SKY-HI']` | JPN → KEEP | lead → JPN → **KEEP** |
| `'imase & なとり'` | `[whole, 'imase', 'なとり']` | KEEP | lead='imase' → JPN → **KEEP** |
| `'Charlie Puth(Feat.宇多田ヒカル)'` | `[whole, 'Charlie Puth', '宇多田ヒカル']` | JPN → KEEP | lead='Charlie Puth' → ENG → **DROP** |

The Charlie Puth case is intentionally dropped (Western lead, JP feature). Empirically the corpus has very few of these (single-digit) — acceptable.

This rule plus 2.E plus 2.C drops the **145 BTS records currently admitted via the MAX collab path** (the `MAX(Feat.SUGA of BTS)` family — but the production data shows the `방탄소년단` Hangul name on most of those records, so the drop list catches them on the lead too).

### 2.C — Negative KOR signal in `classifyRecord`

Retained from v1. Add a guard at the **top** of `classifyRecord`, before path 1:

```ts
const proEntry = cache.proEnrichmentMap[tj];
if (proEntry?.nationalcode === 'KOR') return 'drop';
```

Order: **drop list (2.E)** → KOR-reject → path 1 (artist) → path 2 (pro JPN) → path 3 (rescue) → drop.

The blog-rescue path (path 3) is overruled by an explicit KOR signal — a hand-validated blog mention can lag a TJ catalog metadata correction.

### 2.D — One-time cleanup

**Decision.** Re-run the full crawl. **Cache regeneration is REQUIRED** (differs from v1's "not required") — the existing `artistNationalityMap` has zero KOR votes anywhere; sourcing them via 2.F is the whole point. Procedure (Phase 2 in §4):

1. Manually delete `cache.bootstrappedAt` so `isBootstrapFresh()` returns false.
2. Run the full crawl. Bootstrap performs JPOP sweep + new KPOP sweep (2.F).
3. `enrichArtistMap` re-derives `verdictFromVotes` with the new threshold against the now-balanced votes.
4. Atomic-write replaces `apps/web/public/data/songs.json` and `tj-search-cache.json`.

**Cost.** First-run regen ~2-3hr (per-artist scan dominates at ~10-15k components × 500ms). Bootstrap KPOP sweep adds ~104s on top of the existing JPOP sweep. Subsequent crawls warm-cached.

**Pre-merge canary.** Before pushing, local `--limit 0` and compare `dropped` to current ~5,000 admitted. Expected drop: ~750-900. >1,200 or <500 → STOP and re-investigate.

**Rollback.** `git revert` crawl-output commit + parser/cache code commits; force manual crawl on previous SHA.

### 2.E — Drop list design

**File location.** New: `packages/crawler/src/adapters/tj-media-direct/koreanArtistDropList.ts`.

**Structure.** A single named export — a `DROP_LIST: readonly DropListEntry[]` array, where each entry enumerates ALL known surface forms of one canonical Korean act:

```ts
export interface DropListEntry {
  /** Display name for log/PR-body output. Choose the most-common Latin form. */
  canonical: string;
  /** Every observed surface form: kanji, Hangul, Latin (any case), katakana. */
  variants: readonly string[];
  /** Optional one-line note for maintainers. */
  note?: string;
}

export const DROP_LIST: readonly DropListEntry[] = [/* see seed below */];

/**
 * Pre-normalized lookup set. Built ONCE at module load via
 * `normalizeForMatch` so the parser hot path is a single Set.has() per lead.
 */
export const DROP_KEY_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const entry of DROP_LIST) {
    for (const v of entry.variants) {
      const k = normalizeForMatch(v);
      if (k !== '') set.add(k);
    }
  }
  return set;
})();
```

**Parser integration.** Update `classifyRecord` (`parser.ts:192-220`). Order:

```ts
export function classifyRecord(...): KeepVerdict {
  // 0. Drop list — deterministic catch.
  for (const component of splitArtistCollab(artist)) {
    const k = normalizeForMatch(component);
    if (k !== '' && DROP_KEY_SET.has(k)) return 'drop';
  }

  // 1. Per-pro KOR signal (2.C).
  const proEntry = cache.proEnrichmentMap[tj];
  if (proEntry?.nationalcode === 'KOR') return 'drop';

  // 2. Per-artist JPN tag (lead-component-only — 2.B).
  const components = splitArtistCollab(artist);
  const lead = components.length >= 2 ? components[1] : components[0];
  const leadKey = normalizeForMatch(lead);
  if (leadKey !== '') {
    const entry = cache.artistNationalityMap[leadKey];
    if (entry?.code === 'JPN') return 'artist';
  }

  // 3. Per-pro JPN tag.
  if (proEntry?.nationalcode === 'JPN') return 'pro';

  // 4. Blog-whitelist rescue.
  if (force?.has(tj)) return 'rescue';

  return 'drop';
}
```

The drop list runs against ALL components (not just the lead) because Korean acts appear as featured guests too (e.g. `JapaneseLead(Feat.SUGA of BTS)` should drop on `SUGA of BTS` matching, even though the lead is JPN-tagged). This is the inverse of 2.B's lead-only admit rule: admit conservatively on lead, reject permissively on any.

**Maintenance policy.** Review every 3 months OR when new Korean acts enter JP market. Owner: `packages/crawler` maintainer (add CLAUDE.md checklist line after ship). New entries require (1) confirming Korean origin, (2) enumerating all cache variants, (3) regression fixture in `parser.test.ts`. Bias toward keeping entries — removal only if the act has shifted to Japan-only career.

**Seed list (top-20 confirmed leakers, all variants verified against the live cache today).** Each canonical entry below was probed against `tj-search-cache.json`; codes/votes shown for the variants that hit.

| canonical | variants | cache hit details |
|---|---|---|
| BTS / 방탄소년단 | `방탄소년단`, `BTS`, `防弾少年団`, `정국`, `SUGA of BTS` | `방탄소년단` JPN 3/0/0; `BTS` UNKNOWN 0/0/0; `防弾少年団` JPN 13/0/0 |
| Girls' Generation / 소녀시대 | `소녀시대`, `少女時代`, `SNSD`, `Girls' Generation` | `소녀시대` KOR 0/30/0; `少女時代` JPN 12/0/0 |
| TVXQ / 동방신기 | `동방신기`, `東方神起`, `TVXQ`, `Tohoshinki` | `동방신기` KOR 0/30/0; `東方神起` JPN 30/0/0 |
| FT Island / 에프티 아일랜드 | `FT Island`, `FTISLAND`, `에프티 아일랜드`, `에프티아일랜드` | `ftisland` JPN 2/0/0 |
| EXO-CBX / 첸백시 | `EXO-CBX`, `EXO`, `엑소`, `EXO-K`, `EXO-M` | `exo-cbx` JPN 3/0/0; `EXO` KOR 0/30/0 |
| SUPER JUNIOR / 슈퍼주니어 | `SUPER JUNIOR`, `SUPERJUNIOR`, `슈퍼주니어` | `superjunior` JPN 2/0/0 |
| Red Velvet / 레드벨벳 | `Red Velvet`, `레드벨벳`, `레드 벨벳` | `redvelvet` JPN 3/0/0; `레드벨벳` KOR 0/30/0 |
| SHINee / 샤이니 | `SHINee`, `SHINEE`, `샤이니` | `SHINee` UNKNOWN 0/0/0; `샤이니` KOR 0/30/0 |
| BIGBANG / 빅뱅 | `BIGBANG`, `BIG BANG`, `빅뱅` | `bigbang` JPN 9/0/0; `빅뱅` KOR 0/30/0 |
| TWICE / 트와이스 | `TWICE`, `트와이스` | `TWICE` UNKNOWN; `트와이스` KOR 0/30/0 |
| BLACKPINK / 블랙핑크 | `BLACKPINK`, `BLACK PINK`, `블랙핑크` | `BLACKPINK` UNKNOWN; `블랙핑크` KOR 0/30/0 |
| Stray Kids / 스트레이 키즈 | `Stray Kids`, `STRAYKIDS`, `스트레이 키즈` | `straykids` JPN 3/0/0 |
| IVE / 아이브 | `IVE`, `아이브` | `IVE` UNKNOWN |
| aespa / 에스파 | `aespa`, `에스파` | `aespa` UNKNOWN |
| NewJeans | `NewJeans`, `뉴진스` | `NewJeans` AMBIGUOUS 1/26/0 |
| LE SSERAFIM / 르세라핌 | `LE SSERAFIM`, `Le Sserafim`, `르세라핌` | (4 records Latin only) |
| ENHYPEN | `ENHYPEN`, `엔하이픈` | (Latin) |
| SEVENTEEN / 세븐틴 | `SEVENTEEN`, `세븐틴` | (5 Latin records) |
| AKMU / 악동뮤지션 | `AKMU`, `AKMU(악뮤)`, `악동뮤지션` | `AKMU(악뮤)` 62 records via blog |
| 박효신 (Park Hyo Shin) | `박효신`, `Park Hyo Shin` | `박효신` JPN 4/0/0 — **88 records**, the single biggest non-group leaker |
| 램프 (Lump) | `램프`, `Lump` | `램프` 39 records |
| IU / 아이유 | `IU`, `아이유` | `IU` KOR 0/30/0; `아이유` UNKNOWN |
| IZ*ONE | `IZ*ONE`, `IZONE`, `아이즈원` | (3 Latin records) |

The seed deliberately under-shoots; it covers the verifiable top-20 with high confidence. Long-tail KPOP additions land via the maintenance review.

### 2.F — Active KOR-vote sourcing

**Goal.** Populate `cache.artistNationalityMap[*].votes.KOR` so 2.A's ratio rule has data. Today zero of 1,532 JPN-coded artists have any KOR vote.

**Primary mechanism.** Extend `bootstrapCharts.ts` with a second sweep against TJ's KPOP chart. The existing JPOP sweep calls `topAndHot100?strType=3` (`bootstrapCharts.ts:215`); the implementer MUST verify the KPOP `strType` experimentally (likely `strType=2`) and pin the value as a constant. Refactor:

```ts
const CHART_GENRES: ReadonlyArray<{ strType: string; voteAs: 'JPN' | 'KOR' }> = [
  { strType: '3', voteAs: 'JPN' },
  { strType: KPOP_STRTYPE, voteAs: 'KOR' },
];
```

`bootstrapArtistMapFromCharts` iterates `CHART_GENRES` and `applyBootstrapVotes` (`bootstrapCharts.ts:174-184`) writes into the matching `votes.KOR` / `votes.JPN` slot. CONFIDENT_THRESHOLD stays at 3.

**Fallback** if `strType` enumeration is gated: `searchSong?strType=2&nationType=KOR` with a seed list of canonical names from §2.E drop list, plus a one-shot scrape of a third-party Korean chart. Strictly weaker than the chart sweep — preferred only if primary path fails verification.

**Schema impact.** None — `ArtistNationalityEntry.votes.KOR` already exists (`cache.ts:87`).

**Cost.** First-run +~104s (mirrors JPOP sweep). Subsequent: zero incremental. Same 7-day cadence.

**Post-regen validation.** Spot-check `방탄소년단 KOR ≥ 3`, `BIGBANG` picks up KOR alongside its 9 JPN, etc. If KPOP sweep returns zero items, abort regen and re-evaluate fallback before merging parser changes.

**`bootstrappedAt` reset.** Phase 2 deletes the field so `isBootstrapFresh()` returns false; sweep runs once on next crawl, then skips for 7 days.

### 2.G — Risk analysis

**Drop-list false drops.** This is a **maintenance discipline issue, not an automatic-rule blast-radius issue** — the list is human-curated. Verification gates: (a) each new entry probed against the cache, (b) regression fixture in `parser.test.ts`. The seed list above was probed entry-by-entry; no false-flag candidates found. The risk surface is bounded by review process and shrinks as the curated set grows.

**Threshold-tightening false drops** (carried from v1):
1. JPN=1 KOR=0 (818 artists) — per-`pro` rescue catches most. **~50-100 records lost**.
2. JPN=2 KOR=0 (224 artists) — same fallback. **~30-60 records lost**.
3. Western acts with JP-only releases — path-3 blog rescue. **<10 records**.
4. JP-KR collabs with KR lead — 2.B drops these; blog rescue keeps validated cases. **<5 records**.

**Expected net cleanup:** ~750-900 records dropped. TJ-direct admit count 5,953 → ~5,150-5,200. Acceptable.

---

## 3. Bug 2 fix design — Tier C with cross-source constraint

### 3.A — Tier C vs extended Tier B

Retained from v1. **Add a Tier C** (run on residual singletons after Tier B). Same justification: smaller blast radius, no regression on the ~21k records Tier B already merges, conflict-warning code stays scoped per tier.

### 3.B — Tier C key shape + cross-source constraint

**Decision (UPDATED).** Tier C key is **`normalize(title_primary) | primaryArtistToken(artist_primary)`** AND clusters fire **only when contributing records carry different source prefixes**.

New helpers in `merge.ts` (after `tierBKey` at line 39):

```ts
function primaryArtistToken(artist: string): string {
  if (!artist) return '';
  const parts = artist.split(/\(\s*feat\.|｜|\||&|＆|,|\s+with\s+|\s*×\s*|\s+feat\./i);
  return normalize(parts[0] ?? '');
}
function tierCKey(r: SongRecord): string | null {
  const t = normalize(r.title_primary);
  const a = primaryArtistToken(r.artist_primary);
  return (!t || !a) ? null : `${t}|${a}`;
}
function sourcePrefix(r: SongRecord): string {
  const dash = r.id.indexOf('-');
  return dash === -1 ? r.id : r.id.slice(0, dash);
}
```

**Cross-source gate.** A Tier C cluster fires only when `new Set(cluster.map(sourcePrefix)).size >= 2`.

**Why.** Corpus scan via Python on `apps/web/public/data/songs.json` finds 9 Tier C residuals — 3 cross-source, 6 same-source:

**Cross-source true positives (must merge):**
- `tj-52498 少女A / 椎名もた(Feat.鏡音リン)` + `blog-487-1 少女A / 椎名もた｜ぽわぽわP` → TJ#52498 + Joysound#672848, `[vocaloid]`. **Target case.**
- `tj-68689 月光 / キタニタツヤ(Feat.はるまきごはん)` + `blog-262-57 月光 / キタニタツヤ` → merges; `[vocaloid]` wins via priority.
- `tj-68789 NIGHT DANCER (BIG Naughty Remix) / imase,BIG Naughty` + `blog-209-33 / imase` → TJ+JOY merges.

**Same-source false positives (must stay separate):**
- `tj-98374 IDOL / 방탄소년단` + `tj-98392 / 방탄소년단(Feat.Nicki Minaj)` — two distinct TJ releases (original + Nicki Minaj remix). Without the gate, Tier C would wrongly merge. (Underlying records also disappear in Bug 1 cleanup, but the gate is needed for future twin-release patterns.)
- `tj-76860 Butter / 방탄소년단` + `tj-80234 / 방탄소년단(Feat.Megan Thee Stallion)` — same shape.
- `tj-24321 Make It Right / 방탄소년단(Feat.Lauv)` + `tj-53819 / 방탄소년단` — same shape.
- `blog-429-0 太陽系デスコ / ナユタン星人(Feat.初音ミク)` + `blog-429-60 / ナユタン星人` (and `エイリアンエイリアン`, `ダンスロボットダンス` analogs) — separate blog entries with separate Joysound numbers; merging loses one.

**Accepted misses/risks:**
- `Smile / Bump of Chicken` vs `BUMP OF CHICKEN` — both `blog-`, case-folding diff blocked by gate. Case-folding is `normalize()`'s job upstream, not the merger's. **Accepted miss.**
- `月光 / キタニタツヤ` cross-source merge collapses TJ's `[jpop]` + blog's `[vocaloid]` to `[vocaloid]` via `@karaoke/schema:applyCategoryExclusivity` priority. Right outcome.

**Why NOT title-only?** `blog-539-2 少女A / 中森明菜` shares `少女A` with the 椎名もた pair but differs on `primaryArtistToken` — correctly stays separate.

**Why NOT `artist_ko`?** 60%+ of corpus records have `artist_ko === null`; the real signal is the lead JP-script token.

**Cross-script title bridging OUT OF SCOPE.** 583 candidate clusters with title-script differences are mostly different-artist false-merge risk; real cases need future Tier D using `title_ko`/`artist_ko`.

### 3.C — Conflict reporting

Retained from v1. Tier C clusters emit `MergeConflict` with `field: 'tier_c_merge'`:

```ts
export interface MergeConflict {
  cluster_key: string;
  field: 'tj' | 'ky' | 'joysound' | 'tier_c_merge';
  values: { source: string; value: string }[];
  winner: string;
}
```

Aggregated in `crawl.yml`'s PR-body composition the same way Tier B vendor conflicts are. Sunset: after 4 weeks of clean cross-source merges in PR-body output, downgrade to per-cluster log line.

### 3.D — Implementation gating order

Tier C MUST land AFTER Bug 1's cleanup baseline. Reason: the BTS / Butter / IDOL same-source cases self-resolve once Bug 1 drops them entirely; running Tier C first against the contaminated corpus increases the false-positive surface unnecessarily. Phase order in §4 enforces this.

### 3.E — Risk analysis (UPDATED scope)

| corpus survey | count |
|---|---:|
| candidate clusters (same `tierCKey`, `len ≥ 2`) | 11 |
| where Tier B already merges | 2 |
| true Tier C residuals | 9 |
| cross-source residuals | 3 |
| same-source residuals (false positives) | 6 |
| cross-script title cases (out of scope) | 583 |
| cross-script artist cases (Reol / れをる) | 1 |

**Net Tier C activity expected with cross-source gate: 3 legitimate merges, 0 false-merges.** The 1 cross-script-artist case (Reol / れをる) is accepted miss — needs `artist_ko` keying or future Tier D.

False-merge risk going forward: a new candidate would have to share BOTH the title AND the lead-artist token across cross-source records. The 3 observed true-positives are all real-same-song cases. New collisions arriving via future crawls follow the same pattern.

---

## 4. Implementation plan

**Phased order (revised — explicit per the user lock):**

- **Phase 1 — Bug 1 code.** Drop list + parser updates + KOR-vote bootstrap + threshold tightening. Single commit.
- **Phase 2 — Cache regeneration + cleanup crawl.** Manually delete `cache.bootstrappedAt`, re-run the full crawl on Windows (atomic-write replaces `apps/web/public/data/songs.json` and `tj-search-cache.json`). Single commit (data only — no code changes).
- **Phase 3 — Bug 2 code.** Tier C with cross-source constraint. Single commit. Ships only after Phase 2's cleaned baseline is in.

The user reviews and merges each commit independently.

### Phase 1 files

| File | Symbol | Change |
|---|---|---|
| `packages/crawler/src/adapters/tj-media-direct/koreanArtistDropList.ts` | NEW: `DROP_LIST`, `DROP_KEY_SET` | Seed list per §2.E. ~25 entries, all variants. Pre-normalized `Set` for O(1) lookup. |
| `packages/crawler/src/adapters/tj-media-direct/parser.ts` | `classifyRecord` (lines 192-220) | Reorder: drop list (any-component) → KOR-reject → lead-component-only artist JPN → pro JPN → rescue → drop. Per §2.E inline code block. |
| `packages/crawler/src/adapters/tj-media-direct/bootstrapCharts.ts` | new const `CHART_GENRES`, refactor `fetchChart` + `bootstrapArtistMapFromCharts` | Iterate genres (JPN/KOR), accumulate per-genre votes, write into per-vote slot in `applyBootstrapVotes`. Per §2.F. |
| `packages/crawler/src/adapters/tj-media-direct/enrichArtistMap.ts` | `verdictFromVotes` (lines 196-208) | Replace verdict logic. New rule: `JPN ≥ 3 AND JPN/(JPN+KOR) ≥ 0.7` for JPN; below either bar → AMBIGUOUS. |
| `packages/crawler/test/adapters/tj-media-direct/parser.test.ts` | new fixtures | (1) `방탄소년단` → drop (drop list, lead). (2) `JPN-Lead(Feat.SUGA of BTS)` → drop (drop list any-component). (3) `MAX(Feat.SUGA of BTS)` → drop (drop list any-component, even though MAX is JPN). (4) `imase & なとり` → keep (lead JPN). (5) `Charlie Puth(Feat.宇多田ヒカル)` → drop (lead ENG, no drop-list hit). (6) Per-pro KOR signal → drop (proEnrichmentMap[tj].nationalcode='KOR'). |
| `packages/crawler/test/adapters/tj-media-direct/enrichArtistMap.test.ts` | new fixtures | `{JPN:1,KOR:0}` → AMBIGUOUS, `{JPN:2,KOR:0}` → AMBIGUOUS, `{JPN:3,KOR:0}` → JPN, `{JPN:5,KOR:3}` → AMBIGUOUS (ratio 0.625 < 0.7), `{JPN:7,KOR:2}` → JPN (ratio 0.78), `{JPN:0,KOR:30}` → KOR. |
| `packages/crawler/test/adapters/tj-media-direct/bootstrapCharts.test.ts` | new fixtures | KPOP sweep produces KOR votes; mixed JPN/KOR genre run produces both vote slots populated; existing JPN-only entry not downgraded by KPOP-only votes (idempotency). |
| `packages/crawler/test/adapters/tj-media-direct/koreanArtistDropList.test.ts` | NEW | Seed list passes a sanity test (every variant normalizes non-empty; `DROP_KEY_SET` size matches expected count). |

### Phase 2 procedure

On Windows host with Phase 1 code committed:

1. Reset `bootstrappedAt`: `python -c "import json; p='apps/web/public/data/tj-search-cache.json'; c=json.load(open(p,encoding='utf-8')); c.pop('bootstrappedAt',None); json.dump(c,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)"`.
2. `corepack pnpm -r build && corepack pnpm --filter @karaoke/crawler start --out apps/web/public/data/songs.json --conflicts-out /tmp/conflicts.json` (manual atomic-rename if sandbox blocks).
3. Verify per §5 (KPOP leak = 0, total records 25,500-25,800).
4. Commit `songs.json` + `tj-search-cache.json` as `chore(crawler-data): rebuild after KPOP-leak fix`.

### Phase 3 files

| File | Symbol | Change |
|---|---|---|
| `packages/crawler/src/merge.ts` | new `primaryArtistToken` (after line 39) | Splits on `(Feat./｜/\|/&/＆/,/with/×/feat.`; returns `normalize(parts[0])`. |
| `packages/crawler/src/merge.ts` | new `tierCKey(r)` and `sourcePrefix(r)` | Per §3.B inline code. |
| `packages/crawler/src/merge.ts` | `mergeRecords` (lines 354-387) | After Tier B's `tierBRoots` is built, recompute residual singletons; group by `tierCKey`; gate cluster firing on `new Set(idxs.map(i => sourcePrefix(records[i]))).size >= 2`. Track `tierCRoots: Set<number>`. |
| `packages/crawler/src/merge.ts` | `MergeConflict` type (lines 47-55) | Add `'tier_c_merge'` to `field` union. |
| `packages/crawler/src/merge.ts` | `mergeCluster` (lines 236-279) | Accept `wasTierC: boolean`. When true, append a `MergeConflict { field: 'tier_c_merge', ... }` to `conflicts` after the merge result is computed. |
| `packages/crawler/test/merge.test.ts` | new cases | (1) 椎名もた `少女A` pair (cross-source) → merges with TJ#52498 + Joysound#672848 + categories `[vocaloid]`. (2) BTS IDOL pair (same-source) → stays separate (cross-source gate). (3) BTS Make It Right pair (same-source) → stays separate. (4) ナユタン星人 太陽系デスコ pair (same-source) → stays separate. (5) 中森明菜 vs 椎名もた `少女A` (cross-source but different `primaryArtistToken`) → stays separate. (6) `MergeConflict { field: 'tier_c_merge' }` emitted for every Tier C merge. |

---

## 5. Verification + rollout

### Bug 1 verification

After Phase 2, scan `songs.json` for ALL of: `防弾少年団, BTS, 방탄소년단, 少女時代, SNSD, 소녀시대, 東方神起, TVXQ, 동방신기, FT Island, FTISLAND, 에프티 아일랜드, EXO-CBX, EXO, 엑소, SUPER JUNIOR, 슈퍼주니어, AKMU, 악동뮤지션, IVE, 아이브, aespa, 에스파, NewJeans, 뉴진스, BLACKPINK, 블랙핑크, Stray Kids, SHINee, 샤이니, Red Velvet, 레드벨벳, BIGBANG, 빅뱅, TWICE, 트와이스, SEVENTEEN, 세븐틴, LE SSERAFIM, 르세라핌, ENHYPEN, IZ*ONE, 아이즈원, 박효신, Park Hyo Shin, 램프, Lump, IU, 아이유`. **Expected: 0 hits per substring** when `'jpop' in categories`.

Total-record count expected: 25,500-25,800 (was 26,480 pre-fix). Single-digit residuals tolerated only if `KeepStats.admittedByRescue` accounts for them in the crawl log AND a maintainer reviews each.

```bash
PYTHONIOENCODING=utf-8 python -c "
import json
songs = json.load(open(r'apps/web/public/data/songs.json', encoding='utf-8'))
suspects = ['防弾少年団','BTS','방탄소년단','少女時代','SNSD','소녀시대','東方神起','TVXQ','동방신기','FT Island','FTISLAND','에프티','EXO-CBX','EXO','엑소','SUPER JUNIOR','슈퍼주니어','AKMU','악동뮤지션','IVE','아이브','aespa','에스파','NewJeans','뉴진스','BLACKPINK','블랙핑크','Stray Kids','SHINee','샤이니','Red Velvet','레드벨벳','BIGBANG','빅뱅','TWICE','트와이스','SEVENTEEN','세븐틴','LE SSERAFIM','르세라핌','ENHYPEN','IZ*ONE','아이즈원','박효신','Park Hyo Shin','램프','Lump','IU','아이유']
hits = [(s, r['id'], r['artist_primary']) for r in songs if 'jpop' in r.get('categories',[]) for s in suspects if s.lower() in (r.get('artist_primary') or '').lower()]
print('KPOP leak:', len(hits), '/ total:', len(songs))
"
```

### Bug 2 verification

- **Target merge.** `[r for r in songs if r['title_primary']=='少女A' and '椎名もた' in (r['artist_primary'] or '')]` → **1 record**, `tj=52498`, `joysound=672848`, `categories=['vocaloid']`.
- **Negative target.** BTS IDOL twins (`tj-98374` + `tj-98392`) — should be dropped entirely by Bug 1; if rescued, count MUST be 2 (not 1) — gate prevents the wrong merge.

### Cache regeneration verification

`sum(1 for e in cache['artistNationalityMap'].values() if e['code']=='JPN' and e['votes']['KOR']>0)` — pre-fix: 0; post-fix: materially positive (target: ≥ 50).

### Rollout

- **No feature flag.** Both fixes are correctness-first.
- **Cache regeneration: REQUIRED.** Phase 2 explicitly resets `bootstrappedAt`. (Differs from v1's "not required.")
- **Rate-limit budget:** Phase 1's KPOP sweep adds ~104s of TJ chart calls per first-run bootstrap, governed by the existing TJ `HostConfig` (500ms base + ±100ms jitter per `packages/crawler/src/http.ts`). No CI rate-limit overage.
- **Crawl-cycle implications:** the next manual crawl run on Windows produces the cleaned corpus locally; the user pushes the resulting `songs.json` + cache update along with the code commits (matches the existing manual-crawl protocol in CLAUDE.md).

---

## 6. Open questions

Most of v1's open questions are resolved by the layered design. Remaining genuinely-open items:

1. **TJ KPOP chart `strType` value (§2.F).** Implementer must verify experimentally before coding the constant. Reasonable candidate: `strType=2` (mirroring `strType=3` for JPOP). If neither value nor any other genre enumeration works, fall back to seed-list `searchSong?strType=2&nationType=KOR` per §2.F. **Decision point during Phase 1 implementation.** Document the verified value in the bootstrapCharts.ts source.

2. **Tier C conflict warnings — sunset cadence (§3.C).** Decision: 4 weeks of clean cross-source merge warnings in PR-body output, then downgrade to per-cluster log line. Final sign-off: user.

3. **Drop list governance.** §2.E proposes 3-month review cadence and CLAUDE.md checklist line item. Final sign-off needed on cadence + ownership.

Resolved from v1:
- ~~Q1 EXO-CBX threshold escalation~~ → answered by drop list (it's on it).
- ~~Q3 path-2 artist-level non-KOR gate~~ → answered by §2.F making the threshold rule effective + §2.E catching deterministically.
