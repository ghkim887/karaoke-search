# title_ko backfill — design spec

Date: 2026-05-06
Status: draft

## Summary

Replace the existing `title_ko` corpus pollution from TJ-API transliterations
with real Korean translations sourced from a parallel-dispatch agent pipeline
that augments LLM translation with targeted Korean-language web search.

## Background

`apps/web/public/data/songs.json` (~25.8k records) carries an optional
`title_ko` field for the Korean form of `title_primary`. The intent is real
translation (`愛が見えない` → `사랑이 보이지 않아`), not phonetic transliteration.

Surface coverage is currently 70.6% (18,202 / 25,793). After investigation:

- Blog source (~21k records, ID prefix `blog-`) carries genuine Korean
  translations from the Tistory editor — quality good.
- TJ-direct source (~3.9k records, ID prefix `tj-`) writes
  `enrichment.sortTitleKo` to `title_ko`. That field is TJ's catalog-sort
  helper: a katakana→Hangul phonetic mapping (`愛が見えない` → `아이가 미에나이`),
  not a translation. ~2.5k of these are pollution.
- 7,591 records have no `title_ko` at all.

Real-translation coverage is closer to 59%, not 70.6%.

A previous attempt to source Korean titles from Namuwiki was abandoned for two
reasons: (a) most articles don't actually present a Korean translation in
extractable form, (b) Namuwiki's CC BY-NC-SA license is restrictive for
redistributed content.

## Goal

Two outcomes, both committed to the corpus:

1. Strip TJ-derived phonetic `title_ko` values, salvaging only the Korean
   anime/OST parenthetical context they sometimes carry.
2. Fill `title_ko` for the resulting ~10k empty records via an agent-driven
   translation pipeline that uses web search to find established Korean fan
   canon when one exists.

## Non-goals

- Translating record fields other than `title_ko` (e.g. lyric snippets, album
  metadata).
- Building a generic translation MCP service — this is one-shot corpus
  hydration plus an idempotent re-run path for new records.
- Sourcing Korean release titles from Korean streaming-service APIs (Bugs,
  Melon, Genie). Considered and dropped: ToS-grey for redistribution.
- Fixing corpus mistags (e.g. `tj-73178` 海阔天空 is Cantonese, not Japanese,
  and is incorrectly tagged `jpop`). Tracked separately.

## Design

### Pipeline shape

```
Stage 1: scripts/normalize_tj_title_ko.py
  reads:  apps/web/public/data/songs.json
  writes: apps/web/public/data/songs.json (atomic)
  action: regex-salvages (...) media-context parentheticals from TJ-derived
          title_ko, sets media_context_ko, nullifies title_ko on TJ records,
          tags title_ko_source for blog records.

Stage 2: scripts/translate_title_ko_via_agents.mjs (orchestrator)
  reads:  songs.json (records where title_ko is null AND title_primary
          contains CJK characters)
  writes: scripts/data/llm-translations-chunk-NN.json (per-chunk, committable)
          + apps/web/public/data/songs.json (atomic, after merge)
          + scripts/data/llm-review.csv (low-confidence subset)
  action: chunks records into ~20 batches of ~500, dispatches parallel
          subagents (Opus) with explicit Korean query templates and
          fan-canon recognition rules. Merges results.
```

Both stages are idempotent: re-runs on unchanged input produce no diff. Stage
2 only re-translates records lacking `title_ko_source` — initial run hits
~10k records, subsequent weekly runs hit only newly crawled ones.

### Stage 1 — regex salvage and nullify

Pure-Python script, no LLM, no agents. ~80 lines.

For each record where `id` starts with `tj-` or `tjpdf-`:

1. Extract `(...)` segments from `title_ko` whose contents contain Hangul AND
   at least one media-context keyword: `OST | OP | ED | 극장판 | TV | OVA |
   삽입곡 | MV | 오프닝 | 엔딩`.
2. Concatenate matched parens (space-joined when multiple) → set
   `media_context_ko`.
3. Set `title_ko = null`.
4. Remove any pre-existing `title_ko_source` and `title_ko_confidence`.

For each record where `id` starts with `blog-` and `title_ko` is non-empty:

5. Set `title_ko_source = 'blog'` (provenance label only — no value change).

Atomic write via `<file>.tmp + os.replace`. Outputs run summary
(`stripped: N`, `salvaged: M`, `tagged: K`) to stdout.

#### Why this isn't a fancier classifier

An earlier draft proposed a heuristic detector with a kana→hangul
transliteration table, character similarity scoring, and a Korean grammar-
marker fallback. Discarded: subagent calls are free under the orchestrator's
session quota, so the heuristic's job ("save tokens by skipping records that
already have good translations") provides no benefit. Stage 2's agents handle
detection AND translation in one pass with full context.

### Stage 2 — parallel agent translation

Node orchestrator + subagent workers.

#### Chunking

- Filter: records with `title_ko === null` AND `title_primary` containing any
  character in `[぀-ゟ゠-ヿ一-鿿]` (kana or kanji).
- Expected count: ~10,142 records initial run; ~tens per week thereafter.
- Chunk size: 500 records per subagent. Total chunks: ~21.
- Concurrency: dispatch all chunks in parallel (Anthropic concurrency limits
  apply at the orchestrator's session level — empirically ~20 parallel
  agents is fine).

#### Per-record agent decision rules

Embedded verbatim in the worker prompt:

```
For each record, decide your initial confidence:
  - If you genuinely know the canonical Korean title from training (mainstream
    J-pop hit, well-known anime OP/ED): translate, mark confidence='high'.
  - If the title looks niche / Vocaloid / Hololive / indie / wordplay where
    Korean fan canon may exist but isn't in your training data: WebSearch
    before answering. Use these query templates in order:
      1. "<title_primary>" "<artist_primary>" 한국어
      2. <artist Korean-rendered> 가사 OR 제목
      3. site:namu.wiki <artist Korean-rendered>
      4. site:youtube.com 한글자막 <artist Korean-rendered>
    If a Korean YouTube fan-sub title (especially with 한글자막), Korean
    Namuwiki entry, or Korean lyric site shows a stable Korean form:
    use it, mark confidence='high'. Two+ independent Korean sources
    converging on the same form → high. Single source → medium.
    Found nothing → produce best-effort literal translation, mark medium.
  - If title_primary is pure-Latin: title_ko = null, no search needed.
  - If genuinely uncertain (ambiguous, unknown song, no Korean canon, can't
    produce confident translation): title_ko = null, confidence='low'.
```

#### Salvage media context

If `title_primary` has a `(...)` parenthetical anime/OST/OP/ED tag and the
agent knows or finds the canonical Korean version of the anime — populate
`media_context_ko`. Independent of the title_ko verdict; a record can have
title_ko=null AND media_context_ko set (Latin-titled anime tracks).

#### Worker output

Each subagent writes `scripts/data/llm-translations-chunk-NN.json`:

```json
[
  {
    "id": "tj-54060",
    "title_primary": "特者生存ワンダラダ-!!",
    "title_ko": "특자생존 Wonder-La-Der!!",
    "media_context_ko": null,
    "confidence": "high",
    "reasoning": "Korean fan-sub on YouTube uses '특자생존 Wonder-La-Der ! !'; the pun on 適者生存→特者生存 maps to 적자생존→특자생존 via shared Sino-Korean roots",
    "web_sources": [
      "https://www.youtube.com/watch?v=b7bMiQST5Zc"
    ]
  }
]
```

These chunk files are committable artifacts — they're the audit trail for
each LLM decision. Stored under `scripts/data/`.

#### Merge step

`scripts/translate_title_ko_via_agents.mjs` after all chunks return:

1. Loads every `llm-translations-chunk-*.json`.
2. Builds a `Map<id, decision>`.
3. Mutates songs.json: for each record with a decision, set `title_ko`,
   `media_context_ko`, `title_ko_source = 'llm-translated'`,
   `title_ko_confidence`. Records the agent left null stay null with no
   source tag (eligible for next run).
4. Writes a CSV of low-confidence records to
   `scripts/data/llm-review.csv` for human spot-check.
5. Atomic write of songs.json.

### Schema additions

In `packages/schema/src/index.ts`, add three optional fields to `SongRecord`:

```ts
{
  /**
   * Korean translation of the parenthetical media context tag, when
   * title_primary contains one. e.g. title_primary "Somewhere(スレイヤーズ TRY OST)"
   * → media_context_ko "(슬레이어즈 TRY OST)". Independent of title_ko —
   * a record may have one, both, or neither.
   */
  media_context_ko?: string;

  /**
   * Provenance tag for title_ko.
   *   'blog'           — original blog crawl Korean translation
   *   'llm-translated' — agent-translated in Stage 2
   *   'manual'         — reserved for any future hand-curation
   *
   * Note: TJ-direct sortTitleKo never lands here. Stage 1 nulls every
   * TJ-derived title_ko (it's transliteration, not translation) and
   * routes the Korean parenthetical context — when present — into
   * media_context_ko. So records that originally carried TJ title_ko
   * end up either with title_ko === null + media_context_ko set,
   * or with both null. Stage 2 then fills title_ko via the agent.
   */
  title_ko_source?: 'blog' | 'llm-translated' | 'manual';

  /**
   * Confidence the agent attached during Stage 2. Only set when
   * title_ko_source === 'llm-translated'. Records with 'low' confidence
   * are surfaced in scripts/data/llm-review.csv for spot-check.
   */
  title_ko_confidence?: 'high' | 'medium' | 'low';
}
```

Ajv schema enforces the `title_ko_source` enum and the
`title_ko_confidence === 'low' | 'medium' | 'high'` enum. Cross-field
constraint (`title_ko_confidence` only set when `title_ko_source ===
'llm-translated'`) implemented via `if/then` keywords.

### Frontend implications

`apps/web/src/components/ResultCard.tsx`: when `media_context_ko` is non-empty
AND not already a substring of `title_ko`, render
`<title_ko> <media_context_ko>` (e.g., `사랑이 보이지 않아 (진격의 거인 OP)`).
~5-line change.

Whether `media_context_ko` is added to MiniSearch's indexed-field set is a
search-relevance choice deferred to the implementation plan: indexing helps
Korean users who search by anime title, but the existing `artist_aliases`
index already gives most of that coverage when the anime maps to an artist.

### Validation evidence (dry-run)

A 50-record dry-run on Opus produced:
- 6 records preserved (existing real translations untouched)
- 31 records re-translated (replacing TJ phonetics + filling nulls)
- 13 records nulled (pure-Latin / English titles)
- 0 outright bad translations
- ~10% medium-confidence rate (calibration looks reasonable)

A targeted single-record test on `tj-54060` (`特者生存ワンダラダ-!!`, a
Hololive VTuber track by Amane Kanata, categorized `jpop` in the corpus)
compared:
- Opus, no web search: `특자생존 완다라다-!!` — got the pun via Sino-Korean
  parallel, transliterated the onomatopoeia.
- Haiku, no web search: `특별한 존재 생존 원더라다-!!` — missed the pun.
- Haiku, web search enabled: `특이한 생존 원더래다-!!` — searched but failed
  to construct Korean-targeted queries; surfaced only Japanese sources.
- Manual web search (Korean keywords): `특자생존 Wonder-La-Der!!` — Korean
  YouTube fan-sub canonical, used by Korean Hololive fans.

Conclusion: Opus + explicit Korean query templates is the right combination.
Haiku underperforms even with web search enabled because its Korean query
construction is weaker.

### Operational concerns

- **Subagent quota:** 21 parallel Opus agents share the orchestrator's
  session. Anthropic's per-session concurrency caps apply. If 21 hits a
  cap, fall back to 10 parallel × 2 waves.
- **Web search latency:** ~30% of records trigger search. Per-search
  median ~3s. A 500-record chunk grows from ~1 min wall-clock to
  ~5-10 min. Total batch wall-clock: ~10-15 min if all chunks parallel.
- **Cost:** subagent calls share the parent's billing; effective marginal
  cost is zero under the user's current plan.
- **Idempotence:** stages 1 and 2 are byte-stable on unchanged input.
  Re-running the entire pipeline produces no diff if no new records
  arrived. Stage 2's chunk JSONs are committed alongside corpus changes
  for auditability.

## Acceptance criteria

1. After Stage 1 runs: zero records with `id` starting `tj-` or `tjpdf-`
   have `title_ko` matching a katakana→Hangul transliteration heuristic
   (manually spot-checked on 100 random samples).
2. After Stage 2 runs: at least 95% of records that previously had
   `title_ko === null` AND `title_primary` containing CJK now have
   `title_ko` set with `title_ko_source === 'llm-translated'`.
3. Of the records translated in Stage 2, the `confidence === 'low'` rate
   is ≤ 5%.
4. `scripts/validate-songs-json.mjs` passes against the post-pipeline
   `songs.json` (schema additions enforced).
5. `corepack pnpm --filter @karaoke/web build` clean.
6. `corepack pnpm --filter @karaoke/web test` passes (existing tests
   adapted for the new optional fields where needed).
7. The frontend renders `media_context_ko` on result cards when present.

## Risks

- **Agent hallucinations on canonical translations.** Mitigation: the
  prompt requires 2+ independent Korean sources for `confidence='high'`.
  Single-source canonical claims drop to medium.
- **Korean YouTube fan-subs may use non-canonical fan translations.** The
  prompt favors `한글자막` titles and Namuwiki entries (more vetted than
  random fan-subs).
- **Long-tail TJ-only B-sides have no findable Korean canon.** Best-effort
  literal translation is the ceiling. Acceptable.
- **Schema changes ripple through the build.** The 3 new fields are all
  optional, so existing records validate without modification. New tests
  needed only for the `title_ko_source = 'llm-translated' →
  title_ko_confidence required` cross-field constraint.

## Out-of-scope follow-ups (tracked separately)

- Backfilling `artist_ko` for TJ-only records (artist transliteration
  follows similar issues; would benefit from the same agent pipeline).
- Mistag cleanup (`tj-73178` Cantonese-tagged-jpop and similar non-J-pop
  records leaking into the catalog).
- A scheduled CI step to run Stage 2 on new crawl output automatically.
