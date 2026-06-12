# 구조 개선 일괄 실행 (2026-06-10)

전체 레포 구조 분석(4-에이전트 스윕) 후 사용자 지시: "내 결정 없이 진행할 수 있는 것 전부 진행".
기존 `todo.md`(JOYSOUND deploy plan-of-record)는 별도 트랙 — 건드리지 않음.

## 제외 (사용자 결정 필요 / in-flight 파일 충돌)

- JOYSOUND 머지 후 데이터 토폴로지 결정 (corpus out-of-git, D1-only 검색) — 전략 결정
- App.tsx 훅 추출 / search.ts 분리 — 워킹트리 수정 중 파일
- data-store↔worker 공유 상수 `@karaoke/search` 이동 — worker/src/index.ts 수정 중
- JOYSOUND classifier gate-배열 재구조화 / 드롭리스트 `curated/` 승격 — classifier.ts 수정 중
- scripts/data chunk-00..06 input 삭제 — 미발송 Stage 2 입력, 폐기는 사용자 결정
- reviewedJoysoundOverrides 메타데이터 백필 — 파일이 워킹트리 수정 중 (TJ 쪽만 진행)

## Phase 0 — 메인 스레드 즉시 (현재 트리의 untracked/ignored 문서)

- [x] runbook §4 stale 수정 (e2e는 f260f53 이후 필수 게이트 — 수정 완료)
- [x] CLAUDE.md stale 수정 (Python 헬퍼 위치 scripts/lib/, e2e 게이트, 커밋 트레일러 Fable 5)
- [x] 고아 로그 삭제 (scripts/data/local-weekly-pipeline-52510.log, untracked UTF-16 transcript)

## Phase 1 — 병렬 author 에이전트 (origin/main 기반 worktree → 각각 PR)

- [x] **PR-A: 테스트/CI 배선 강화** — 리뷰 CLEAN → **PR #22** https://github.com/ghkim887/karaoke-search/pull/22 (worktree: karaoke-wt-pra)
- [x] **PR-B: HTTP 캐시 배칭 + 호스트별 opt-out** — 리뷰 2라운드 반영(flush 재시도 보존 + flushInFlight 직렬화) → **PR #25** https://github.com/ghkim887/karaoke-search/pull/25
- [x] **PR-C: 레포 하이진** — 리뷰 CLEAN → **PR #23** https://github.com/ghkim887/karaoke-search/pull/23 (worktree: karaoke-wt-prc)

## Phase 2 — 병렬 진행 중

- [x] **PR-D: TJ reviewed-override 메타데이터 백필** — 121/121 백필, 동작 동일성 증명, 리뷰 CLEAN + 하드닝 3건 반영 → **PR #24** https://github.com/ghkim887/karaoke-search/pull/24
- [x] **PR-E: replay-merger.mjs 테스트화** — runReplay() 추출, 8 게이트 테스트, byte-identical 증명, 심링크 main-guard 하드닝(정션으로 실증) → **PR #26** https://github.com/ghkim887/karaoke-search/pull/26
- [x] **PR-F: 파이프라인 러너 추출** — 11스텝 추출 + composer 스크립트화, e2e 검증(corpus 사본 10스텝 green + 멱등 byte-identical), 리뷰 2라운드 CLEAN → **PR #27** https://github.com/ghkim887/karaoke-search/pull/27
- [ ] **PR-G: vitest config 공통화 + CI setup composite action** — PR #22 머지 후 (충돌 회피로 보류)
- [ ] (검토) Python 패리티 기계 철거 — PR-F 머지 후 (crawl.yml/README 충돌 회피)

## 레포 클린업 (2026-06-10, 크롤 병행)

- [x] 로컬 정크 삭제: .cache 스크래치 7개, .pytest_cache, __pycache__, .omc 리포트, 옛 brainstorm 세션 (~수 MB)
- [x] .tmp_review 재생성분 삭제: 1.08 GB D1 SQL 드라이런 + PRE-KATAKANA 후보/layer3 스냅샷 (~1.2 GB 확보; CHECKPOINT 1 CSV·진행 크롤 보존)
- [x] **PR #34** docs: 통합 문서 3종 신설(ARCHITECTURE / PROJECT-KNOWLEDGE / OPEN-QUESTIONS) + README de-stale(8건) + Stage-2 프롬프트 categories 제거(살아있는 버그) + howto 갱신 + 죽은 spec 주석 8/10 repoint(2건은 in-flight 파일이라 피처 브랜치에서) + chunk-input 8개 git rm + **tj-25863 사이드카 공백 버그 수정**(수동 fix가 영원히 스킵되던 것) — 리뷰 CLEAN, CI 대기
- 잔여: in-flight 파일의 spec 주석 2곳(search.ts, aliases.ts)은 피처 브랜치에서; llm-review.csv는 255행 리뷰 완료 후 삭제 가능

## 크롤 병행 작업 2차 (2026-06-10 오후)

- [x] **PR #34 머지** — main `ed8bee2` (통합 문서 3종 + 클린업 + tj-25863 fix)
- [x] **CHECKPOINT 1 사전 검증** — 175 ALLOW 전수: 172 CONFIRM / **3 SUSPECT** (148140 Super Star, 153397 トライアングル, 735357 ミチGO) → `tasks/checkpoint1-screening.md`, 오너 결정 대기
- [x] **데이터 토폴로지 결정서** — `tasks/data-topology-decision.md` (권고: 베이스라인 유지 + 풀코퍼스 Release asset + manifest; 221k 실측: gzip 9.6MB지만 MiniSearch 인덱스 힙 316MB → 오프라인 전체번들 불가), 오너 결정 대기
- [x] **PR #35** ci: fallback-모드 e2e + PR CI Playwright — 머지됨 (`e7f2ec8`), main 배포에서 신설 e2e 2회 연속 통과
- [x] **PR #36** feat(scripts): full-corpus publish/fetch (토폴로지 PR-1) — 머지됨 (`6fe1e48`)
- [x] **PR #37** docs: OPEN-QUESTIONS 교차참조 수정 — 머지 트레인이 자체 발견·수정 (`ae5a206`, 현 main HEAD)
- [ ] **PR-2 = PR #38** ci: full-corpus.yml 검증 워크플로(신뢰-제로: CI가 asset 재다운로드+sha 재계산→manifest PR; label `full-corpus`로 crawl-output 자동닫기 격리) + ci.yml manifest 게이트(첫 manifest 전까지 무해 no-op) + 오퍼레이터 런북 — 리뷰 CLEAN+수정 3건 반영, CI 실행 중. **머지 후 PR-3은 크롤 완료 의존**

## 오너 결정 확정 (2026-06-10 저녁)

- [x] **CHECKPOINT 1**: SUSPECT 3곡 권고대로 ALLOW에서 제거 (175→172, crawler 650/650 green). ⚠️ 크롤-후 후보 빌드 시 3개 selSongNo 명시 제외 필수 (`checkpoint1-screening.md` 참조)
- [x] **데이터 토폴로지**: 권고안 승인 → **PR #36** (PR-1: publish/fetch + manifest + lib/cli.mjs, 하드닝 4건 반영, 실코퍼스 왕복 byte-identical 증명, 신규 테스트 53개) — CI 실행 중, 머지 대기. 이후 PR-2(full-corpus.yml dispatch 워크플로 — #36 머지 의존), PR-3(첫 발행 + D1 import + 500MB 실측 — 크롤 완료 의존). 데이터포인트: 베이스라인 25.8k → SQLite 392MB ⇒ 풀코퍼스 D1 500MB 초과 사실상 확정(셀프호스트 경로)

## Detail 영속화 (2026-06-11 새벽, 크롤 중 핫스왑)

- [x] 발견: 스윕이 detail(작사/작곡/발매일/장르/타이업/외국어표기/루비)을 분류 후 폐기 → A1 alias 무력화 + 메타데이터 손실
- [x] 수정(오너 승인): 스윕 행에 `detail` 임베드(lyricIntro만 제외, null/빈배열 생략) + 후보 빌더 detail 패스스루(A1 alias 발화) — 4파일, 211/211 green, 리뷰 무블로커
- [x] 크롤 재시작: 46,812건 resume-skip, 새 행에 detail 확인. 로그 예상 크기 ~0.14 GB
- [x] resume torn-line 엣지(완전-JSON 꼬리 1행 유실 가능) 원라이너 수정 — 다음 재시작부터 유효
- [x] **파서 버그 발견·수정 (2026-06-11)**: `flattenNames`가 `item.name`을 읽었으나 실제 API는 `genreName`/`tieupName` — **장르/타이업이 역사상 한 번도 파싱된 적 없었음** (분류기 표면 포함). `aplList`도 동종 버그 2중(키명+중첩레벨, 실제: `aplList[*].selectionList[*].ServicePublishDate`). detail.ts/types.ts/테스트 수정, dist 재빌드, 651+212 green, raw 덤프 직접 증명. 분류 영향: **admit 방향만**(애니/보카로 토큰 게이트 — 정밀도 무영향, 재현율 개선)
- [ ] (권장) **초기 50,490건 백필** — 크롤 완료 후 타겟 재fetch (~3.8h): 행 1–46,812는 detail 전무, 행 46,813–50,490은 detail은 있으나 장르/타이업/apl 없음 + 全 50,490건이 빈-장르 시대 분류(stale은 admit 방향만). 균일화 + 누락 admit 회수 목적. 경계값: decision-log 행 50,490 (2026-06-11 재시작 시점)
- ℹ️ `detailFlipRisk`는 detail-bearing 행에서 의미 stale (분류기 쪽, 무해) — 피처 브랜치 정리 시 참고

## JOYSOUND 풀 디테일 크롤 (2026-06-10 기동)

- 입력: `apps/worker/.wrangler/audit/joysound-full-listing-20260604T171343Z/listing-rows.jsonl` (293,940행 → 291,253 유니크)
- 출력: `.tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl` (append-only, naviGroupId resume)
- 로그: 같은 디렉토리 `sweep-run.log`; 진행률: `decision-log.jsonl.progress.json` (200행마다 ETA 갱신)
- 페이스 250ms+80ms 지터 → ETA ~20–23시간. 절전(AC/DC standby+hibernate) 모두 해제함 — 완료 후 Windows 설정에서 복원 필요.
- **터미널(Claude Code 세션)을 닫으면 크롤이 죽음** — 죽어도 resume으로 이어가기 가능.
- 완료 후: `build-joysound-candidate.mjs`가 decision-log를 그대로 소비 → Layer-3 재샘플링(≥99% 정밀도 확인) → 후보 빌드.

## 셀프호스트 타깃 (2026-06-11, 보류 중)

- 타깃 확정: **hermes-host** (Tailscale, 100.84.84.57, Linux, Tailscale SSH 사용)
- 확인된 것: 온라인, Tailscale SSH 동작 (단 리눅스 계정명 미확인 — `ghkim887`/`kmend` 아님)
- 보류된 것(오너 "나중에"): 계정명 확인 → 환경 프로브(Node/디스크/메모리) → 배포 준비(systemd + **Tailscale Funnel**로 공개 HTTPS — Pages 방문자 접근용)
- 재개 시: 계정명만 알려주면 진행 가능

## 사용자 결정 대기 (제외 항목 재확인)

- JOYSOUND 머지 후 데이터 토폴로지 (corpus out-of-git, D1-only) — 머지 전 결정 필요
- App.tsx 훅 추출 / data-store↔worker 상수 통합 / classifier 재구조화 — feature branch 작업과 충돌, 머지 후
- scripts/data chunk-00..06 input (~1.55 MB, 미발송 Stage 2 입력) 폐기 여부

## 2차 배치 — 순수 리팩터링 6건 (2026-06-10, 전부 리뷰 CLEAN + CI ✅, 머지 대기)

- [x] **PR #28** chore: test/CI config dedup (no-op vitest config 3개 삭제, composite setup action, knip 배선 + dead export 3건)
- [x] **PR #29** refactor(crawler): 필터체인 스텝 순서 단일화 (FILTER_STEPS 배열 byte-identical 증명)
- [x] **PR #30** refactor(crawler): blogWhitelist + jpLikelyRescue 추출 (crawler.ts 623→330줄, 멀티셋 라인 증명)
- [x] **PR #31** test(worker): D1 마이그레이션 체인 ≡ 선언 스키마 패리티 테스트 (+카나리; main은 이미 패리티 — 0002에 number_key 존재)
- [x] **PR #32** refactor(web): index.astro 스타일 841줄 → global.css (CSS 에셋 byte-identical, 리뷰어 독립 재현)
- [x] **PR #33** refactor(scripts): Python drop 스크립트 → JS 통합, 중국 사이드카 기계 삭제 (시드 byte-parity 증명, 리뷰어 독립 재현; korean 기계는 ingest 소비로 유지)

**머지 완료 (2026-06-10)**: #28→#33 순서로 전부 클린 rebase-merge (충돌 0). main HEAD `be712cd`, ci+deploy green, 사이트 재배포. 1·2차 배치 합계 **12 PR 머지**.
**리베이스 완료 (2026-06-10)**: `feat/joysound-full-catalog-sweep` HEAD `a0593aa` (4 커밋이 `be712cd` 위로 클린 리플레이, 충돌 0). 미커밋 작업 29개 파일 stash→pop 무손실 (status byte-identical 검증). 백업: `backup/feat-joysound-pre-be712cd-rebase` (구 HEAD b736458). 검증: crawler 650/650, scripts 208/208 (새 워크스페이스 glob이 untracked 스윕 테스트 36개까지 자동 발견·통과 — #22 배선이 의도대로 동작). 리모트 브랜치 없음 → push 생략. CLAUDE.md도 be712cd 기준 동기화 완료 (11곳).

## 1차 배치 Review (2026-06-10 마감)

**오픈된 PR 6건** (모두 author→별도 reviewer→수정→재리뷰 CLEAN 후 퍼블리시, main 기반, 워킹트리 무접촉):
- #22 ci: glob 테스트 발견 + Python/사이드카 PR CI 게이트 — CI ✅
- #23 chore: 하이진 배치 (README drift, biome, deploy.yml 중복빌드 등 6건) — CI ✅
- #24 refactor(crawler): TJ reviewed-override 메타데이터 구조화 (121/121 백필) — CI ✅
- #25 fix(crawler): HTTP 캐시 persist 배칭 + 호스트별 opt-out — CI ✅
- #26 test: replay-merger runReplay() 추출 + 게이트 8테스트 — CI ✅
- #27 refactor(ci): 주간 post-crawl 파이프라인 스크립트화 — CI 실행 중

**머지 시 참고**: #23↔#27은 scripts/README.md에서 사소한 충돌 가능(2행). #22 머지 후 #26/#27의 새 테스트가 CI에 자동 편입. 작업 worktree 6개는 정리 완료(브랜치는 origin에 보존).

**로컬(이 트리) 수정**: runbook §4 e2e-게이트 정정, CLAUDE.md 3건(Python 헬퍼 위치, e2e 게이트, 트레일러 Fable 5), 고아 로그 삭제, 이 todo 파일.

**보류 항목**: PR-G(vitest 공통화+composite action)는 #22 머지 후; Python 패리티 기계 철거는 #27 머지 후; 데이터 토폴로지/in-flight 파일 리팩토링/chunk-00..06 폐기는 사용자 결정 대기.
