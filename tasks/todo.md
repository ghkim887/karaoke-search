# JOYSOUND Deploy-Ready — Plan of Record (final)

**Goal:** JOYSOUND candidate → deploy-ready (spec §5). Branch `feat/joysound-full-catalog-sweep`. No git commits until owner approves. Remote D1 import out of scope.

## Outcome
- **CODE: deploy-ready** (WS-A/WS-B done+reviewed; WS-C classifier foreign-name fix in final review). 
- **DATA: requires a detail-fetching crawl** — the authoritative foreign-language signal (`songNameForeign`/`artistNameForeign`) lives only on the per-song detail response; the cached listing sweep can't carry it. Listing-sweep candidate = report-only.

## Workstreams
- **WS-A — D1 SQL streaming:** ✅ done + review CLEAN; proved at 236k scale (946 MB SQL, no OOM).
- **WS-B — full API-first (worker + frontend):** ✅ done + both review CLEAN. Non-blocking polish + `deploy.yml` e2e-fallback deferred.
- **WS-C — Layer-2 adjudication + classifier:** ✅ C1–C8 (175 ALLOW recovered, 0 DROP, pipeline GREEN). Layer-3 surfaced foreign-leak (92.5%) → katakana fix (98%) → REVERTED for the authoritative **detail foreign-name signal** (resolves admit-jpop-kana leak + drop-han/ascii over-drop). ✅ foreign-name fix review CLEAN (608+95 tests).
- **WS-D — verification + runbook:** Layer-1 ✅, Layer-2 ✅, Layer-3 precision resolved (applies at detail-crawl time), D5 SQL dry-run ✅, runbook ✅ (`docs/superpowers/runbooks/2026-06-09-joysound-deploy.md`).

## Owner decisions — status (updated 2026-06-11)
1. ~~**CHECKPOINT 1**~~ ✅ RESOLVED 2026-06-10: 175 ALLOW 전수 에이전트 검증 → SUSPECT 3건 제거 (175→172, `tasks/checkpoint1-screening.md`).
2. **Commit approval:** STILL OPEN — in-flight 작업이 더 늘었음 (오버라이드 3건 제거, 스윕/빌더 detail 임베드, detail.ts 장르/타이업/apl 파서 버그 수정). 크롤 완료 후 일괄 커밋 권장.
3. ~~**Data-crawl path**~~ ✅ RESOLVED 2026-06-10: (A) 선택 — full detail crawl 진행 중 (`.tmp_review/joysound-detail-sweep-20260610/`, 장르/타이업 임베드 모드, 초기 50,490행은 백필 후보).

## Deferred deploy-time checks (updated)
- ~~`deploy.yml` e2e fallback build~~ ✅ DONE (PR #35, main에서 2회 통과).
- D1 500 MB: 측정 생략하고 곧장 self-host 권장 (베이스라인 25.8k만으로 SQLite 392 MB). **Self-host 타깃 확정: hermes-host (Tailscale)** — 계정명 확인부터 재개 (`tasks/todo-structural-improvements.md` 참조).
- 데이터 토폴로지 ✅ DECIDED + 인프라 완료 (PR #36/#38: publish/fetch + full-corpus.yml + manifest 게이트).
- WS-B frontend polish: 여전히 deferred. committed songs.json 25,842 baseline 유지: 확정 (토폴로지 결정의 일부).

## Key knowledge (memory)
`reference-joysound-api-fields` (185-field schema), `project-joysound-layer3-findings` (foreign-name signal), `feedback-prefer-precise-signal-over-heuristic`.

## Review — three precision refinements (2026-06-09, TDD)

All RED→GREEN; full crawler suite 635/635 + scripts 95/95; build + biome clean. No commit.

- **A1 — `artistNameForeign` → `artist_aliases`** (cross-script recall):
  - `normalizer.ts`: `buildArtistAliases(artistPrimary, detail)` emits the native name into `artist_aliases` when present, ≠ `artist_primary`, and not a pure-kana echo. Field omitted when empty (schema prefers absence).
  - `aliases.ts` PROPAGATION INVARIANT: **(a)** preservation verified — bare records pass through with `artist_aliases` intact; re-key path unions (`existing ?? []`). **(b)** widened — `aliasesByCanonical` + `aliasMap` now seeded from adapter-emitted `artist_aliases` (via shared `seedAliasMap` + `addAliases`), keyed on the record's own `artist_primary`. Collision rule preserved (one alias → two canonicals = untouched + warn). Documented "self-canonical wins over re-key" precedent kept.
- **C1 — dotted-pinyin `*ForeignSearch` as corroborating chinese tell**:
  - `types.ts`+`detail.ts`: added/parsed `songNameForeignSearch`/`artistNameForeignSearch` (reuse `coerceForeign`).
  - `classifier.ts` `foreignNameSignal`: appended a `RE_DOTTED_PINYIN` (`^(?:[a-z]+\.)+$`) check AFTER Hangul/Han rules — adds chinese only, never overrides korean, inert on empty/JP rows.
- **C2 — `artistNameForeign` into the drop-list scan**: `classifier.ts` pushes `detail.artistNameForeign` into `artistFields`, so the existing foreign-act gate matches the NATIVE name. Ordering (reviewed-allow → foreign-name signal → drop-list) unchanged; inert without detail.
