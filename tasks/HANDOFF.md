# 세션 핸드오프 — JOYSOUND 머지 + Cloudflare 제거 (2026-06-13)

다음 세션이 stale 요약이 아니라 디스크/git의 실제 상태에서 이어가도록 작성. 모든 사실은 이 세션 종료 시점 system-of-record 기준.

## Active goal
JOYSOUND 263k 풀카탈로그를 프로덕션에 올리기. **코드는 전부 main에 머지 완료 + Cloudflare 경로 완전 제거** — 남은 건 데이터 Release 발행과 셀프호스트(hermes) 배포뿐.

## Current state of record
- **Repo/path**: `C:\Users\kmend\Desktop\karaoke`
- **Branch/HEAD**: `main` @ `5cb5d3b` == origin/main. 워킹 트리 **클린**. 워크트리는 메인 체크아웃 1개뿐.
- **브랜치**: 로컬·원격 모두 `main` + `feat/joysound-audit-harness`(오너가 보존 선택, draft **PR #15** open)만 남음. 그 외 전부 정리됨(머지 3개 원격 삭제, 폐기물 d1-search-index-hardening·prune-dead-code·백업 2개 삭제, stale crawl **PR #17 closed** + 브랜치 삭제).
- **Cloudflare: 계정 리소스까지 삭제 완료** — D1 `karaoke-songs`(2b0c76a1, 420MB) 삭제, 워커 `karaoke-search-api` 삭제(workers.dev 404 확인). repo에 wrangler/miniflare 의존 0.
- **라이브 사이트**: GitHub Pages, **오프라인 MiniSearch 폴백 모드**(25.8k 번들)로 배포됨 — 배포 자산에 workers.dev 참조 0건 확인. 셀프호스트가 뜨기 전까지 의도된 상태.
- **Key artifacts**: 후보 코퍼스 `.tmp_review/joysound-detail-sweep-20260610/songs-candidate.json` — **263,222 records**, 101,173,840 bytes, 2026-06-13 00:53 (폴드 적용 dist로 빌드된 최종본). 드라이런 매니페스트의 263,230은 **폴드 이전 수치 + stale baseline(48f393c)** — 실발행 때 재계산 필수.

## Completed evidence (이 세션)
1. **머저 dash-fold** `050cdfd`: Tier B/C 키 폴딩 + same-source 게이트. author-reviewer 2라운드 APPROVE; 델타 게이트 2회 — 커밋 코퍼스엔 바이트 동일 no-op, 263k 후보 통제 재빌드에서 폴드 기인 융합 **정확히 8건 전수 검수 전부 정상**(역분리 0). 크롤러 669 tests green.
2. **PR #39 머지** (main `95db1b0`): JOYSOUND 스윕 22커밋 (洋楽 veto 분류기, 오버라이드 173/2, D1 스트리밍(→#40에서 삭제됨), 워커/웹 API-first, 스윕·리플레이·빌더 스크립트, dash-fold). CI green.
3. **PR #40 머지** (main `5cb5d3b`): `refactor!: remove the Cloudflare Workers + D1 deploy path` (30파일 +271/−2709). author-reviewer 2라운드(1차에서 pre-#39 베이스 블로커 발견→리베이스+스트리밍 export 삭제 확장) APPROVE. **CI 코퍼스 게이트 = `pnpm --filter @karaoke/worker sqlite:build`** (`validateSongCorpus` 동일 엄격성 + 신규 0-record fail-fast; 25,842곡/392MB로 실검증). 메타핀 테스트 `apps/worker/test/ci-pipeline-pins.test.ts`. 머지 후 Pages 배포 green.
4. 로컬 CLAUDE.md(untracked) + 메모리(`project_joysound_crawl_and_pr3`) 갱신됨.

## Open items
- **Blockers (오너 입력 필요)**:
  1. **hermes-host 리눅스 계정명** (Tailscale 100.84.84.57) — 셀프호스트 배포의 유일한 블로커. 배포 후 `deploy.yml`에 `PUBLIC_KARAOKE_API_BASE_URL`을 **브라우저 도달 가능 URL**(Tailscale Funnel 등 공개 노출 필요)로 설정해야 API 모드 복귀.
  2. **데이터 Release 발행 승인**: `gh release create data/<날짜>` + full-corpus.json(101MB) → `gh workflow run full-corpus.yml -f release_tag=… -f baseline_commit=5cb5d3b` → 매니페스트 PR 머지. **매니페스트는 263,222로 재계산** (드라이런 수치/baseline 모두 stale).
- **Risks**: 후보를 머저로 재실행하면 폴드 무관 2차-패스 dupe 21건이 추가 융합됨(main에도 있는 기존 동작) — 발행 파이프라인에 리플레이 1회 끼우면 자연 해소, 안 끼우면 263,222 그대로도 무해.
- **Deferred**: OPM/무장르 잔여 꼬리(≤1k) 큐레이션; WS-B 프론트 폴리시; `D1DatabaseLike`/`D1_SCHEMA_SQL` 이름 정리(코스메틱, OPEN-QUESTIONS에 등재); `.tmp_review` 2GB 아카이브-후-삭제; `tasks/todo-structural-improvements.md`의 구조 백로그.
- **Stale/superseded**: 이 파일의 직전 버전(2026-06-12, "커밋 안 됨" 상태 서술) — 전부 머지로 해소됨. `feat/joysound-audit-harness`(PR #15 draft)는 main의 detail-sweep 감사 툴링과 기능 중복 — 재개하려면 먼저 main 대비 가치 재평가.

## Next first action
1. 오너에게서 hermes 계정명 받기 → `docs/superpowers/runbooks/2026-06-09-joysound-deploy.md` §3-4 순서로 셀프호스트 배포 (`sqlite:build`를 후보 코퍼스로, `serve:node`).
2. 또는 데이터 먼저: `node scripts/publish-full-corpus.mjs` 경로로 Release 발행 (매니페스트 재계산 포함 — 후보 파일 그대로 쓰되 카운트/sha/baseline을 5cb5d3b 기준으로).
