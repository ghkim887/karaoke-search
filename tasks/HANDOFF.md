# 세션 핸드오프 — 로드맵 R1/R2/R4 배송 + v21 라이브 (2026-07-04)

다음 세션이 stale 요약이 아니라 디스크/git/서버의 실제 상태에서 이어가도록 작성.
직전 버전(2026-06-13, Cloudflare 제거 직후)은 전부 이행 완료로 대체됨.

## Active goal

로드맵(docs/ROADMAP.md R1–R5) 순차 배송. 이번 세션까지로 **R1(감사+확정쌍),
R2(i18n+라이선스+footer), R4-1(ruby 3문자 검색)이 main+라이브에 반영 완료**.
다음 타깃은 백로그 섹션 참조 — 단, 상당수가 "다음 주간 크롤 1회 소킹"에 게이트됨.

## Current state of record

- **main**: `74e818e` == origin/main. 오늘 PR #71–#79 아홉 건 전부 머지
  (전부 author-reviewer 독립 에이전트 검수 통과 후).
- **서빙 DB**: hermes-host `db/current -> releases/data-2026-07-04-v21-title-ruby`
  (songs.sqlite 1,940,869,120 B = 1.81 GiB, VACUUMed, SHA256SUMS 있음).
  롤백용 previous = v20(1.09 GiB). v19는 프룬됨. 디스크 28%.
  v21 = enriched corpus(236,224곡 title_ruby) + v11 힌트 2종으로 서버에서
  런북대로 빌드. `/api/meta` → `{"dbUpdatedAt":"2026-06-18"}` (max crawled_at).
- **라이브 웹**: karaokedb.pages.dev — main 기준 수동 wrangler 배포 완료.
  한/영/일 스위처(헤더 🌐 드롭다운, ko 기본), MIT footer, 실시간 DB 날짜
  (/api/meta 페치, 실패 시 빌드 시점 max crawled_at 폴백), PWA/폰트 서브셋.
- **서버 repo**: /srv/nas/karaoke/app == main 74e818e, 서비스 재시작·검증 완료.
  로컬 편집으로 tasks/todo-tier0-refactor-20260702.md만 dirty(운영 로그, 유지).
- **작업 클론**: 이 세션의 scratchpad(세션 종료 시 소멸 가능)에 있었음 —
  다음 세션은 새로 `git clone --filter=blob:none
  https://github.com/ghkim887/karaoke-search` 후 워크트리(wt-*) 패턴 재사용.
  Z:\karaoke는 라이브 NAS 마운트(코드 작업 금지, 조회/데이터 전송용).

## Completed evidence (2026-07-04 세션)

1. **#71 ROADMAP.md**: R1–R5 다섯 항목 + 스코핑 실측(378곡/커버리지/크기).
2. **#72 MIT 재라이선스 + footer 날짜**: AGPL→MIT 전면, git-date 기계 삭제,
   워커 `GET /api/meta`(max crawled_at, per-DB memo) + 프록시 allowlist +meta.
3. **#75 UI i18n**: ko/en/ja 카탈로그(타입 강제), 헤더 드롭다운(menu-button
   패턴), 모듈 스토어+CustomEvent 브리지, ResizeObserver --header-height 동기화.
   ko 기본 렌더 byte-identical(드리프트 가드 테스트). 리뷰 2라운드
   (하이드레이션 aria-label 버그 실브라우저 검증, knip).
4. **#73 R1 감사 CLI** `scripts/audit-missing-joysound-numbers.mjs`:
   378곡 → A:39/B:190/C:149. 리뷰가 티어-온-슬라이스 블로커 적발(A 10곡 복원).
5. **#76 확정 병합쌍 26건**: tier E 65→84, F 138→145(+extra-provider 1).
   오너 승인 31건 중 5건은 메커니즘상 표현 불가(아래 백로그). **다음 크롤 때 적용**.
6. **#77 빌드 가드**: PUBLIC_KARAOKE_API_BASE_URL config-load 검증 + postbuild
   오염 시그니처 스캔. 배경: 이날 새벽 Git Bash MSYS 경로 변환이 env `/`를
   `C:/Program Files/Git`으로 바꿔 라이브 검색이 오프라인 폴백으로 강등됐던
   실사고(PowerShell 재빌드·재배포로 복구).
7. **#78 title_ruby Stage 1**: 스키마 optional 필드, 크롤러 passthrough
   (title-donor 규칙: 제목 이긴 레코드의 ruby만), 백필 스크립트
   (236,224/236,433 적용, 8버킷 전수 정합), baseline songs.json +255.
8. **#79 ruby 검색 Stage 2**: kana→romaji/hangul 결정적 변환(@karaoke/search,
   174 테이블 핀 테스트), reading 3필드 weight 3 token-only, romaji는
   term+prefix만(ASCII gram은 쿼리 불가능한 죽은 토큰), **per-song 크로스필드
   dedup**(중복 ruby 이중 가산 차단). 전량(307k) 배터리: 17/22 byte-identical,
   5건은 reading형 쿼리의 의도된 recall(오너 수용). 25k 패리티 골든 불변.
9. **v21 배포**: 프리스왑 배터리(:8788 vs live, 12/15 identical + 의도된 3건)
   → 심링크 스왑 → 재시작 → 공개 체인 검증(마루/maru/우타) → 프룬.

## Open items

- **크롤 소킹 게이트(다음 주간 crawl.yml 후 확인할 것)**:
  1. 병합쌍 26건이 실제 적용됐는지(대상 곡들이 joysound 번호 획득).
  2. 크롤러 ruby persistence — 신규/전체 곡에 title_ruby가 corpus로 들어오는지
     (백필 미커버 70,389곡이 여기서 채워짐). baseline songs.json 재생성 시
     오프라인 서브셋 ruby 커버리지(현 255곡)도 증가.
  3. classifier Phase-1 골든 게이트 첫 실전 소킹 → 통과 시 Phase 2 해제
     (OPEN-QUESTIONS §7).
- **백로그(오너 지시 대기, 우선순위 제안 순)**:
  1. R1 B티어 190곡 리뷰 배치(개명/보컬로이드 크레딧/표기 변형) + **머저
     메커니즘 확장** — 표현 불가 5쌍(tj-25103, tj-27098: 후보가 자체 TJ 번호
     보유 / blog-1184-1·3, blog-487-11: 대상이 tj+ky 복수 번호)을 다룰 수 있게.
  2. lyricist/composer/tieupNames 인덱싱 — 원천 데이터는 NAS
     runs/data-2026-06-14-.../joysound-detail-decision-log.jsonl(147MB)에 있음
     (이 세션의 슬림 추출본은 scratchpad라 소멸 — 같은 방식으로 재추출).
  3. R3 오프라인 전체 팩(opt-in sqlite-wasm+OPFS) / R5 ky/dam 준비(ROADMAP 참조).
- **오너 결정 보류(건드리지 말 것)**: OPEN-QUESTIONS §8 오프사이트 백업
  (공개 릴리스 업로드는 명시 승인 필요), §9 워치독 알림 채널, ko UI를
  한국어 단독으로 바꿀지(현행 ko=이중언어 유지가 승인된 상태), reading 필드
  gram3 추가 트림(−140 MiB, 정밀도 소폭 하락 — 제안했으나 미답, 기본 유지).
- **영구 규칙(메모리에도 있음)**: 권한/시크릿 느슨함은 의도(수정 금지),
  release 디렉터리 in-place 수정 금지(db/current는 심링크), 보존 = current+1,
  웹 빌드/wrangler는 PowerShell에서(MSYS env 오염), 에이전트 게이트 목록은
  CI 미러(biome/-r typecheck/-r test/-r build/knip 고정), Pages 배포 후
  실브라우저 검증 필수(curl로는 폴백 강등이 안 보임).

## Next first action

1. 주간 크롤 완료 대기 → 위 "크롤 소킹 게이트" 3종 확인(병합쌍 적용·ruby
   유입·골든 게이트). 문제없으면 새 corpus로 v22 릴리스 사이클(런북:
   README-ops "Release promotion runbook", 힌트 jsonl 포함 필수).
2. 또는 오너가 백로그 항목을 지시하면 해당 항목부터 — 코드 작업은 전부
   로컬 클론 + 워크트리 + author/reviewer 독립 에이전트 + CI 미러 게이트로.
