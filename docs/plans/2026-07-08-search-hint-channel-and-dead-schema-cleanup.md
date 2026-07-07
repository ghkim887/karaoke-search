# Search hint channel + dead-schema retire — Implementation Plan

> **For agentic workers:** implement task-by-task via the harness delegation protocol — one fresh author subagent per task with a full contract, reviewer between. Checkbox (`- [ ]`) tracking.

**Goal:** Retire the serve-dead search schema (`text_norm` on `search_texts`+`search_hints`, the whole `search_hints` table) and the `title_ruby` serve-projection waste, while KEEPING and properly wiring the search-only hint channel (`title_hint`/`artist_hint` tokens) so a curated set of artist-search hints survives full rebuilds.

**Architecture:** The self-host SQLite search DB is built by `apps/worker/scripts/build-sqlite-db.mjs` (and the release path `scripts/publish-full-corpus.mjs`) from a corpus JSON + optional `--search-hints` sidecars. Recall reads `search_tokens`/`search_token_stats`/`search_texts.text_compact`; `search_hints` and `text_norm` are written but never read at serve/export/rebuild. Hints materialize into `search_tokens(title_hint/artist_hint)`; that materialization stays, the table goes.

**Tech Stack:** TypeScript ESM, `node:sqlite` (DatabaseSync), pnpm workspaces, vitest, biome, knip. Node per `.nvmrc`.

**Global Constraints (verbatim):**
- Recall behavior MUST stay identical — search-parity golden + baseline are expected to be a no-op; regenerate only to confirm.
- CI-mirror gate must pass: `pnpm biome check`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`, `pnpm knip`.
- Web build / wrangler steps run in PowerShell (MSYS mangles the deploy env) — not needed here but keep gate commands in pwsh.
- Additive-schema convention is being reversed here (a REMOVAL): data-store + worker must change together in one release.
- No secrets; do not touch `db/`, releases, or the NAS tree.

Tasks are grouped in waves; tasks within a wave are independent and may run in parallel.

---

## File structure

- `data/search-hints.jsonl` — NEW committed curated sidecar (16 artist-search hints). Source of truth going forward.
- `packages/data-store/src/schema.ts` — DDL: drop `text_norm` from `search_texts`; delete `search_hints` table; add legacy convergence (`DROP TABLE IF EXISTS search_hints`; recreate `search_texts` if it still has `text_norm`).
- `packages/data-store/src/song-writer.ts` — stop writing `text_norm` and `search_hints` rows; keep hint→token writes.
- `packages/data-store/src/import-export.ts` — split `SONG_COLUMNS` into serve (no `title_ruby`) vs export (with `title_ruby`); drop `search_hints` from the clear statement.
- `packages/data-store/src/delta-patch.ts` — drop the per-song `deleteSearchHints` usage; keep hint-token regen.
- `apps/worker/src/index.ts` — serve projection uses the serve column set.
- `scripts/publish-full-corpus.mjs` — accept repeatable `--search-hints` → pass `searchHintPaths` to `buildSqliteDb`.
- `docs/ROADMAP.md` — resolve the dead-schema inventory entry (OPEN-QUESTIONS was consolidated into ROADMAP in PR #92).
- `docs/ARCHITECTURE.md` — document the search-only hint channel + how to add a hint.
- Tests: `packages/data-store/test/{search-hints.test.ts,ruby-indexing.test.ts}`, `apps/worker/test/build-sqlite-db.test.mjs`, `scripts/*publish-full-corpus*.test.mjs` (name per existing), + a new guard test.

---

## Wave 1 — independent

### Task 1: Curated hint sidecar `data/search-hints.jsonl` (Wave 1)

**Files:**
- Create: `data/search-hints.jsonl`
- Test: `packages/data-store/test/search-hints.test.ts` (add a case parsing this exact file)

**Change:** Commit the 16 artist-search hints worth keeping (derived from the prod `search_hints` dump; title hints were redundant with canonical tokenization, title-derived romaji drop with them; artist-field romaji auto-regenerates via `resolveSearchHints`). One JSON object per line, flat form per `packages/data-store/src/hints.ts` (`{song_id, field, text, source, confidence}`).

**Implementation** — exact file content (JSONL, one object per line, UTF-8, no trailing blank line beyond one newline):

```jsonl
{"song_id":"tj-26573","field":"artist","text":"佐倉蜜柑(植田佳奈)/今井蛍(釘宮理恵)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-26670","field":"artist","text":"高槻やよい(cv:仁後真耶子)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-26800","field":"artist","text":"モモタロス(関俊彦)・ウラタロス(遊佐浩二)・キンタロス(てらそままさき)・リュウタロス(鈴村健一)・デネブ(大塚芳忠)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-27147","field":"artist","text":"野沢雅子","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-27849","field":"artist","text":"如月千早(今井麻美)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-6339","field":"artist","text":"沢ひろしとtokyo99","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-6520","field":"artist","text":"オヨネーズ","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-6541","field":"artist","text":"梅沢富美男","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68139","field":"artist","text":"松たか子(エルサ)、吉田羊(イドゥナ王妃)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68140","field":"artist","text":"神田沙也加(アナ)、松たか子(エルサ)、武内駿輔(オラフ)、原慎一郎(クリストフ)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68197","field":"artist","text":"四十物十四(cv:榊原優希)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68529","field":"artist","text":"machico","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68666","field":"artist","text":"双葉杏(cv五十嵐裕美)","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68988","field":"artist","text":"idolish7 & trigger & re:vale & zool","source":"v11_artist_credit_policy_removed_joy_row","confidence":"medium"}
{"song_id":"blog-338-10","field":"artist","text":"misia","source":"v11_review_leakage_fix_removed_joy_row","confidence":"medium"}
{"song_id":"tj-68528","field":"artist","text":"honeyworks","source":"v11_review_leakage_fix_removed_joy_row","confidence":"medium"}
```

**Test** — add to `search-hints.test.ts` (adjust import path to the file's helpers):

```ts
import { parseSearchHintFile } from '../src/hints.js';
import { resolve } from 'node:path';

it('parses the committed curated search-hints sidecar', () => {
  const hints = parseSearchHintFile(resolve(__dirname, '../../../data/search-hints.jsonl'));
  expect(hints.length).toBe(16);
  expect(hints.every((h) => h.field === 'artist')).toBe(true);
  expect(hints.some((h) => h.songId === 'tj-26670' && h.text.includes('高槻やよい'))).toBe(true);
});
```

**Acceptance:**
- Run: `node -e "const {parseSearchHintFile}=require('./packages/data-store/dist/hints.js'); console.log(parseSearchHintFile('data/search-hints.jsonl').length)"` after a data-store build → prints `16`. (Or run the vitest case below.)
- Run: `pnpm --filter @karaoke/data-store test search-hints` → PASS
- [ ] Task complete

### Task 2: Wire `--search-hints` into `publish-full-corpus.mjs` (Wave 1)

**Files:**
- Modify: `scripts/publish-full-corpus.mjs` (`parseArgs` `valueFlags`/defaults ~line 65-99; the `buildSqlite` call ~line 269)
- Test: the existing publish-full-corpus test (find via `ls scripts/*publish-full-corpus*.test.mjs`); add a `parseArgs` case.

**Change:** Add a repeatable `--search-hints <path>` flag collecting into `searchHintPaths: string[]`, and pass it to `buildSqliteDb` so the release build materializes hint tokens. `build-sqlite-db.mjs` already accepts `searchHintPaths` (its `buildSqliteDb({inputPath, outputPath, searchHintPaths})`).

**Implementation:**
- In `parseArgs`, add `searchHintPaths: []` to `parsed`; handle `--search-hints` specially (repeatable, so not in the single-value `valueFlags` map):

```js
// inside the for-loop, before the valueFlags lookup:
if (arg === '--search-hints') {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }
  parsed.searchHintPaths.push(value);
  i += 1;
  continue;
}
```
- Add to USAGE: `'  --search-hints <path>     search-only hint sidecar (repeatable); indexed into title_hint/artist_hint tokens'`.
- At the build call (currently `await buildSqlite({ inputPath: opts.inputPath, outputPath: opts.sqliteOut })`), pass hints:

```js
const result = await buildSqlite({
  inputPath: opts.inputPath,
  outputPath: opts.sqliteOut,
  searchHintPaths: opts.searchHintPaths ?? [],
});
```
(Confirm the run() plumbs `parsed.searchHintPaths` → `opts.searchHintPaths`; thread it through the same way `sqliteOut` flows.)

**Test** — add to the publish-full-corpus test file:

```js
it('collects repeatable --search-hints paths', () => {
  const parsed = parseArgs(['--input', 'c.json', '--url', 'PENDING', '--search-hints', 'a.jsonl', '--search-hints', 'b.jsonl']);
  assert.deepEqual(parsed.searchHintPaths, ['a.jsonl', 'b.jsonl']);
});
```

**Acceptance:**
- Run: `node --test scripts/` (or the project's script-test command, e.g. `pnpm --filter @karaoke/scripts test` — check `scripts/package.json`) → the new case PASS
- Run: `node scripts/publish-full-corpus.mjs --help` → shows `--search-hints`
- [ ] Task complete

### Task 3: Docs — resolve dead-schema entry + document the hint channel (Wave 1)

**Files:**
- Modify: `docs/ROADMAP.md` (the consolidated dead-schema inventory section from PR #92)
- Modify: `docs/ARCHITECTURE.md` (search section)

**Change:** In `ROADMAP.md`, mark the `text_norm`/`search_hints`/`title_ruby-projection` dead-schema items as RESOLVED by this change (retired), and record that the hint channel is retained + wired. In `ARCHITECTURE.md`, add a short subsection: "Search-only hint channel — alternate strings (e.g. character/CV artist credits) that must improve recall without appearing in display (unlike `artist_aliases`, which renders in `ResultCard`). Source of truth: committed `data/search-hints.jsonl`; materialized into `search_tokens(title_hint/artist_hint)` at build; wired via `publish-full-corpus.mjs --search-hints`. To add a hint: append a line to `data/search-hints.jsonl` (`{song_id, field, text, source, confidence}`)."

**Acceptance:**
- Run: `grep -n "search-only hint channel" docs/ARCHITECTURE.md` → 1 match
- Run: `grep -niE "text_norm|search_hints" docs/ROADMAP.md` → the entry now reads as resolved/retired
- [ ] Task complete

---

## Wave 2 — data-store core (after Wave 1; independent of Wave 1's files)

### Task 4: Retire dead schema in data-store (Wave 2)

**Files:**
- Modify: `packages/data-store/src/schema.ts`
- Modify: `packages/data-store/src/song-writer.ts`
- Modify: `packages/data-store/src/import-export.ts`
- Modify: `packages/data-store/src/delta-patch.ts`
- Test: `packages/data-store/test/search-hints.test.ts`, `packages/data-store/test/ruby-indexing.test.ts` (update refs to dropped `text_norm`/table)

**Interfaces produced (later tasks rely on these):**
- `import-export.ts` exports both `SONG_COLUMNS` (export set, includes `title_ruby`) and a new `SONG_SERVE_COLUMNS` (excludes `title_ruby`), plus `songColumnsProjection(alias?)` (export) and `songServeColumnsProjection(alias?)` (serve). Signatures identical to the current `songColumnsProjection`.

**Change (schema.ts):**
1. In `SONG_TABLE_SCHEMA_SQL`: remove `text_norm TEXT NOT NULL,` from the `search_texts` CREATE (PK stays `(song_id, field, text_compact)`). Delete the entire `search_hints` CREATE line.
2. In `createSongDatabase`, add legacy convergence AFTER `db.exec(SONG_TABLE_SCHEMA_SQL)` and the existing ensure* calls:
   - `db.exec('DROP TABLE IF EXISTS search_hints');`
   - Recreate `search_texts` if a legacy DB still has `text_norm` (fully derived, rebuilt on import):

```ts
function ensureSearchTextsNoTextNorm(db: SongDatabase): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'search_texts'`)
    .get() as { sql?: string } | undefined;
  if (row?.sql !== undefined && row.sql.includes('text_norm')) {
    db.exec('DROP TABLE IF EXISTS search_texts');
    db.exec(SONG_TABLE_SCHEMA_SQL); // recreates only the dropped table (others are IF NOT EXISTS)
  }
}
```
   Call `ensureSearchTextsNoTextNorm(db)` in `createSongDatabase`. Keep `ensureSearchTableFields`/`ensureSearchTokensHintFields` for `search_tokens` unchanged (title_hint/artist_hint token fields stay).

**Change (song-writer.ts):**
1. Remove `deleteSearchHints` and `insertSearchHint` from `SongWriteStatements` and `prepareSongWriteStatements`.
2. `insertSearchText`: drop `text_norm` column + its value. New statement:
```ts
insertSearchText: db.prepare(
  `INSERT OR IGNORE INTO search_texts (song_id, field, text_compact, weight, provider_mask) VALUES (?, ?, ?, ?, ?)`,
),
```
   and the call site (currently 5 args incl. `normalizeSearchText(input.value).trim()`) becomes:
```ts
statements.insertSearchText.run(record.id, input.field, textCompact, input.weight, providerMask);
```
   Remove the now-unused `normalizeSearchText` import if nothing else uses it (check: `resolveSearchHints` uses it in search-index.ts, not here — so remove from song-writer.ts imports if unused there).
3. In `writeSongRecordRows`, the `for (const hint of hints)` loop: DELETE the `statements.insertSearchHint.run(...)` call; KEEP the `writeSearchTokens(statements, {songId: hint.songId, field: HINT_TOKEN_FIELD_BY_HINT_FIELD[hint.field], value: hint.textNorm, ...})` call. Hints still produce tokens.

**Change (import-export.ts):**
1. The full-import clear statement (the `DELETE FROM search_token_stats; DELETE FROM search_tokens; DELETE FROM search_texts; DELETE FROM search_hints`): remove `; DELETE FROM search_hints`.
2. Split projections: keep `SONG_COLUMNS` (with `title_ruby`) for export; add `SONG_SERVE_COLUMNS` = `SONG_COLUMNS` minus `title_ruby`; add `songServeColumnsProjection(alias?)`. `exportSongs` keeps using `songColumnsProjection()`.

**Change (delta-patch.ts):**
1. Remove the per-song `statements.deleteSearchHints.run(songId)` call (and any reference). Keep the hint-token regen (`resolveSearchHints` + `writeSongRecordRows`).

**Change (tests):**
- `search-hints.test.ts`: it likely builds a DB and asserts `SELECT text_norm FROM search_hints`. Rewrite those assertions to query `search_tokens WHERE field IN ('title_hint','artist_hint')` (recall lives there now); assert `SELECT count(*) FROM sqlite_master WHERE name='search_hints'` = 0.
- `ruby-indexing.test.ts`: remove any `text_norm` column reads; assert on tokens instead.

**Acceptance:**
- Run: `pnpm --filter @karaoke/data-store test` → PASS
- Run: `pnpm --filter @karaoke/data-store build && node -e "const s=require('./packages/data-store/dist/schema.js'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); s.createSongDatabase(db); const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('search_hints')\").all(); console.log('search_hints_tables=', t.length); const c=db.prepare('PRAGMA table_info(search_texts)').all().map(r=>r.name); console.log('search_texts_has_text_norm=', c.includes('text_norm'));"` → `search_hints_tables= 0`, `search_texts_has_text_norm= false`
- [ ] Task complete

---

## Wave 3 — consumers (after Wave 2)

### Task 5: Worker serve projection drops `title_ruby` (Wave 3)

**Files:**
- Modify: `apps/worker/src/index.ts` (the two serve `SELECT ${songColumnsProjection('s')}` sites — the paged/browse query ~line 122/194 and the ranked query ~line 272; and the number-query projection ~line 343)
- Test: `apps/worker/test/search.test.ts` (assert response has no `title_ruby`, unchanged otherwise)

**Interfaces consumed:** `songServeColumnsProjection` from `@karaoke/data-store` (Task 4).

**Change:** Replace `songColumnsProjection('s')` with `songServeColumnsProjection('s')` at every SERVE projection site in `apps/worker/src/index.ts`. Update the import from `@karaoke/data-store`. `StoredSongRow`/`hydrateSongs` already never read `title_ruby`, so behavior is unchanged; this just stops fetching it. (Do NOT change `exportSongs` — it keeps `songColumnsProjection`.)

**Test:**
```ts
it('serve response omits title_ruby (projection trimmed)', async () => {
  // build a tiny DB with a ruby-bearing song, query it, assert the returned record has no title_ruby key
  // (reuse the existing search.test.ts DB-builder helper)
});
```

**Acceptance:**
- Run: `pnpm --filter @karaoke/worker test` → PASS
- Run: `grep -n "songColumnsProjection('s')" apps/worker/src/index.ts` → 0 matches (all serve sites switched to `songServeColumnsProjection`)
- [ ] Task complete

### Task 6: Guard test — release build materializes hint tokens (Wave 3)

**Files:**
- Test: `apps/worker/test/build-sqlite-db.test.mjs` (add a case) OR a new `scripts/publish-full-corpus.hints.test.mjs`

**Interfaces consumed:** `buildSqliteDb({inputPath, outputPath, searchHintPaths})`; `data/search-hints.jsonl` (Task 1).

**Change:** Build a DB from a fixture corpus containing at least one song id present in `data/search-hints.jsonl` (e.g. `tj-26670`) plus `--search-hints data/search-hints.jsonl`, and assert `search_tokens` has `artist_hint` rows for that song and that `search_hints` table / `text_norm` column do not exist. This guards against silently re-unwiring hints (the original prod bug) and against the dead schema resurfacing.

**Test:**
```js
it('release build materializes artist_hint tokens from the curated sidecar', async () => {
  // fixture corpus JSON with a record {id:'tj-26670', title_primary:'GO MY WAY!', artist_primary:'THE IDOLM@STER', karaoke_numbers:{tj:'26670',ky:null,joysound:null}, ...minimal valid fields}
  // write to scratch, run buildSqliteDb({inputPath, outputPath, searchHintPaths:['data/search-hints.jsonl']})
  // open output; assert:
  //   SELECT count(*) FROM search_tokens WHERE song_id='tj-26670' AND field='artist_hint'  > 0
  //   SELECT count(*) FROM sqlite_master WHERE name='search_hints'  == 0
  //   PRAGMA table_info(search_texts) has no 'text_norm'
});
```

**Acceptance:**
- Run: `pnpm --filter @karaoke/worker test build-sqlite-db` → the new case PASS
- [ ] Task complete

---

## Final gate (run after all waves, in PowerShell from clone root)
- `pnpm biome check` → clean
- `pnpm -r typecheck` → clean
- `pnpm -r test` → all pass
- `pnpm -r build` → success
- `pnpm knip` → clean (note: removing `insertSearchHint`/`deleteSearchHints`/`text_norm` must not leave unused exports; if `resolveSearchHints`/`groupResolvedHints`/`parseSearchHintFile` become unused anywhere, they are STILL used by the token path — verify knip stays green)
- Search-parity: regenerate golden/baseline (`UPDATE_PARITY_SNAPSHOT=1 pnpm --filter @karaoke/web test search-parity`) and confirm the diff is empty (recall unchanged). If non-empty, STOP — that is a regression, not expected.

## Self-review notes (author: heed)
- The hint→token path is the ONLY thing keeping the 16 curated hints alive; never remove `writeSearchTokens` for hints, only the table write.
- `ResolvedSearchHint.textNorm` is an in-memory field used as the token `value` — it stays; only the DB `text_norm` COLUMN goes.
- Legacy convergence matters for the delta path on an existing served DB; the release is a fresh full build so it converges immediately, but keep the `DROP TABLE`/recreate guards so a delta patch on an old DB can't hit the NOT-NULL `text_norm`.
