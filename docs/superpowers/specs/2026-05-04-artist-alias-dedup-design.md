# Artist alias resolution — searchable, displayed, never duplicated

**Date:** 2026-05-04
**Status:** design (approved direction; implementation not yet started)
**HEAD:** `a9a0b17`
**Author:** planner agent
**Scope:** `packages/schema/`, `packages/crawler/`, `apps/web/`, plus a one-shot migration script under `scripts/`. No new data sources. Crawler-pipeline contract preserved (`Crawler` adapters keep emitting `SongRecord`; alias resolution is a NEW pre-merge stage).

---

## 1. Goal + non-goals

The corpus carries ~840 records affected by an alias-driven dedup gap with two shapes:

1. **Pipe-form aliases.** The blog adapter emits `artist_primary` strings like `"ずっと真夜中でいいのに。｜ZUTOMAYO"`, `"40mP｜40meterP"`, `"スピッツ｜Spitz"` — full-width pipe `｜` (U+FF5C) joining a Japanese canonical name and one or more Latin/alternate aliases.
2. **Bare cross-script.** TJ-direct or feat-variant records emit only one half of the same artist identity — e.g. `"Spitz"` (9 records) vs `"スピッツ｜Spitz"` (257 records), `"40mP(Feat.初音ミク)"` vs `"40mP｜40meterP"`.

Tier B's clustering key (`merge.ts:38-40`) is `normalize(title_primary)|normalize(artist_primary)`. The two halves disagree on `normalize(artist_primary)` so Tier B never fires. Tier C's `getLeadComponent` strips collab decoration but does NOT split on `｜`, so a pipe-form `artist_primary` and a bare alias hash to different `tierCKey`s. Net effect: the corpus ships duplicate UI cards for the same song.

**User design intent (verbatim).** "can we make them present when searching and displayed on frontend to make search easier with aliases, but not considering them unique name so it does not bother with separation?"

So aliases must be:

- **(a) Searchable** — typing `"ZUTOMAYO"` finds the canonical record.
- **(b) Visible** — the result card shows `"ずっと真夜中でいいのに。 (ZUTOMAYO)"` so users with either mental model recognize the artist.
- **(c) Non-duplicating** — exactly one record per song, regardless of which alias half a source emitted.

**Non-goals.**

- Do **not** broaden the splitter to ` - ` (latin-name marker). Too many false positives on `"Artist - Subtitle"` pseudo-band names.
- Do **not** broaden to ASCII `|`. The only known ASCII-pipe band name in the corpus is `Qverktett:||`; treating ASCII `|` as a separator would break it.
- Do **not** merge across distinct artist identities. BUMP OF CHICKEN must remain 145 records; the BTS-IDOL false-positive guard from the 2026-05-01 fix must remain intact.
- Do **not** rely on `artist_ko` clustering for the alias map. `artist_ko` is unreliable in some corpus rows (KAITO under WhiteFlame, etc. — see the audit script's existing notes); it is a tiebreak signal at best.
- Do **not** add a NEW data source (no NamuWiki revival, no online alias databases). The alias map is built FROM the existing corpus.

---

## 2. Schema change

### 2.A — `SongRecord` field addition

`packages/schema/src/index.ts` adds an optional `artist_aliases` field to `SongRecord` (and to `RawSongRecord` so adapters can emit it directly if/when they have alias data):

```ts
export interface SongRecord {
  // ... existing fields unchanged ...
  /**
   * Optional alternate forms of the canonical `artist_primary`. Populated by
   * the alias-resolution stage (pre-merge) when an `artist_primary` carries
   * full-width pipe (`｜`) separators OR a bare record's value matches a
   * known alias of another canonical. NEVER used as the canonical key.
   * Empty/absent when the record has no known aliases.
   */
  artist_aliases?: string[];
}
```

**JSON Schema delta** (`songRecordSchema.properties`):

```ts
artist_aliases: {
  type: 'array',
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
  // No minItems — empty array is unusual but tolerated; absence is preferred.
},
```

`artist_aliases` is NOT added to `required`. Existing `songs.json` records without the field validate as-is. Empty arrays are tolerated but the resolver writes `undefined` (omits the field) rather than `[]` for storage compactness.

### 2.B — Invariants

The alias-resolution stage MUST guarantee, for every record it touches:

- `artist_primary` is the canonical (FIRST segment of any `｜`-split, or rewritten to a known canonical).
- `artist_aliases` contains ONLY non-empty, NFKC-trimmed strings; no duplicates within the array; does NOT contain `artist_primary` itself.
- `artist_aliases` is omitted (`undefined`) when empty, never serialized as `[]` (smaller corpus footprint).

---

## 3. Crawler / merge alias resolution

### 3.A — Pipeline placement

A new function `resolveArtistAliases(records: SongRecord[]): SongRecord[]` runs in `packages/crawler/src/pipeline.ts` between adapter collection and `mergeRecords`:

```ts
// In runPipeline, after the for-await collection loop:
const resolved = resolveArtistAliases(collected);
const { records: merged, conflicts } = mergeRecords(resolved);
```

Lives in a new sibling module `packages/crawler/src/aliases.ts` (parallel to `merge.ts`/`normalize.ts`) so it stays independently testable and the merger contract is unchanged. Exported symbols:

```ts
export interface AliasResolutionResult {
  records: SongRecord[];
  /** Diagnostics for the crawl-PR-body summary. */
  warnings: AliasConflict[];
}
export interface AliasConflict {
  alias: string;
  canonicals: string[];
  /** Number of records left untouched because of the collision. */
  affected: number;
}
export function resolveArtistAliases(records: SongRecord[]): AliasResolutionResult;
```

### 3.B — Algorithm (deterministic, single-pass per phase)

**Constants.**

```ts
const FULLWIDTH_PIPE = '｜'; // U+FF5C ONLY — not the ASCII '|' (U+007C).
const PIPE_SPLIT_RE = /｜/g;
```

**Phase 1 — Split pipe-form records and seed the alias map.**

Walk every record. For each whose `artist_primary` contains `｜`:

1. Split on `｜` (exact full-width codepoint). Trim each segment via NFKC + leading/trailing whitespace strip.
2. Discard empty segments.
3. If fewer than 2 non-empty segments survive, treat as malformed — leave the record untouched, emit a warning.
4. Otherwise: `canonical = segments[0]`; `aliases = segments.slice(1)` (deduped, preserving order).
5. Mutate the record (write a new object, do not mutate input — `SongRecord` is treated as immutable upstream): `artist_primary = canonical`, `artist_aliases = aliases.length > 0 ? aliases : undefined`.
6. For every alias `a`, populate the alias map `M: Map<string, Set<string>>` keyed by `normalize(a)` → set of `normalize(canonical)`. Cache the original canonical string in a parallel map `canonicalDisplay: Map<string, string>` so Phase 3 can rewrite `artist_primary` to the original-cased canonical (not the normalized form).

**Phase 2 — Detect alias→canonical collisions.**

For each entry `(aliasKey, canonicalSet)` in `M`:
- If `canonicalSet.size > 1` → COLLISION. Add to a `collidingKeys: Set<string>`. Build an `AliasConflict` warning with the original (un-normalized) alias surface form (any one — pick the first observed) and all canonical surface forms.
- Otherwise the alias is safe to use for re-keying.

**Phase 3 — Re-key bare records.**

Walk every record one more time. For each whose `artist_primary` does NOT contain `｜` (pipe-form records are already canonical):

1. Compute `bareKey = normalize(artist_primary)`.
2. If `bareKey` is in `M` AND `bareKey` is NOT in `collidingKeys`:
   - Look up the (singleton) canonical key, then resolve to the original-cased canonical via `canonicalDisplay`.
   - If `normalize(canonical) === bareKey` → already canonical, no rewrite. Skip.
   - Otherwise: rewrite `artist_primary = canonical`. Add the ORIGINAL bare string to `artist_aliases` (deduped, exclude if it equals the canonical).

**Phase 4 — Emit.**

Return `{ records, warnings }`. Warnings include the collision count + sampled first 5 conflicts. The pipeline forwards these to `conflictsOutPath` alongside the existing merge conflicts (extend the JSON shape with an `aliasConflicts` block).

### 3.C — Conflict policy (verbatim from intent)

**If the alias map would collide (same alias points to two different canonicals), DON'T rewrite — log a warning and leave both as-is.** Same artist genuinely can't have two canonical names, so a collision means either the upstream blog post is mistagged or two real distinct artists share a Latin alias. Either way, silent merging is wrong; the safe action is to do nothing and surface for review.

The pipe-form RECORD on each side of the collision is still split (Phase 1's mutation is unconditional — the splitting itself is correct). Only Phase 3's re-keying skips the colliding alias.

### 3.D — Why this runs BEFORE `mergeRecords`

Tier B clusters by `normalize(title_primary)|normalize(artist_primary)`. Once `artist_primary` is canonical for both the blog pipe-form record and the TJ bare record, they hash to the same Tier B key and merge naturally. **No changes to `merge.ts` are required.** The Tier C cross-source gate continues to function — bare→canonical rewrites preserve the source prefix, so a TJ bare and a blog pipe-form with the same canonical still cross-source-merge as intended.

### 3.E — Edge cases

| input | phase | behavior |
|---|---|---|
| `"ずっと真夜中でいいのに。｜ZUTOMAYO"` | 1 | canonical = `"ずっと真夜中でいいのに。"`, aliases = `["ZUTOMAYO"]` |
| `"40mP｜40meterP｜M40"` | 1 | canonical = `"40mP"`, aliases = `["40meterP", "M40"]` |
| `"｜Spitz"` (leading empty seg) | 1 | malformed — < 2 non-empty segments. Untouched + warning |
| `"Spitz｜"` (trailing empty seg) | 1 | canonical = `"Spitz"`, no aliases. Field omitted |
| `"Qverktett:||"` (ASCII `|`) | 1 | `｜` not present. NOT split |
| `"Spitz"` (bare, alias of `スピッツ｜Spitz`) | 3 | rewritten to `"スピッツ"`, alias `"Spitz"` added |
| `"40mP(Feat.初音ミク)"` (bare with feat) | 3 | `normalize` strips parens punctuation but NOT inner letters; `40mp초음미쿠` doesn't match alias key `40mp`. Phase 3 skips. **This is a known gap** — Tier C still merges via lead-component-only `getLeadComponent`. See §4 |
| `"BUMP OF CHICKEN"` | 1+3 | no `｜`; not in alias map. Untouched (preserves 145-record cluster) |
| collision: `"Aimer"` aliased from both `"Aimer (Visual Artist)｜Aimer"` and `"Aimer (Singer)｜Aimer"` | 2+3 | `normalize("Aimer")` keys to 2 canonicals → collision. Both pipe-form records keep their split; bare `"Aimer"` records left untouched + warning |

---

## 4. Tier B / Tier C interaction (no code change)

Once `artist_primary` is canonicalized:

- **Tier B** clusters via `normalize(title_primary)|normalize(artist_primary)`. The pipe-form record (`スピッツ｜Spitz` → `スピッツ`) and the bare TJ record (`Spitz` → `スピッツ` after Phase 3) now share the key. **They merge via Tier B.** No new code paths needed.
- **Tier C** uses `normalize(title) | getLeadComponent(artist)`. Records whose bare form had collab decoration (`"40mP(Feat.初音ミク)"`) are NOT re-keyed by Phase 3 (their `normalize(artist_primary)` is `40mp초음미쿠`, not in the alias map). They still depend on Tier C's lead-component extraction to merge, exactly as today. **Tier C's cross-source gate and feat-asymmetry+vocaloid exception are unchanged.**

This is the lighter scope: alias resolution handles the "exact alias half" case via Tier B; the merger's existing Tier C continues to handle the "alias half + feat. decoration" case. Touching Tier C would risk regressing the 2026-05-01 BTS-IDOL guard.

---

## 5. Frontend search index

`apps/web/src/lib/search.ts` adds `artist_aliases` to the indexed-fields list at the same boost as `artist_primary`:

```ts
const SEARCH_FIELDS = [
  'title_primary',
  'title_ko',
  'artist_primary',
  'artist_aliases', // NEW
  'artist_ko',
] as const;

const SEARCH_BOOSTS = {
  title_primary: 3,
  title_ko: 3,
  artist_primary: 2,
  artist_aliases: 2, // NEW — equal to artist_primary
  artist_ko: 2,
} as const;
```

MiniSearch's default field extractor treats array-valued fields by joining elements with a space when the field accessor returns an array. Verify with a unit test fixture: a record with `artist_aliases: ['ZUTOMAYO']` is found by querying `"ZUTOMAYO"`. (If MiniSearch's array handling proves problematic in practice, supply an `extractField` callback that returns `(record.artist_aliases ?? []).join(' ')` — fallback only.)

`null`/`undefined` field values are tolerated by MiniSearch (skip during indexing). Records without aliases need no special-casing.

---

## 6. Frontend display

`apps/web/src/components/ResultCard.tsx` renders the artist row as `Canonical (Alias1, Alias2)` when `artist_aliases` is non-empty:

```tsx
function joinArtistDisplay(primary: string, aliases: string[] | undefined): string {
  if (!aliases || aliases.length === 0) return primary;
  return `${primary} (${aliases.join(', ')})`;
}

// Inside ResultCard:
const artistPrimaryWithAliases = joinArtistDisplay(record.artist_primary, record.artist_aliases);
const artistText = joinBilingual(artistPrimaryWithAliases, record.artist_ko);
```

The bilingual joiner (`joinBilingual`) is unchanged — `artist_ko` still appears after the em-dash separator. Example outputs:

- No aliases, with `artist_ko`: `"スピッツ — 스피츠"` (today's behavior — unchanged)
- One alias, with `artist_ko`: `"スピッツ (Spitz) — 스피츠"`
- Multiple aliases, no `artist_ko`: `"40mP (40meterP, M40)"`
- No aliases, no `artist_ko`: `"BUMP OF CHICKEN"` (unchanged)

**Layout / responsive.** The artist row already wraps via the `.result-artist` style; aliases extend the string and may push to a second line on slim viewports. No new CSS rules required (verify on mobile in QA — if overflow becomes an issue, fall back to `text-overflow: ellipsis` on `.result-artist` only, gated behind UX sign-off per the existing chip-row precedent in CLAUDE.md).

---

## 7. Tests

### 7.A — `packages/crawler/test/aliases.test.ts` (NEW)

| case | expected |
|---|---|
| Pipe-form `"X｜Y｜Z"` | `artist_primary = "X"`, `artist_aliases = ["Y", "Z"]` |
| Pipe-form `"X｜"` (trailing empty) | `artist_primary = "X"`, no aliases (field omitted) |
| Pipe-form `"｜Y"` (leading empty) | UNCHANGED record + warning emitted |
| Pipe-form `"｜"` (only delimiter) | UNCHANGED record + warning |
| Bare `"Spitz"` matching alias from `"スピッツ｜Spitz"` corpus seed | rewritten to `"スピッツ"`, `artist_aliases = ["Spitz"]` |
| Bare `"Random"` not matching any alias | UNCHANGED |
| Bare `"スピッツ"` matching its own canonical (no rewrite needed) | UNCHANGED — `bareKey === canonicalKey` skip path |
| Collision: `"Y"` aliased from both `"X1｜Y"` and `"X2｜Y"` | both pipe-form records split as normal; bare `"Y"` records UNCHANGED + warning enumerates `["X1", "X2"]` |
| ASCII `"Qverktett:||"` (no full-width pipe) | UNCHANGED, no split, no warning |
| Pipe-form duplicate aliases `"X｜Y｜Y"` | `artist_aliases = ["Y"]` (deduped) |
| Whitespace inside segments `"  X  ｜  Y  "` | NFKC trim; `artist_primary = "X"`, alias `"Y"` |

### 7.B — `packages/crawler/test/pipeline.test.ts` (extend)

| case | expected |
|---|---|
| Pipe-form blog record + bare TJ record (same title, same canonical) → Tier B merges them after alias resolution | single output record with both vendors' karaoke numbers |
| Same as above but the canonical has a `｜` collision elsewhere in the corpus → bare TJ record stays separate | two output records (alias re-key blocked by collision) |
| `aliasConflicts` summary written to `conflictsOutPath` | JSON shape includes `{ aliasConflicts: { total, sample } }` |

### 7.C — `packages/schema/test/index.test.ts` (extend)

| case | expected |
|---|---|
| `SongRecord` with `artist_aliases: ['Spitz']` | validates |
| `SongRecord` without `artist_aliases` | validates (optional field) |
| `SongRecord` with `artist_aliases: []` | validates (tolerated) |
| `SongRecord` with `artist_aliases: ['', 'X']` | REJECTS (`minLength: 1`) |
| `SongRecord` with `artist_aliases: ['X', 'X']` | REJECTS (`uniqueItems: true`) |

### 7.D — `apps/web/src/lib/search.test.ts` (extend)

| case | expected |
|---|---|
| Search `"ZUTOMAYO"` against record `{artist_primary: "ずっと真夜中でいいのに。", artist_aliases: ["ZUTOMAYO"]}` | record found |
| Search `"ずっと"` against same record | record found (unchanged behavior) |
| Search `"40meterP"` against `{artist_primary: "40mP", artist_aliases: ["40meterP"]}` | record found |
| Search `"Spitz"` against `{artist_primary: "BUMP OF CHICKEN"}` (no aliases) | record NOT found |

### 7.E — `apps/web/src/components/ResultCard.test.tsx` (extend)

| case | expected |
|---|---|
| Render with `artist_aliases: ["Spitz"]` and `artist_ko: "스피츠"` | DOM contains `"スピッツ (Spitz) — 스피츠"` |
| Render with empty `artist_aliases` | DOM contains `"スピッツ — 스피츠"` (unchanged) |
| Render with no `artist_aliases` field | DOM contains canonical only — no parens |
| Render with multiple aliases | parens join with `", "` separator |

### 7.F — Migration script tests (`scripts/test_resolve_aliases.py`, mirrors `test_retag_blog_vocaloid_mistags.py` pattern)

| case | expected |
|---|---|
| 3-record synthetic corpus (pipe-form + bare match + bare no-match) | 1st split, 2nd rewritten, 3rd unchanged |
| Collision case (3 records: 2 pipe-forms with conflicting aliases + 1 bare) | both pipe-forms split, bare unchanged + warning printed to stderr |
| Idempotence: re-run on script output produces 0 changes | byte-identical second pass |

---

## 8. Migration

**Recommendation: one-shot script, not a re-crawl.** Pattern follows `scripts/replay-merger.mjs` precedent — a Node script that loads `apps/web/public/data/songs.json`, runs the alias-resolution stage + `mergeRecords`, atomic-writes back. Lives at `scripts/replay-aliases.mjs` and re-uses the compiled `@karaoke/crawler` `resolveArtistAliases` + `mergeRecords` exports (the latter is already exported for `replay-merger.mjs`).

**Why not full re-crawl.** A full crawl is ~2-3 hours wall-clock and subject to TJ rate limits + the Windows-host atomic-rename workaround. The alias-resolution transformation is purely a function of the existing corpus (no new HTTP fetches), so a one-shot script captures everything that a re-crawl would. The script is also idempotent (Phase 1 is a no-op on already-canonical records, Phase 3 skips when `bareKey === canonicalKey`).

**Workflow integration.** Add `scripts/replay-aliases.mjs` (or fold into the existing `scripts/replay-merger.mjs` as a pre-merge step — preferred, since alias resolution must precede merge) so the same script handles both transformations. Wire it into `.github/workflows/crawl.yml` between the anisong-PDF ingest step and the schema-validation gate, mirroring the `node scripts/replay-merger.mjs` invocation introduced in `f08ad6e`.

**Procedure.**

1. Implement Phase 1 (schema + crawler resolver + tests). Single commit.
2. Implement Phase 2 (frontend search + display + tests). Single commit.
3. Implement Phase 3 (migration script `scripts/replay-aliases.mjs` + Python regression tests + CI wiring). Single commit.
4. Run the migration locally on Windows (or in a manual workflow dispatch). Verify against §9 success criteria.
5. Single commit `chore(corpus): apply artist alias resolution` with the regenerated `apps/web/public/data/songs.json`.

**Cache impact.** None. `tj-search-cache.json` is unaffected — alias resolution operates on `SongRecord` fields, not on `artistNationalityMap` keys (which already use `normalize()` on TJ-supplied artist strings, not corpus-derived ones).

---

## 9. Verification + rollout

**Bug-zero canary (post-migration).**

```bash
# Count records whose artist_primary still contains ｜ (should drop from ~840 to 0
# for cases the resolver handled, modulo the malformed-segment warnings).
PYTHONIOENCODING=utf-8 python -c "
import json
songs = json.load(open(r'apps/web/public/data/songs.json', encoding='utf-8'))
pipe = [r for r in songs if '｜' in (r.get('artist_primary') or '')]
print('pipe-form artist_primary remaining:', len(pipe))
"
# Expected: ~5-15 (only malformed-segment cases + collision-blocked records).
```

**ZUTOMAYO canary.**

```bash
PYTHONIOENCODING=utf-8 python -c "
import json
songs = json.load(open(r'apps/web/public/data/songs.json', encoding='utf-8'))
zm = [r for r in songs if 'ずっと真夜中' in (r.get('artist_primary') or '')]
print('count:', len(zm))
print('sample aliases:', zm[0].get('artist_aliases') if zm else None)
"
# Expected: artist_primary == 'ずっと真夜中でいいのに。', artist_aliases includes 'ZUTOMAYO'.
```

**Spitz dedup canary.**

```bash
PYTHONIOENCODING=utf-8 python -c "
import json
songs = json.load(open(r'apps/web/public/data/songs.json', encoding='utf-8'))
spitz = [r for r in songs if 'スピッツ' in (r.get('artist_primary') or '') or r.get('artist_primary') == 'Spitz']
print('スピッツ canonical:', sum(1 for r in spitz if r['artist_primary'] == 'スピッツ'))
print('Spitz bare residual:', sum(1 for r in spitz if r['artist_primary'] == 'Spitz'))
"
# Expected: bare residual drops from 9 to ~0; canonical count rises by approximately the merge count.
```

**BUMP OF CHICKEN preservation guard.**

```bash
PYTHONIOENCODING=utf-8 python -c "
import json
songs = json.load(open(r'apps/web/public/data/songs.json', encoding='utf-8'))
bump = [r for r in songs if 'BUMP OF CHICKEN' in (r.get('artist_primary') or '').upper()]
print('BUMP OF CHICKEN records:', len(bump))
"
# Expected: 145 (UNCHANGED — no alias map should touch this artist).
```

**Total record count.** Expected 25,793 → ~25,650-25,750 (drop of ~50-150 from successful Tier B merges of bare-vs-pipe-form pairs). >25,793 means resolver bug (record growth impossible). <25,500 means over-merging — STOP and investigate.

**Frontend smoke (manual / Playwright).**

- Search `"ZUTOMAYO"` → record visible in results, card displays `"ずっと真夜中でいいのに。 (ZUTOMAYO)"`.
- Search `"40meterP"` → record visible, card displays `"40mP (40meterP)"`.
- Search `"スピッツ"` → no duplicate `Spitz` and `スピッツ` cards (one card with `スピッツ (Spitz)`).

**Rollout.** No feature flag; correctness-first. Migration script idempotent so a partial deploy + retry is safe. No cache regeneration. No new HTTP load.

---

## 10. Risks + what NOT to do (recap)

| risk | mitigation |
|---|---|
| Broadening splitter to ` - ` introduces false positives on `"Artist - Subtitle"` pseudo-band names | NEVER add ` - ` to `PIPE_SPLIT_RE`. Only `｜` U+FF5C |
| Broadening to ASCII `\|` would break `Qverktett:\|\|` | Splitter regex is literal `/｜/g` — ASCII pipe is not in the character class |
| Aggressive bare-record re-keying merges genuinely distinct artists who happen to share a Latin alias | Phase 2 collision detection LEFT BOTH UNTOUCHED + warning; never silent merge |
| Tier C cross-source gate or feat-asymmetry+vocaloid exception regresses | NO changes to `merge.ts` — alias resolution is a pre-merge stage |
| BTS-IDOL false-positive guard regresses | Same — no `merge.ts` changes |
| `artist_ko` clustering picks up KAITO-under-WhiteFlame-class noise | Resolver does NOT use `artist_ko` for the alias map. Pipe-split + bare-key match only |
| MiniSearch silently skips array fields | Verified by §7.D fixture; fallback `extractField` callback documented |
| Empty-string aliases or duplicates pollute the corpus | Schema enforces `minLength: 1` + `uniqueItems: true`; resolver's Phase 1 dedupes pre-emit |
| Pipe-form records with collab decoration in canonical (`"X｜Y(Feat.Z)"`) double-process | Splitter runs first, so canonical = `"X"`, alias = `"Y(Feat.Z)"`; merger's Tier C still applies its lead-component rule downstream |

---

## 11. Effort estimate

| phase | files | LOC (rough) |
|---|---|---|
| Schema + tests | `packages/schema/src/index.ts` + `packages/schema/test/index.test.ts` | +30 / +40 |
| Crawler resolver + tests | NEW `packages/crawler/src/aliases.ts` + NEW `packages/crawler/test/aliases.test.ts` + extend `packages/crawler/src/pipeline.ts` + extend `packages/crawler/test/pipeline.test.ts` | +180 / +240 |
| Frontend search | `apps/web/src/lib/search.ts` + extend `apps/web/src/lib/search.test.ts` | +10 / +30 |
| Frontend display | `apps/web/src/components/ResultCard.tsx` + extend `apps/web/src/components/ResultCard.test.tsx` | +15 / +50 |
| Migration script + tests + CI wiring | NEW `scripts/replay-aliases.mjs` (or fold into `scripts/replay-merger.mjs`) + NEW `scripts/test_resolve_aliases.py` + edit `.github/workflows/crawl.yml` | +120 / +180 |
| Corpus regen commit | `apps/web/public/data/songs.json` | data-only |

**Total:** ~7-9 files touched (3 NEW), ~350-550 LOC across code + tests. Effort: small-to-medium — comparable to the 2026-05-04 vocaloid-mistag fix's 3-phase ship.

---

## 12. Open questions

1. **Migration vehicle.** Fold alias resolution into the existing `scripts/replay-merger.mjs` (single replay tool, must run pre-merge inside it) OR ship a standalone `scripts/replay-aliases.mjs` that runs first and feeds replay-merger? Recommend folding — it keeps the post-crawl maintenance surface small and is the natural ordering. **Decision point during implementation.**

2. **Display order of multiple aliases.** Phase 1 preserves source order (`"X｜Y｜Z"` → `[Y, Z]`). Phase 3 appends the bare original to the end. UI display joins with `", "`. Should aliases be alphabetically sorted for display stability? Recommend NO — preserving input order keeps the PR-body diff readable; if display ordering needs to be deterministic for screenshot tests, sort at render time only.

3. **Should a `｜`-collision warning block a CI commit?** Right now schema-validation failures fail CI. Alias collisions are warnings, not validation errors — the records validate fine. Recommend surfacing collision count in the PR body (matching the existing merge-conflicts pattern) but NOT failing CI; a maintainer reviews and dispositions each.
