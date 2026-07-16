# Search: formalize the search-only hint channel + retire dead schema

- **Date:** 2026-07-08
- **Status:** APPROVED (owner 2026-07-08). Open decision resolved: **DROP the `search_hints` table.** Implement on a local clone under the author/reviewer + CI-mirror gate.
- **Owner direction:** "실사용 외 전량 은퇴 + 간소화" then "필요한 것만 보존하고, 앞으로도 그 용도로 활용하자" — retire dead schema, but keep the hint mechanism as the going-forward search-only recall channel and preserve the hints that earn their keep.

## Context (prod-verified 2026-07-08)

- Served DB v21 = `/srv/nas/karaoke/db/releases/data-2026-07-04-v21-title-ruby/songs.sqlite`, 307,961 songs.
- Serve recall (`apps/worker/src/index.ts:205-281`) reads **only** `search_tokens` (+ `search_token_stats` idf) and `search_texts.text_compact` (exact tier); number search reads `karaoke_numbers`; response projects `songs`.
- **Never read at serve/export/rebuild:** the whole `search_hints` table, and `text_norm` on both `search_texts` and `search_hints`. Recall for hints is materialized into `search_tokens` (`title_hint`/`artist_hint`) at write time.
- `title_ruby` reading recall (236,224 songs, 77%) flows via the `songs.title_ruby` column → `readingTokenInputs` → tokens; it is wired and serve-live and supersedes the bulk JOYSOUND `songNameRuby` hints.
- `search_hints` in v21 = **37 rows** (dump: `scratchpad/hints37.tsv`): ~16 title hints, ~17 artist hints, 4 derived romaji.
- The hint sidecar is **not wired into the full build** (`sqlite:build`, CI, `publish-full-corpus.mjs:269` calls `buildSqlite({inputPath, outputPath})` with no hint paths); only `patch-json-delta` exposes `--search-hints`. So the 37 arrived via delta patches and **a full rebuild (v22) would silently drop them**.
- `artist_aliases` is **display-visible** (`apps/web/src/components/ResultCard.tsx:27-29,97` `joinArtistDisplay` renders `artist (alias1, alias2)`), so it is NOT a home for search-only strings.

## Decision

Keep the hint mechanism as the **official search-only recall channel** — alternate strings that must improve recall without appearing in display (the one thing `artist_aliases` cannot do). Preserve the hints that add unique recall, retire the genuinely dead schema, and finish wiring the channel so hints survive full rebuilds.

## In scope

### A. Keep & formalize the search-only hint channel
- Retain the sidecar → `resolveSearchHints` → `search_tokens(title_hint/artist_hint)` materialization (weight 1, strictly below every canonical field).
- **Wire `--search-hints` into the release build:** `scripts/publish-full-corpus.mjs` passes `searchHintPaths` (the committed curated sidecar) into `buildSqliteDb`, so full rebuilds retain hints. This closes the current gap where a full rebuild drops them.
- **Committed curated sidecar:** `data/search-hints.jsonl` (new, committed), format per `packages/data-store/src/hints.ts` (`{song_id, field, text, source, confidence}`). This file is the single source of truth going forward and the place to add future search-only strings.
- Document the channel and "how to add a hint" in `docs/ARCHITECTURE.md`; resolve the dead-schema entry in `docs/OPEN-QUESTIONS.md`.

### B. Preserve the needed hints (source: `scratchpad/hints37.tsv`)
- **Keep the ~17 artist-field hints** — character/CV credits (`高槻やよい(cv:仁後真耶子)`), kanji/spacing variants (`沢ひろしとtokyo99` vs `澤ひろしとTOKYO 99`), short forms (`オヨネーズ`). Unique recall not covered by the canonical artist or by `title_ruby`, and inherently search-only (must not surface in display — they are exactly the credits the v11 policy removed from display).
- Auto-derived romaji children regenerate from kept kana hints via `resolveSearchHints` (no manual preservation needed).
- **Drop the ~16 title-field hints** (redundant: the canonical title already tokenizes to match — e.g. `約束` matches `約束(THE iDOLM@STER OST)` via term/prefix/gram at weight 5, vs hint weight 1) **and the 3 title-derived romaji**.

### C. Retire dead schema
- **Drop `text_norm`** from `search_texts` AND `search_hints` (written every build, read only by tests).
- **Trim `title_ruby` from the worker serve projection:** split `SONG_COLUMNS` so the serve path stops fetching it (`hydrateSongs` never returned it), while `exportSongs` and token derivation keep it. Column stays.
- **Drop the `search_hints` table** *(recommended; flagged)*. Recall is via the materialized tokens; the committed sidecar jsonl is the source of truth; the table is an unread write-only mirror. Keeping it as an audit mirror is possible — see Open decision.

## Out of scope / non-goals
- No change to recall behavior for canonical fields, `title_ruby` reading search, choseong initials, grams, or number search.
- No change to the bulk JOYSOUND `songNameRuby` path (already superseded by the `title_ruby` corpus column).
- No `artist_aliases` changes (would regress display).

## Affected components
- `packages/data-store/src/schema.ts` — DDL: remove `text_norm` from `search_texts`; drop `search_hints` table (+ `DROP TABLE IF EXISTS search_hints` in `createSongDatabase` for legacy convergence); keep `title_hint`/`artist_hint` token fields.
- `packages/data-store/src/song-writer.ts` — stop writing `text_norm` and `search_hints` rows; keep hint→token writes.
- `packages/data-store/src/import-export.ts` — split `SONG_COLUMNS` into a serve projection (no `title_ruby`) and an export projection (with `title_ruby`).
- `packages/data-store/src/{hints.ts,search-index.ts,delta-patch.ts}` — keep `resolveSearchHints` + token path; remove the table writer.
- `apps/worker/src/index.ts` — serve projection uses the trimmed column set; queries otherwise unchanged.
- `scripts/publish-full-corpus.mjs` — pass `searchHintPaths` into `buildSqlite`.
- `data/search-hints.jsonl` — NEW committed curated sidecar (the ~17 artist hints).
- Tests — update `ruby-indexing.test.ts`, `search-hints.test.ts`, `build-sqlite-db.test.mjs`; ADD a guard test asserting the release build path materializes `title_hint`/`artist_hint` tokens for the curated hints (prevents silent re-unwiring).
- Docs — `docs/ARCHITECTURE.md` (hint channel), `docs/OPEN-QUESTIONS.md` (resolve dead-schema entry).

## Data flow after change
- **build:** corpus + committed `data/search-hints.jsonl` → import → `songs` / `karaoke_numbers` / `artist_aliases` / `search_texts` (no `text_norm`) / `search_tokens` (incl. `title_hint`/`artist_hint`) / `search_token_stats`. No `search_hints` table.
- **serve:** recall identical (token tiers incl. hint + reading tokens, exact-compact tier); projection no longer fetches `title_ruby`.

## Migration / legacy DB
- `search_texts`/`search_tokens` are drop&recreate on import, so the `text_norm`-less DDL applies on the next rebuild; `createSongDatabase` gets `DROP TABLE IF EXISTS search_hints`. The served DB is a full rebuild each release → converges immediately.

## Testing / verification
- **search-parity golden + baseline:** EXPECTED unchanged (recall behavior identical). Regenerate only to confirm the no-op.
- **New guard:** release build (`publish-full-corpus --sqlite-out`) produces `title_hint`/`artist_hint` tokens for the curated hints (count > 0).
- **Full gate (CI mirror):** biome / `-r typecheck` / `-r test` / `-r build` / knip.
- Post-merge: next full release build → spot-check on the served DB that hint tokens exist and `search_hints`/`text_norm` are gone.

## Risks
- If the curated sidecar is not committed AND wired, hints silently drop on full rebuild (the current bug) — the new guard test blocks that regression.
- Dropping `text_norm`/table needs coordinated data-store + worker changes; low risk (dead data) but must land together in one release.

## Resolved decision
- **`search_hints` table: DROP** (owner 2026-07-08). Recall is via the materialized `title_hint`/`artist_hint` tokens; the committed `data/search-hints.jsonl` is the single source of truth. The table's writer (`insertSearchHint`) and DDL are removed; `createSongDatabase` gets `DROP TABLE IF EXISTS search_hints` for legacy convergence.
