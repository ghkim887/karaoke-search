# JOYSOUND Deploy Runbook (2026-06-09)

**Status:** CODE deploy-ready (pending review + commit). DATA candidate requires a detail-fetching crawl (see §3). Remote D1 import is manual + out of scope to execute (owner-decided).

## 0. TL;DR
The full-catalog FP/FN sweep + the deploy-readiness work landed three code workstreams (all reviewed CLEAN) and surfaced — then resolved — the foreign-language precision problem with an **authoritative detail-API signal** (`songNameForeign`/`artistNameForeign`). The catch: that signal lives only on the per-song **detail** response, so the **deployable JOYSOUND corpus must come from a detail-fetching crawl**, not the cached listing sweep (which was always report-only). The listing-sweep candidate (221k–236k records) is a report artifact; the production candidate is produced by a full crawl where the classifier sees detail and applies the signal for free.

## 1. Quality gates (spec §5)
- **Layer 1 (hard gates):** PASS on the report candidate — 0 removed / 0 unexpected mutation / 0 dup ids / 0 schema-invalid / sameSongDup regression 1 (pre-existing MISIA).
- **Layer 2 (FP/FN adjudication):** PASS — 3,125 P0/P1 adjudicated (175 ALLOW recoveries, 0 DROP), 0 un-adjudicated, foreignActAdmitted ⊆ the 175 ALLOW (0 un-adjudicated foreign). Review CSV at `.tmp_review/joysound-sweep-2026-06-09/adjudication/joysound-adjudication-review.csv` (BOM) — **CHECKPOINT 1: owner spot-check the 175 ALLOW before committing the overrides**.
- **Layer 3 (sampling):** admit precision on the LISTING sweep was 92.5% → 98.0% (katakana heuristic, since reverted); the **authoritative foreign-name signal** (applied at detail-crawl time) is the real fix — perfect separation on the probe set, 0 FP on 120 JP controls. Recall: 99.04% among numbers the sweep saw. The detail signal also recovers the drop-han-only / drop-ascii-only over-drops (`admit-jp-detail`).

## 2. Code changes to commit (all reviewed CLEAN unless noted; explicit-path commits)
- **WS-A — D1 SQL streaming** (beats V8 string limit at 236k; proved at scale: 946 MB SQL, no OOM): `packages/data-store/src/index.ts`, `packages/data-store/src/cli.ts`, `packages/data-store/test/sqlite-store.test.ts`, `apps/worker/scripts/{export-d1-sql.mjs,import-d1-remote-chunked.mjs,report-d1-sql-metrics.mjs}`, `apps/worker/test/d1-workflow.test.ts`.
- **WS-B — full API-first** (worker batch-by-id + multi-vendor; frontend gates loadIndex to offline-only, favorites/multi-vendor via API): `apps/worker/src/index.ts`, `apps/worker/test/search.test.ts`, `apps/web/src/lib/search.ts`, `apps/web/src/components/App.tsx`, `apps/web/src/lib/search.test.ts`, `apps/web/src/components/App.test.tsx`.
- **WS-C — classifier + adjudication tooling**: `packages/crawler/src/adapters/joysound-official/{classifier.ts (foreign-name signal + admit-jp-detail; katakana gate reverted), detail.ts, types.ts, reviewedJoysoundOverrides.ts (175 ALLOW — gated on CHECKPOINT 1)}`, the new joysound-official tests (`classifierForeignName.test.ts`, `reviewedJoysoundOverrides.test.ts`, `detail.test.ts` additions), and `scripts/{adjudicate_joysound_via_agents.mjs(+test), sample_joysound_admits.mjs, joysound_adjudication_worker_prompt.md}`.
- **Docs/tracking:** `docs/superpowers/specs/2026-06-09-joysound-full-catalog-sweep-design.md` (already tracked), this runbook, `tasks/todo.md`.
- **Do NOT commit** `apps/web/public/data/songs.json` as the 236k candidate (would break `ci.yml` `d1:verify-sql` + Cloudflare Pages 25 MB/file cap). Keep the committed corpus at the 25,842 baseline.

## 3. Producing the deployable DATA candidate (the operational step)
The foreign-name signal requires per-song detail. The cached listing crawl (293,940 rows, 9 fields) has no foreign field.
1. Run a **full detail-fetching JOYSOUND crawl** (the production `JoysoundOfficialCrawler` / planned `JoysoundFullCatalogCrawler`, opt-in via `--source joysound-official`). At ~0.55–0.6 s/song (measured, no throttling) a ~291k full catalog is ~2 days wall; the admit-relevant subset is less. Network-bound (~1% CPU) — safe to run as a long background job; disable host sleep.
2. The classifier applies the foreign-name DROP gate (foreign-korean/foreign-chinese) + `admit-jp-detail` recovery automatically because detail is present. reviewed-allow (175) still admits.
3. Merge/replay → candidate corpus → schema-validate.
4. **D1 SQL via the streamed path** (WS-A): `node --max-old-space-size=8192 apps/worker/scripts/export-d1-sql.mjs --input <candidate.json> --output <scratch.sql>` (default input is the 25.8k corpus — MUST pass `--input`). Then `report-d1-sql-metrics.mjs <sql> --json` (max-statement ≤ 100 KB gate).
5. **Remote D1 import** (manual, ~2k+ chunks, guarded by `KARAOKE_D1_REMOTE_OK=1`): `d1:import:remote`. Long, non-atomic — monitor.
6. **Worker deploy** (`deploy:remote`) + **web deploy** (Pages, API-first; `deploy.yml` sets `PUBLIC_KARAOKE_API_BASE_URL`).

## 4. Deferred deploy-time CHECK items (NOT blockers; owner)
- **500 MB free-tier D1 cap vs ~221k+ records** (SQL ~946 MB): measure `wrangler d1 info --remote` post-import; overflow escape = **self-hosting** (self-host search API exists, commit `008d453`; `serve:node`). The owner plans self-hosting — this is the expected path.
- **`deploy.yml` e2e must build in FALLBACK mode** (no `PUBLIC_KARAOKE_API_BASE_URL`) so e2e tests the offline MiniSearch path without a live worker (full API-first removed the bundled fallback at runtime). NOTE (2026-06-10 correction): e2e is a **required gate** since `f260f53` (2026-06-02 removed `continue-on-error`; `deploy` job `needs: [build, e2e]`) — a red e2e blocks deploys, so this item must land BEFORE or WITH the API-first deploy, not after.
- **WS-B frontend polish** (non-blocking): favorites partial-unfavorite refetch/stale-card (intersect apiFavorites∩favoriteIds + skip refetch on subset); memoize favorites query index; worker-outage "degraded" banner.
- **`reviewedJoysoundOverrides` CHECKPOINT 1** CSV spot-check before committing the 175 ALLOW.

## 5. Follow-ups
- After the detail crawl, re-run Layer-3 sampling on the detail-classified admits to confirm ≥99% (the foreign-name signal should clear it).
- Optional: foreign-artist drop-list is now unnecessary (the detail signal supersedes it).
- The 185-field JOYSOUND detail schema is documented (memory `reference-joysound-api-fields`); other discarded signals (genreList, tieupList, songinfoList for anime tagging; outsideUrlInfo links) are available if needed later.
