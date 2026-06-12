# 세션 핸드오프 — JOYSOUND DB 도입 (2026-06-12)

다음 세션이 stale 요약이 아니라 디스크/git의 실제 상태에서 이어가도록 작성. 모든 사실은 이 세션 종료 시점 system-of-record 기준.

## Active goal
JOYSOUND 풀카탈로그(~291k)를 코퍼스에 도입 → 셀프호스트(hermes-host) 배포. 현재 **디테일 크롤+백필 완료, 후보 빌드 직전**에서 정지.

## Current state of record
- **Repo/path**: `C:\Users\kmend\Desktop\karaoke`
- **Branch/HEAD**: `feat/joysound-full-catalog-sweep` @ `48f393c` (origin/main `82e6171`의 후손 — 2026-06-11 리베이스됨). 미커밋 변경 32 modified + untracked 다수 (아래).
- **커밋 안 됨**: 이번 세션의 모든 JOYSOUND 작업이 **미커밋 상태** (오너 커밋 승인 대기 — runbook §2). 백업 브랜치: `backup/feat-joysound-pre-82e6171-rebase`, `backup/feat-joysound-pre-be712cd-rebase`.
- **실행 중 프로세스**: sweep **없음**(완료). 살아있는 node 5개는 MCP 서버(무관).
- **메인 origin/main**: 오늘 13 PR 머지됨 (#22–#38, 마지막 `82e6171` = full-corpus 워크플로 PR-2). 머지 완료 — 추가 작업 없음.

## Completed evidence
1. **디테일 크롤 + 백필 완료·검증**:
   - 산출물: `.tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl` (192 MB, **291,253행**)
   - 검증: 파싱실패 0 / 고유 naviGroupId 291,253 (중복 0) / detail 없음 2건(=fetch실패 2, listing-only 폴백) / genreNames 보유 106,249곡 / tieupNames 63,342곡 / admit 224k+ / drop 16k+
   - 각 곡 detail: 정식 제목·아티스트·루비·작사(`lyricist`)·작곡(`composer`)·외국어표기 4종(`songNameForeign`/`artistNameForeign`/...Search)·`genreNames`·`tieupNames`·`aplServicePublishDates`·내부ID. (lyricIntro만 의도적 제외)
   - 전체 백업: `decision-log.jsonl.full-20260612.bak` (171 MB, 백필 전 291,253행 — 앞 50,490은 결손)
   - 입력: `apps/worker/.wrangler/audit/joysound-full-listing-20260604T171343Z/listing-rows.jsonl` (55 MB, 293,940행→291,253 유니크)
2. **CHECKPOINT 1 해소**: 175 ALLOW 전수 검증 → SUSPECT 3곡 제거(175→172). 상세 `tasks/checkpoint1-screening.md`. crawler 650/650 green.
3. **detail 파서 버그 수정**: `flattenNames`가 `item.name` 읽던 것 → `genreName`/`tieupName`, aplList 중첩 수정. 651+212 테스트 green, dist 재빌드됨.
4. **데이터 토폴로지 결정 + 인프라**: `tasks/data-topology-decision.md` (권고: tracked 베이스라인 + full corpus는 Release asset + manifest). publish/fetch 스크립트 + full-corpus.yml 워크플로 = origin/main에 머지 완료(#36/#38).
5. **TJ API 전수조사**: `tasks/tj-api-survey-20260611.md` — 결론: TJ엔 미사용 분류 신호 없음, FP/FN 개선은 JOYSOUND 교차검증으로.

## Open items (다음 세션 결정/작업)
**Blockers / Decisions needed (오너):**
- **D1. 후보 빌드 시 SUSPECT 3곡 명시 제외 필수** — 크롤이 175개짜리 분류기를 메모리에 들고 시작 → decision-log에 selSongNo `148140`/`153397`/`735357`이 admit으로 기록됨. `build-joysound-candidate.mjs`는 decision-log를 재분류 없이 신뢰하므로(line ~482) 빌더에서 명시 제외 또는 3행 스크럽 필요. **이거 빠지면 제거한 3곡이 도로 들어옴.**
- **D2. 피처 브랜치 커밋 승인** — 32개 미커밋 파일 + untracked(joysound 스윕/빌더/오버라이드/파서). runbook §2 경로로 커밋할지.
- **D3. hermes-host 셀프호스트** — 타깃 확정(Tailscale 100.84.84.57, Linux). **리눅스 계정명 미확인**(`ghkim887`/`kmend` 아님) — 이거 알려주면 환경프로브→배포 진행. 공개 HTTPS는 Tailscale Funnel.
- **D4. (선택) TJ×JOYSOUND 교차 국적 검증** 패스를 후보 빌드에 넣을지 (`tasks/tj-api-survey-20260611.md` 참조).

**Deferred (의도적):**
- `.tmp_review/` (~수 GB) 아카이브→삭제: JOYSOUND 머지 후. 단 `decision-log.jsonl`(현 산출물)·`.bak`·CHECKPOINT 1 CSV는 보존.
- 머지 후 백로그(`tasks/todo-structural-improvements.md`): worker SQL-splitter/StoredSongRow 중복, App.tsx 훅, classifier gate-배열 등.

## Next first action
```
# 1) 후보 빌드 — SUSPECT 3곡 제외 반영 (D1). 빌더 인자/제외 방식 먼저 확인:
cd C:\Users\kmend\Desktop\karaoke
node scripts/build-joysound-candidate.mjs --help   # 또는 헤더 주석 확인 (제외 플래그/입력 형식)
#    decision-log = .tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl
#    반드시 selSongNo 148140/153397/735357 제외 (checkpoint1-screening.md)
# 2) 후 Layer-3 정밀도 재샘플링: node scripts/sample_joysound_admits.mjs (≥99% 목표)
# 3) 그 다음 publish → full-corpus.yml dispatch → hermes-host (D3 계정명 필요)
```
검증 게이트는 후보 빌드 시 `validate-songs-json.mjs`가 내부 호출됨. 절전 설정은 이번 세션에 복원 완료(standby 15min).
