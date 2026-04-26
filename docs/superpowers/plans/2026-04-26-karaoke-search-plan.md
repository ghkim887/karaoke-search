# Karaoke Search — Implementation Plan

Source spec: `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` (locked).
Repo: greenfield TypeScript pnpm monorepo on `main` (3 commits), pushed to `https://github.com/ghkim887-karaoke-search`.

## Required GitHub repository secrets (set before Phase 7)

- `CLOUDFLARE_API_TOKEN` — Cloudflare Pages deploy token, scoped to `Pages: Edit` for the project.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID hosting the Pages project.
- `GITHUB_TOKEN` — provided by Actions; only needs `pull-requests: write` and `contents: write` for `crawl.yml`.

## Phase 0 — Repo scaffold

- **Goal**: Stand up an empty pnpm + TypeScript + Biome monorepo that installs and lints cleanly.
- **Deliverables**:
  - `package.json` (root, `"private": true`, `"packageManager": "pnpm@9"`, scripts: `lint`, `format`, `typecheck`).
  - `pnpm-workspace.yaml` (`packages: ["apps/*", "packages/*"]`).
  - `tsconfig.base.json` (`"strict": true`, `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"verbatimModuleSyntax": true`, `"noUncheckedIndexedAccess": true`).
  - `biome.json` (formatter + linter on, `"javascript.formatter.lineWidth": 100`, `"organizeImports": "on"`).
  - `.gitattributes` (`* text=auto eol=lf`, explicit LF for `*.ts *.tsx *.json *.md *.yml *.yaml *.astro *.html`).
  - `.editorconfig` (UTF-8, LF, 2-space indent).
  - `.nvmrc` (`20`).
- **Implementation notes**: No `src/` yet. `package.json` MUST NOT declare a `main` or `type` since it is a workspace root. Pin pnpm via `packageManager` field so CI installs the same version. Biome version pinned in `devDependencies` (`@biomejs/biome`).
- **Verification**:
  - `pnpm install` exits 0 and prints `Done in <n>s`.
  - `pnpm exec biome check .` exits 0 with `Checked 0 files`.
  - `git ls-files | grep -E '\.(ts|tsx|astro)$'` prints nothing (no source yet).
- **Review pass** (`code-reviewer`):
  - Confirm `tsconfig.base.json` includes `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
  - Confirm `pnpm-workspace.yaml` globs cover `apps/*` and `packages/*` only.
  - Confirm `.gitattributes` enforces LF on all source extensions listed in spec Section "Repository Layout".
  - Confirm root `package.json` has no `dependencies` block (only `devDependencies`).
- **Commit message**:
  ```
  chore: scaffold pnpm + typescript + biome monorepo

  Add workspace root config (package.json, pnpm-workspace.yaml,
  tsconfig.base.json, biome.json) and line-ending discipline files
  (.gitattributes, .editorconfig, .nvmrc).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 15 min.

## Phase 1 — `packages/schema`

- **Goal**: Publish the universal `SongRecord` TypeScript type and a runtime JSON Schema validator, both consumed by crawler and web.
- **Deliverables**:
  - `packages/schema/package.json` (`"name": "@karaoke/schema"`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`).
  - `packages/schema/tsconfig.json` (extends base, `"composite": true`).
  - `packages/schema/src/index.ts` — exports `SongRecord`, `RawSongRecord`, `Category`, `KaraokeNumbers` interfaces and `songRecordSchema` (Ajv-compatible JSON Schema object) and a `validateSongRecord(value: unknown): asserts value is SongRecord` helper using `ajv` + `ajv-formats`.
  - `packages/schema/src/index.test.ts` — Vitest tests using `expectTypeOf` from `expect-type` plus runtime tests against the three worked examples in spec lines 117–146.
  - `packages/schema/vitest.config.ts`.
- **Implementation notes**:
  - `Category` is a string union: `"jpop" | "vocaloid" | "anime" | "proseka"` (spec Section Data Model).
  - `id` pattern `^[a-z0-9-]+-\d+$` (matches `blog-1596`).
  - `karaoke_numbers` keys `tj`, `ky`, `joysound` are required, values `string | null`.
  - `categories` is `minItems: 1`, `uniqueItems: true`.
  - `release_year` integer in `[1900, 2100]` or `null`.
  - `crawled_at` is ISO-8601 (`format: "date-time"`).
  - `source_url` is `format: "uri"` and required.
  - `RawSongRecord` is a partial pre-normalization shape (no `id`, no `crawled_at`, with raw cell strings).
- **Verification**:
  - `pnpm --filter @karaoke/schema test` exits 0 and reports `≥6 tests passed` (one per worked example + one per failure case: missing `source_url`, empty `categories`, bad `karaoke_numbers` shape).
  - `pnpm --filter @karaoke/schema exec tsc --noEmit` exits 0.
  - In the test output, the line for the imase record asserts `title_ko === null` and `title_romaji === null`.
- **Review pass** (`code-reviewer`):
  - Confirm JSON Schema's `additionalProperties: false` on the root and on `karaoke_numbers`.
  - Confirm the type and the schema are kept in sync (spec field-name parity: `title_primary`, `title_ko`, `title_romaji`, `artist_primary`, `artist_ko`, `release_year`, `karaoke_numbers`, `categories`, `crawled_at`, `source_url`, `id`).
  - Confirm `validateSongRecord` is an `asserts` function (not a boolean predicate) so callers get refinement.
  - Confirm `Category` does NOT include any value outside the 5 listed in the spec.
- **Commit message**:
  ```
  feat(schema): add universal SongRecord type and JSON Schema validator

  Export SongRecord, RawSongRecord, and Ajv-compatible schema. Cover the
  three spec worked examples plus failure cases for missing source_url,
  empty categories, and malformed karaoke_numbers.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 35 min.

## Phase 2 — Crawler core (no adapters)

- **Goal**: Land the source-agnostic crawler pipeline (interface, registry, HTTP client, normalization, merger, romaji predicate, CLI) before any adapter exists.
- **Deliverables**:
  - `packages/crawler/package.json` (`"name": "@karaoke/crawler"`, deps: `undici`, `cheerio`, `robots-parser`, `wanakana`, `ajv`, `ajv-formats`; devDeps: `vitest`, `@types/node`).
  - `packages/crawler/tsconfig.json`.
  - `packages/crawler/src/cli.ts` — `commander`-free hand-rolled flag parser for `--limit <n>`, `--source <slug>` (repeatable), `--out <path>` (default `apps/web/public/data/songs.json`).
  - `packages/crawler/src/pipeline.ts` — `runPipeline({ adapters, limit, outPath })`: iterates registered adapters, normalizes, dedupes via merger, validates against schema, writes `outPath.tmp` and renames.
  - `packages/crawler/src/http.ts` — undici-based fetcher with: 1 req/sec base delay, ±0.5s uniform jitter, in-process ETag/Last-Modified cache (file-backed at `.cache/http.json`), per-host `robots-parser` gate, honest UA `karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)`.
  - `packages/crawler/src/merge.ts` — `mergeRecords(records: SongRecord[]): SongRecord[]` keyed on `normalize(title_primary) + "|" + normalize(artist_primary)`. Fields `title_primary`, `title_ko`, `title_romaji`, `artist_primary`, `artist_ko`, `source_url` taken from registration-order winner; if same source, lower `crawled_at` wins. `karaoke_numbers` fields merged taking first non-null. `categories` set-unioned and re-sorted alphabetically.
  - `packages/crawler/src/normalize.ts` — exported `normalize(s: string): string` performing NFKC → `toLocaleLowerCase('und')` → strip everything outside `\p{L}\p{N}\p{M}` (use `/[^\p{L}\p{N}\p{M}]/gu`).
  - `packages/crawler/src/romaji.ts` — `needsRomaji(title: string): boolean` returns `wanakana.isJapanese(title.normalize('NFKC'))`; `toRomaji(title: string): string` returns `wanakana.toRomaji(title.normalize('NFKC'))`.
  - `packages/crawler/src/adapters/index.ts` — `Crawler` interface + empty `adapters: Crawler[] = []` array (registration order is array order). Includes a `registerAdapter(c: Crawler)` for tests.
  - Unit tests: `packages/crawler/test/normalize.test.ts`, `merge.test.ts`, `romaji.test.ts`.
- **Implementation notes**:
  - Normalize worked examples (spec Section Data Model lines 99–106): assert `normalize('DECO*27') === 'deco27'`, `normalize('ヨルシカ') === 'ヨルシカ'`, `normalize('米津玄師') === '米津玄師'`, `normalize('YOASOBI') === 'yoasobi'`, `normalize('imase') === 'imase'`, `normalize('花に亡霊 (movie ver.)') === '花に亡霊moviever'`, `normalize('Mrs. GREEN APPLE') === 'mrsgreenapple'`.
  - Romaji predicate worked examples (spec Section Frontend Romaji search): `needsRomaji('Lemon') === false`, `needsRomaji('NIGHT DANCER') === false`, `needsRomaji('Ｉｄｏｌ') === false` (post-NFKC becomes ASCII), `needsRomaji('花に亡霊 (movie ver.)') === true`, `needsRomaji('あぶく') === true`. Note: wanakana's `isJapanese` accepts ASCII space/punct as Japanese-compatible; mixed Japanese+Latin titles still return true after NFKC because they contain at least one kana/kanji.
  - Merge tests cover: (a) two sources both providing a number → both retained; (b) both sources providing the same number → first wins, no duplicates; (c) categories union deduped + sorted; (d) within-source tie broken by `crawled_at`.
  - HTTP rate limit: track last-request timestamp; sleep `1000 + (rand() - 0.5) * 1000` ms before each request. Tests for `http.ts` are skipped in CI (require network); leave a plain `// integration: run locally` comment instead.
  - CLI parser: split `process.argv.slice(2)`, simple loop, throw on unknown flag.
- **Verification**:
  - `pnpm --filter @karaoke/crawler test` exits 0 and prints `≥12 tests passed` across the three test files (5 normalize + 4 merge + 3 romaji minimum).
  - `pnpm --filter @karaoke/crawler exec tsc --noEmit` exits 0.
  - Running `node packages/crawler/dist/cli.js --help` (after `tsc -b`) exits 0 with usage text mentioning `--limit`, `--source`, `--out`.
- **Review pass** (`code-reviewer`):
  - Confirm `mergeRecords` tie-break order matches spec Section Crawler Architecture stage 3 exactly: registration-order winner first, then lower `crawled_at` for same-source ties.
  - Confirm `normalize` strips characters using a single Unicode-property regex and not a hand-rolled blacklist.
  - Confirm `http.ts` queries `robots-parser` BEFORE recording the rate-limit timestamp (rejected requests should not consume the rate-limit slot).
  - Confirm wanakana is NOT imported by anything in `apps/web/`.
  - Confirm CLI rejects unknown flags rather than silently ignoring them.
- **Commit message**:
  ```
  feat(crawler): add source-agnostic pipeline core

  Land Crawler interface, adapter registry, undici-based rate-limited
  fetcher, normalize()/merge()/romaji predicate, and CLI shell. Cover
  spec worked examples in unit tests; no adapters yet.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 90 min.

## Phase 3 — BlogCrawler adapter

- **Goal**: Implement the `jpop-playlist-blog` adapter against committed HTML fixtures, then wire it into the registry.
- **Deliverables**:
  - `packages/crawler/src/adapters/jpop-playlist-blog/parser.ts` — exports `parseArtistPage(html: string, sourceUrl: string): RawSongRecord[]`. Uses cheerio with the locked selectors from spec Section Parser contract: `div.tt_article_useless_p_margin table` (first table descendant), then `tbody > tr`, then `tr > td` (exactly 4). Splits cell 1 on `<br>`, unwraps `<strong>`/`<b>`/`<span>` before reading text. Hyphen/em-dash/en-dash → `null`. Empty / `&nbsp;`-only / whitespace-only cells → `null`.
  - `packages/crawler/src/adapters/jpop-playlist-blog/crawler.ts` — fetches `/98` and `/417`, extracts artist post URLs (`href` matching `^/\d+$`), dedupes URLs, fetches each artist page, calls parser, tags categories from index source(s) (URL appearing in both indexes ⇒ `["jpop", "vocaloid"]`), threads `RawSongRecord` to a normalizer.
  - `packages/crawler/src/adapters/jpop-playlist-blog/normalizer.ts` — maps `RawSongRecord` → `SongRecord`. Generates `title_romaji` via `romaji.ts` only when `needsRomaji(title_primary)` and source did not provide a romaji. Builds `id` as `blog-${path-id}` from the artist URL plus a per-row index suffix when multiple rows share the artist (`blog-449-0`, `blog-449-1`...).
  - `packages/crawler/src/adapters/index.ts` — append `BlogCrawler` instance to the `adapters` array.
  - `packages/crawler/test/fixtures/blog/ayase-449.html` (committed snapshot, fetched once and pretty-printed minimally to keep diff readable).
  - `packages/crawler/test/fixtures/blog/radwimps-215.html` (same).
  - `packages/crawler/test/fixtures/blog/index-98.html` (J-POP index page, used to test URL extraction).
  - `packages/crawler/test/adapters/jpop-playlist-blog/parser.test.ts` — fixture-based.
  - `packages/crawler/test/adapters/jpop-playlist-blog/normalizer.test.ts` — RawSongRecord → SongRecord mapping.
- **Implementation notes**:
  - Snapshots committed via `git add packages/crawler/test/fixtures/blog/*.html`. Capture the snapshot once locally with `curl -A "karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)" https://j-pop-playlist.tistory.com/449 > ayase-449.html`. Do not reformat the HTML — round-tripping cheerio output may break the test. Record the SHA-256 of each fixture in a sibling `.sha256` file so review can confirm immutability.
  - Index-page URL extractor: cheerio `a[href^="/"]` then filter `href` against `/^\/\d+$/`.
  - When the row's TJ/KY/JOY cell contains digits with whitespace (e.g. ` 52919 `), `trim()` before classifying. Strip ` ` first.
  - When an artist URL appears in both `/98` and `/417`, fetch once and tag categories `["jpop", "vocaloid"]` (sorted).
  - Normalizer uses `crawled_at = new Date().toISOString()` at adapter run time, not parse time, so re-running with cached pages produces a stable timestamp per run.
  - The `id` assignment: artist post `https://j-pop-playlist.tistory.com/449` → row 0 → `id: "blog-449-0"`. The schema's `id` regex must accept multiple `-` segments — verify and adjust schema in Phase 1 if not (currently `^[a-z0-9-]+-\d+$` permits this).
- **Verification**:
  - `pnpm --filter @karaoke/crawler test test/adapters/jpop-playlist-blog/parser.test.ts` passes with ≥10 records extracted from `ayase-449.html` and ≥10 from `radwimps-215.html`. Each record's `title_primary` is non-empty; for at least 80% of records `title_ko` is non-null; every record has at least one of `karaoke_numbers.tj/ky/joysound` non-null.
  - `pnpm --filter @karaoke/crawler test test/adapters/jpop-playlist-blog/normalizer.test.ts` passes with assertions: `id` matches `^blog-\d+-\d+$`; categories on a `/98`-only artist equals `["jpop"]`; categories on a `/417`-only artist equals `["vocaloid"]`; mixed artist equals `["jpop", "vocaloid"]`.
  - Index-page parser test: extracts ≥20 distinct artist URLs from `index-98.html`.
- **Review pass** (`code-reviewer`):
  - Confirm parser scopes the table lookup to `div.tt_article_useless_p_margin` and does NOT use `document.querySelector('table')`.
  - Confirm parser handles the case where `<br>` is `<br/>` or `<br>` interchangeably (cheerio normalizes — verify with a unit test).
  - Confirm hyphen normalization covers all three of `-` (U+002D), `–` (U+2013), `—` (U+2014) per spec.
  - Confirm crawler dedupes artist URLs across `/98` and `/417` BEFORE fetching, not after.
  - Confirm normalizer never invents a `title_romaji` for already-Latin titles (`Lemon` → `null`).
  - Confirm fixtures are referenced by relative paths from the test file and the SHA-256 sidecar files exist.
- **Commit message**:
  ```
  feat(crawler): add jpop-playlist-blog adapter

  Implement parser, crawler, and normalizer for the j-pop-playlist
  Tistory blog source. Cover Ayase /449 and RADWIMPS /215 with committed
  HTML fixtures; tag categories from /98 (jpop) and /417 (vocaloid).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 100 min.

## Phase 4 — End-to-end live crawl

- **Goal**: Produce the real `apps/web/public/data/songs.json` from a small live crawl and commit a sample fixture for frontend dev.
- **Deliverables**:
  - `apps/web/public/data/songs.json` (gitignored OR committed depending on size — this phase commits the full output IF ≤500 KB; otherwise commits only the sample).
  - `packages/crawler/test/fixtures/songs.sample.json` — 10 anonymized records hand-picked across `jpop`, `vocaloid`, and at least one mixed-category record. "Anonymized" here means: real records, but `id` rewritten to `sample-N` and `source_url` rewritten to the spec example URL `https://j-pop-playlist.tistory.com/1596` so accidental hot-linking from the fixture is harmless.
  - `apps/web/.gitignore` (only if `songs.json` exceeds 500 KB) listing `public/data/songs.json`.
- **Implementation notes**:
  - Run command: `pnpm --filter @karaoke/crawler start -- --source jpop-playlist-blog --limit 5 --out apps/web/public/data/songs.json`.
  - The pipeline must validate every record against `songRecordSchema` before writing. Validation failures abort with non-zero exit.
  - The sample fixture is hand-written from the live output — it is not auto-generated, to keep it stable across re-crawls.
- **Verification**:
  - After the crawl: `node -e "const r=require('./apps/web/public/data/songs.json'); console.log(r.length)"` prints a number `≥30`.
  - A one-off validation script (`packages/crawler/scripts/validate.ts`, not committed) loads the file and runs `validateSongRecord` over every entry; exit code 0.
  - `node -e "const r=require('./packages/crawler/test/fixtures/songs.sample.json'); console.log(r.length)"` prints `10`.
  - A new test `packages/crawler/test/fixtures/sample.test.ts` validates every sample record against `songRecordSchema` and asserts at least one record has `categories.length === 2`.
- **Review pass** (`code-reviewer`):
  - Confirm `songs.json` was actually produced by the crawler (not hand-edited): re-running with same cached pages should produce identical output bar `crawled_at`.
  - Confirm sample fixture's `source_url` values are stable and do not leak any private URLs.
  - Confirm no record is missing `categories` (schema would reject, but double-check the on-disk file).
  - Confirm if `songs.json` is gitignored, that decision is justified by file size (note in commit body).
- **Commit message**:
  ```
  feat(crawler): produce initial live songs.json and sample fixture

  Run --limit 5 against jpop-playlist-blog and emit songs.json. Commit a
  10-record anonymized sample fixture for frontend dev and Vitest.
  Every record validates against the JSON Schema.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 30 min (mostly waiting on crawler).

## Phase 5 — Frontend skeleton

- **Goal**: Boot an Astro static site with a search library that loads `songs.json` and builds a MiniSearch index using the spec's boosts.
- **Deliverables**:
  - `apps/web/package.json` (`"name": "@karaoke/web"`, deps: `astro`, `@astrojs/preact`, `preact`, `minisearch`, `@karaoke/schema` workspace ref).
  - `apps/web/astro.config.mjs` (`output: 'static'`, `integrations: [preact()]`, no Cloudflare adapter yet).
  - `apps/web/tsconfig.json`.
  - `apps/web/src/pages/index.astro` — header, sticky search bar shell (no JS yet), dark-mode-default styles in a top-level `<style is:global>`, loads `/data/songs.json` at runtime via fetch.
  - `apps/web/src/lib/normalize.ts` — copy of `packages/crawler/src/normalize.ts`'s `normalize()` (NOT a re-export — this file ships to the client and the crawler version pulls in Node-only deps via siblings; a pure copy avoids that). Add a unit test asserting parity with the crawler's normalize across all 7 spec worked examples.
  - `apps/web/src/lib/search.ts` — `loadIndex(): Promise<MiniSearch<SongRecord>>` with field boosts from spec Section Frontend (`title_primary: 3, title_ko: 3, artist_primary: 2, artist_ko: 2, title_romaji: 1`), `searchOptions: { fuzzy: 0.2, prefix: true }`, `processTerm: (term) => normalize(term)`. Index documents using `id` as the MiniSearch key.
  - `apps/web/src/lib/search.test.ts` — Vitest unit test loading the sample fixture and asserting basic search returns hits.
  - `apps/web/vitest.config.ts`.
  - `apps/web/public/data/songs.json` — symlink target. If Phase 4 committed the live file, leave it; otherwise copy the sample fixture into `public/data/songs.json` so dev server has data.
- **Implementation notes**:
  - MiniSearch fuzzy distance: spec says "1" — MiniSearch's `fuzzy` option is a ratio of term length, so `0.2` (~1 edit per 5 chars) approximates this. Add a code comment citing the spec deviation and the rationale.
  - Debounce (150ms) is implemented in Phase 6's component — search.ts is debounce-free.
  - normalize.ts parity test re-uses the seven worked-example assertions verbatim. Any future drift fails this test.
- **Verification**:
  - `pnpm --filter @karaoke/web build` exits 0 and produces `apps/web/dist/index.html` (assert with `test -f apps/web/dist/index.html`).
  - `pnpm --filter @karaoke/web test` runs `search.test.ts` and `normalize.test.ts`. Search test asserts that the query `"yoasobi"` (or whichever sample record exists) returns ≥1 hit with `id` matching one of the sample records. Normalize parity test asserts all 7 spec examples agree with the crawler's normalize.
  - Running `pnpm --filter @karaoke/web dev` (manually, not in CI) and visiting `http://localhost:4321` shows a page that fetches `/data/songs.json` (verify in browser devtools network tab).
- **Review pass** (`code-reviewer`):
  - Confirm `apps/web/src/lib/normalize.ts` does NOT import from `packages/crawler/`.
  - Confirm MiniSearch boosts exactly match spec values (3,3,2,2,1).
  - Confirm `output: 'static'` in `astro.config.mjs`.
  - Confirm `apps/web` does not depend on `wanakana` or `cheerio` (crawler-only deps).
  - Confirm the parity test would actually fail if crawler-side normalize drifted.
- **Commit message**:
  ```
  feat(web): scaffold astro static site with minisearch index

  Add Astro + Preact island setup, search.ts (MiniSearch with spec
  boosts 3/3/2/2/1, fuzzy 0.2, prefix), and a client-side normalize.ts
  parity-tested against the crawler's normalize.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 60 min.

## Phase 6 — Search UI

- **Goal**: Ship the interactive search experience: search box, category chips, result cards with click-to-copy.
- **Deliverables**:
  - `apps/web/src/components/SearchBox.tsx` — Preact island. 150ms debounce via `setTimeout`/`clearTimeout`. Calls into `search.ts`. Exposes results via a custom event or shared store (use `nanostores` if a store is needed; otherwise lift state to a single root island `App.tsx`).
  - `apps/web/src/components/App.tsx` — the single-island root that owns `query`, `selectedCategories`, `results`. Renders SearchBox, CategoryChips, and ResultCard list.
  - `apps/web/src/components/CategoryChips.tsx` — three chips (`jpop`, `vocaloid`, `anime`) with toggle state. Selected set acts as AND filter on the hit set: a record is shown only if every selected chip is in `record.categories`. `proseka` is NOT rendered as a chip.
  - `apps/web/src/components/ResultCard.tsx` — bilingual title/artist, year, category tags, three monospace badges. Each badge is a `<button>` that calls `navigator.clipboard.writeText` and shows a 1-second "복사됨" toast. Missing values render dimmed em-dash. "Source ↗" link points to `record.source_url`.
  - `apps/web/src/data/featured.ts` — exports `featured: { jpop: string[]; vocaloid: string[]; anime: string[] }` listing 6 artist names per category. Used on the empty (no-query) state.
  - `apps/web/src/components/EmptyState.tsx` — shows featured artists; clicking one populates the search box.
  - `apps/web/src/components/NoResults.tsx` — bilingual "검색 결과가 없습니다 / 該当なし" + v2 hint.
  - Update `apps/web/src/pages/index.astro` to mount `<App client:load />`.
  - `apps/web/src/lib/search.test.ts` — extend with two new tests:
    - `query "abuku" matches a record with title_primary "あぶく"` (proves romaji index path; requires sample fixture to include such a record — add it in Phase 4 if missing, or skip the test with a gating record present).
    - `category filter is AND, not OR`: with selected `{jpop, anime}`, a record with `categories: ["jpop"]` does NOT match; a record with `categories: ["jpop", "anime"]` does match.
- **Implementation notes**:
  - Top 50 cap: `results.slice(0, 50)`.
  - The romaji search test depends on the sample fixture containing a record whose `title_primary` is in Japanese script and whose `title_romaji` is generated. If Phase 4's sample doesn't include one, augment the sample in this phase BEFORE adding the test (commit fixture change in same phase).
  - Click-to-copy uses optional chaining for older browsers without `navigator.clipboard`; fall back to a hidden textarea + `document.execCommand('copy')` only if needed (not required by spec — note as future-work in code comment if skipped).
  - Featured artists list: use names that exist in the live `songs.json` so clicking a featured chip yields hits.
- **Verification**:
  - `pnpm --filter @karaoke/web test` exits 0; the romaji test passes (`query "abuku"` returns ≥1 hit) and the AND filter test passes both branches.
  - `pnpm --filter @karaoke/web build` exits 0 and `dist/_astro/*.js` exists (Astro emits client islands here).
  - Manual: `pnpm --filter @karaoke/web dev`, type `"yoasobi"`, observe ≥1 result card; click a number badge, observe clipboard contains the digits.
- **Review pass** (`code-reviewer`):
  - Confirm CategoryChips only renders the three chips listed in spec Section Frontend (`jpop`, `vocaloid`, `anime`); `proseka` MUST be absent from chip JSX even if present in data.
  - Confirm AND-filter logic: `selectedCategories.every(c => record.categories.includes(c))`.
  - Confirm 150ms debounce is implemented per-keystroke (not a fixed interval poll).
  - Confirm click-to-copy uses `navigator.clipboard` (modern path) and fires on the `<button>` click handler.
  - Confirm dark mode is the default — no media-query gating; use a `data-theme="dark"` on `<html>` or equivalent.
  - Confirm result cap is 50.
- **Commit message**:
  ```
  feat(web): add search box, category chips, and result cards

  Single-island App.tsx mounts SearchBox, CategoryChips (jpop/vocaloid/
  anime), and ResultCard. Chips are AND-filtered, debounce is 150ms,
  badges are click-to-copy, results capped at 50.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 90 min.

## Phase 7 — GitHub Actions

- **Goal**: Automate a weekly crawl PR and a per-push deploy to Cloudflare Pages.
- **Deliverables**:
  - `.github/workflows/crawl.yml`:
    - Triggers: `schedule: - cron: '0 18 * * 0'` and `workflow_dispatch` with optional `limit` input (default `0` → no limit).
    - Steps: checkout, setup-node@v4 with `node-version-file: '.nvmrc'`, setup-pnpm, restore cache for `.cache/http.json` keyed by `crawl-http-${{ github.run_id }}` with restore-keys `crawl-http-`, run `pnpm install --frozen-lockfile`, run `pnpm --filter @karaoke/crawler start -- --limit "${{ inputs.limit || 0 }}" --out apps/web/public/data/songs.json.tmp`, run a node one-liner that renames `.tmp` → `songs.json` only on success.
    - Index-page failure handling: the crawler's own non-zero exit aborts the step. Artist-page <90% success budget is also enforced inside the crawler (Phase 2/3 guarantees this).
    - PR step: install `gh`, run `gh pr list --label crawl-output --state open --json number -q '.[].number' | xargs -r -n1 gh pr close`, then `gh pr create --label crawl-output --title "data: weekly crawl ${{ github.run_id }}" --body "Automated crawl output"`. Use `peter-evans/create-pull-request@v6` with `labels: crawl-output` as a robust alternative.
    - Save updated cache.
  - `.github/workflows/deploy.yml`:
    - Trigger: `push: branches: [main]`.
    - Steps: checkout, setup-node, setup-pnpm, install, `pnpm --filter @karaoke/web build`, then `cloudflare/pages-action@v1` with `apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}`, `accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`, `projectName: karaoke-search`, `directory: apps/web/dist`.
  - `.github/labels.yml` (optional) for the `crawl-output` label, applied via a one-time `gh label create crawl-output` command documented in plan body.
- **Implementation notes**:
  - The atomic rename pattern: write to `songs.json.tmp`, then `mv songs.json.tmp songs.json`. If the crawler exits non-zero, the rename never happens and `songs.json` retains its previous content.
  - Concurrency on `crawl.yml`: add `concurrency: { group: crawl, cancel-in-progress: false }` so manual + scheduled runs serialize.
  - The `gh pr list ... | xargs ... gh pr close` chain runs BEFORE the new PR is created, satisfying spec "at most one open crawl PR".
- **Verification**:
  - `git push origin main` then `gh workflow list` lists `crawl.yml` and `deploy.yml` (exit code 0; both names appear in stdout).
  - Trigger crawl manually: `gh workflow run crawl.yml -f limit=3`. Within 10 minutes, `gh run list --workflow=crawl.yml --limit 1 --json conclusion -q '.[0].conclusion'` prints `"success"`.
  - After the manual trigger: `gh pr list --label crawl-output --state open --json number -q 'length'` prints `1`.
  - `gh run list --workflow=deploy.yml --limit 1 --json conclusion -q '.[0].conclusion'` prints `"success"` after the next push to main.
- **Review pass** (`code-reviewer`):
  - Confirm `crawl.yml` does NOT push directly to `main` — it always opens a PR.
  - Confirm `deploy.yml` only triggers on `main` (not on PR pushes), so crawl PRs do not preview-deploy unintentionally.
  - Confirm the PR-cleanup step closes prior `crawl-output` PRs BEFORE creating the new one.
  - Confirm secrets are referenced via `${{ secrets.* }}` and never echoed.
  - Confirm cache key includes a stable component (so cache is reusable across runs) AND a per-run component (so updates do not collide).
  - Confirm `concurrency:` group on crawl.yml.
- **Commit message**:
  ```
  ci: add weekly crawl PR and cloudflare pages deploy workflows

  crawl.yml runs Sundays 03:00 KST and on dispatch, atomically renames
  songs.json.tmp, closes prior crawl-output PRs, opens a new one.
  deploy.yml builds @karaoke/web and ships to Cloudflare Pages on push
  to main.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 60 min.

## Phase 8 — Playwright e2e smoke

- **Goal**: Prove the deployed site responds and the search-to-card pipeline works end-to-end.
- **Deliverables**:
  - `apps/web/playwright.config.ts` — base URL from `process.env.E2E_BASE_URL`; single project `chromium`; `testDir: 'tests/e2e'`.
  - `apps/web/tests/e2e/search.spec.ts` — single test: navigate to base URL, locate the search input by `aria-label`, type `"yoasobi"`, wait for at least one element matching `[data-testid="result-card"]`, assert that within that card at least one of `[data-testid="badge-tj"]`, `[data-testid="badge-ky"]`, `[data-testid="badge-joysound"]` has visible non-em-dash text.
  - `apps/web/package.json` — add `@playwright/test` devDep and `test:e2e` script: `playwright test`.
  - Add `data-testid` attributes to ResultCard and badges in Phase 6 components (file-touch in this phase if missing).
- **Implementation notes**:
  - Browsers are installed via `pnpm exec playwright install chromium` either locally or in a follow-up CI workflow (out of scope for this phase per spec — just a manual test step).
  - The test reads `E2E_BASE_URL` and skips with a clear message if unset.
  - Use `expect(card.locator('[data-testid^="badge-"]')).toContainText(/\d/)` to assert at least one badge has digits.
- **Verification**:
  - `E2E_BASE_URL=https://karaoke-search.pages.dev pnpm --filter @karaoke/web test:e2e` exits 0 and the report shows `1 passed`.
  - The Playwright HTML report stored under `apps/web/playwright-report/` shows the screenshot of a result card with at least one numeric badge.
- **Review pass** (`code-reviewer`):
  - Confirm the test fails loudly (not skips) if the deployed page fails to load.
  - Confirm the test does not depend on a specific song existing — `"yoasobi"` is high-traffic enough that any reasonable crawl hits it; document this assumption in a comment.
  - Confirm `data-testid` attributes are added in Phase 6 components, not synthesized by selector strings that could collide with future class names.
  - Confirm `playwright.config.ts` uses `chromium` only (spec asks for one smoke test, not cross-browser).
- **Commit message**:
  ```
  test(web): add playwright e2e smoke against deployed site

  Single test: load E2E_BASE_URL, query "yoasobi", assert ≥1 result
  card with at least one numeric karaoke badge (TJ/KY/JOYSOUND).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 35 min.

## Phase 9 — Accessibility & error handling polish (optional)

- **Goal**: Tighten a11y, add a small bundle-size guard, and harden the songs.json fetch path.
- **Deliverables**:
  - Update `SearchBox.tsx` with `aria-label="가라오케 검색"` and `role="searchbox"`.
  - Update `CategoryChips.tsx` with `role="group" aria-label="카테고리 필터"`; each chip is a `<button aria-pressed={selected}>`. Keyboard nav: arrow-left/arrow-right cycles focus among chips.
  - Update `ResultCard.tsx`: container is `<article>`; badges have `aria-label="TJ 번호 복사"` etc. Cards are reachable via Tab; Enter on a focused badge fires the same copy action.
  - Update `App.tsx`: results count rendered with `aria-live="polite"` (e.g., `<span aria-live="polite">{results.length}건</span>`).
  - `apps/web/src/lib/search.ts`: wrap the `/data/songs.json` fetch in a single retry with 1-second backoff; on JSON-parse failure, surface a friendly error string via the App store; render a localized error component (`apps/web/src/components/ErrorState.tsx`).
  - `apps/web/scripts/check-bundle-size.mjs` — post-build script that gzip-sizes the largest JS chunk in `apps/web/dist/_astro/` and exits non-zero if any chunk exceeds 50 KB gzipped.
  - Wire bundle check into the `build` script via a `postbuild` hook.
  - `apps/web/tests/e2e/a11y.spec.ts` — uses `@axe-core/playwright` to scan the deployed page; asserts `violations.length === 0`.
- **Implementation notes**:
  - Use `node:zlib`'s `gzipSync` on the file buffer for the size check; round to integer bytes.
  - The retry path: on first failure (network error or non-2xx), wait 1000ms, retry once; on second failure, set error state. Do NOT retry on `200 OK` with malformed JSON — that is a deterministic failure.
  - axe-core scan is run only when `E2E_BASE_URL` is set. CI integration deferred (this is a manual gate per spec's "optional" framing).
- **Verification**:
  - `pnpm --filter @karaoke/web build` exits 0 AND the `postbuild` size check exits 0 with stdout `largest chunk: <N> KB gzipped (limit 50 KB)` where `N < 50`.
  - `E2E_BASE_URL=https://karaoke-search.pages.dev pnpm --filter @karaoke/web test:e2e tests/e2e/a11y.spec.ts` exits 0 and reports `0 axe violations`.
  - Manual: in devtools, throw on `fetch('/data/songs.json')` once; observe one retry in network tab and absence of an error message; throw twice; observe ErrorState component renders.
- **Review pass** (`code-reviewer`):
  - Confirm `aria-live="polite"` is on a region that updates only when results count changes (avoid spam from intermediate states).
  - Confirm keyboard-nav handlers do not steal focus from the search input.
  - Confirm bundle-size check measures gzipped size, not raw, and walks `_astro/*.js` (Astro's island chunk dir).
  - Confirm fetch retry is exactly one extra attempt (not exponential, not infinite).
  - Confirm axe scan runs against the deployed URL, not localhost.
- **Commit message**:
  ```
  feat(web): a11y polish, fetch retry, and 50KB bundle guard

  Add ARIA labels and keyboard nav, retry songs.json once on transient
  failure, render ErrorState on hard failure, and fail builds if any
  JS chunk exceeds 50 KB gzipped. Add axe-core e2e scan.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 60 min.

## Open Questions

None at plan-write time.
