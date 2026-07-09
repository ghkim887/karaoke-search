# 세션 핸드오프 — 전레포 감사 + 수정 배치 3PR (2026-07-09)

다음 세션이 stale 요약이 아니라 디스크/git/서버의 실제 상태에서 이어가도록 작성.
직전 버전(2026-07-05 작성)은 아래로 갱신됨. 이번 세션은 ①전레포 무동작변경
리팩토링·버그 감사(6 병렬 리뷰어) ②감사 수정 배치(PR #96) ③main 이중 회귀
발견·치유(PR #97/#98)에 집중.

## Current state of record (2026-07-10 갱신)

- **main**: `1bd6390` — **CI GREEN 복구 완료**. 2026-07-09~10 세션의 5개 PR 전부
  오너 그랜트("전부 머지")로 스쿼시 머지됨:
  - **#98** #95 회귀 치유(167행 퍼지 + tj-52990 allow + 도구 allow-list 패리티 +
    패리티 베이스라인 재생성 + smoke 6건 재고정) — 이 머지로 main 그린 복구.
  - **#96** 감사 수정 배치(레거시 delta 전곡 재유도 HIGH / long-q 400 / 512MB 스트리밍 + 문서).
  - **#97** crawl.yml PR-전 크롤러 테스트 게이트(다음 주간 크롤이 첫 실검증).
  - **#99** HANDOFF 체크포인트. **#100** 감사 리팩토링 8건(무동작변경 —
    파생테이블 덤프/프로브 바이트 동일 증명, 리뷰 APPROVE, main push CI 확인).
- **서빙 DB**: oci `db/current -> v21` 변화 없음. v22 프로모션 보류 유지(커버리지 회귀 −49,683).
- **라이브 웹**: karaokedb.pages.dev 변화 없음(이번 세션 배포 없음). 코퍼스 167행
  퍼지는 다음 배포 때 번들에 반영됨.
- **작업 클론**: scratchpad(소멸성). 다음 세션은 fresh clone 후 이 문서부터.

## main 이중 회귀의 전말 (#95발, 이번 세션 발견·치유)

1. **크롤 PR에는 ci.yml이 아예 안 돎**: crawl PR은 기본 GITHUB_TOKEN으로 열리는데
   GitHub는 GITHUB_TOKEN이 만든 PR에 `on: pull_request`를 트리거하지 않음 → #95가
   무검증 머지되고 main push에서야 red(run 29011788138). → **#97이 게이트 신설**.
2. **한국어 누출 145행**(테스트 가시) + **22행**(같은 3팀의 라틴제목/한자표기라
   테스트 정규식 밖): TJ 아티스트검색이 일본시장 카탈로그 보유 한국 아티스트
   (루시/로이킴/BOYNEXTDOOR)를 JPN 오판정(JPN≥3·KOR 0표), 드롭리스트에 3팀 부재라
   크롤·파이프라인 양쪽 무반응. 곡 단위 pro 신호는 145행 전부 KOR로 정답을 갖고
   있었음(시스템 수정은 ROADMAP "TJ filter seam"). → **#98이 드롭리스트 3팀 + 167행
   퍼지**. tj-52990 "Count To Love"(BOYNEXTDOOR)만은 진짜 일본 싱글(BOYLIFE
   2025-08-18, 빌보드재팬 Hot 100 1위)로 웹검증되어 reviewedSongOverrides allow로
   보존(크롤 필터 step2 allow가 step3 deny 선행 — 기계 강제라 크롤에도 durable).
3. **web 패리티 identity 게이트 실패(14건)가 bail에 은폐**: `pnpm -r test`는 crawler
   실패에서 중단 → apps/web 실행 자체가 안 됨. #95가 코퍼스를 바꾸고 패리티
   베이스라인(sha256+레코드수 핀)을 재생성 안 함. → **#98이 베이스라인 재생성**
   (퍼지 격리 jaccard +0.0023 개선, 하락 쿼리 0).
4. **smoke 6건 = blog-* id가 위치 기반이라 재크롤마다 id→곡 재배정**(#95: Utada
   137/149, Ado 69/76, ZUTOMAYO 64/75, Yonezu 99/121). 곡들은 새 id에서 여전히 1위 —
   검색 정상, 픽스처만 stale. → **#98이 6개 expectId 재고정**(karaoke number로
   동일성 검증). **제품 함의(신규 발견)**: localStorage 즐겨찾기
   (karaoke-favorites:v1)가 record id를 저장 → 재배정 크롤마다 유저 즐겨찾기가
   조용히 다른 곡으로 바뀜. reviewedMergePairs는 벤더번호 키라 면역. 안정 식별자
   설계 = ROADMAP(오너 결정). memory `blog-ids-positional-reshuffle-each-crawl`.
5. **퍼지 도구 결함**: drop-artist-leaks.mjs가 reviewedSongOverrides allow를 무시
   (docstring의 "classifyRecord와 동일 predicate" 주장 거짓). → **#98이 allow-list
   패리티 수정**(+테스트 2건; chinese anomaly 하드드롭은 step-0 미러라 무조건 유지).

## 전레포 감사 결과 (2026-07-09, read-only, main a8827b8)

6 병렬 리뷰어(search/schema · data-store · worker · web · crawler · scripts+CI),
certain/likely 전건 오케스트레이터 독립 재검증. **PR #96으로 수정 출하 3건**:
- **[HIGH] 레거시(pre-#93) DB에 delta patch → 미변경 곡 search_texts 전멸**
  (schema.ts 마이그레이션이 테이블째 DROP 후 touched만 재작성; 라이브 v21이 정확히
  레거시 형태). 수정: 마이그레이션 드롭 감지 시 전곡 재유도(full import 등가,
  현행 스키마 delta 불변). 회귀 테스트 4건 + e2e(CLI patch→serve 왕복).
- **[MED] 긴 romaji q → wanakana 재귀 스택오버플로 → /api/search 500**. 수정:
  expandSearchQuery 256cp 가드(무throw) + worker 400(코드포인트 계수, astral 검증).
- **[MED-잠복] decision-log >512MB면 스윕 재개·후보빌드 즉사**(readFileSync V8
  문자열 상한). 수정: streamJsonl 스트리밍(torn-line 바이트 절단 보존, >64KB
  멀티청크 테스트).

**미수정·ROADMAP 기록(오너 판단 대기)**: delta 'affected' 모드 전역 idf 스테일
(delta DB 랭킹 ≠ full rebuild; 112/148 토큰 재현), Tier B 동일소스 병합 입력순서
의존(생존자 플립 재현; 동일벤더 번호 소실), delta의 미변경곡 힌트 무시, low 6건
(반복부호 ゝ/ゞ 전사 탈락, web 폴백 배너 오표시, Favorites pending 부재, rate-limit
Map 무정리, close() keep-alive, hint 초성 패리티), 무동작변경 리팩토링 8건,
/api/meta↔Footer 날짜 계약 테스트. **감사 중 기각 2건(재발굴 금지)**: Footer 날짜
갱신은 비버그(worker가 YYYY-MM-DD 절단), endStream 에러 삼킴은 Node24에서 반증.

## Grant Ledger

- **전레포 감사(read-only)** — 2026-07-09 사용자 요청. 완료.
- **옵션 A 수정 배치 구현+PR** — 2026-07-09 "a 진행하고 문서화해줘". PR #96 오픈 완료.
- **A+B 회귀 치유(코퍼스 퍼지+crawl 게이트)+PR** — 2026-07-09 "그대로 진행해".
  PR #97/#98 오픈 완료. 도구 확장·tj-52990 allow·smoke 재고정은 오케스트레이터가
  증거 기반 세부 승인.
- **머지 그랜트 없음** — #96/#97/#98 전부 오너 리뷰 대기.
- (이월) 읽기전용 prod DB 조회 grant(2026-07-08)는 이번 세션 미사용; oci ssh 보류 유지.

## Open items (2026-07-10 오너 결정 라운드 반영)

1. ~~PR 리뷰/머지~~ **완료 — #96–#103 전부 머지, main 그린** (#102 smoke
   안정키+계약테스트, #103 low 버그 6건 포함; ゝ/ゞ·배너·Favorites pending·
   rate-limit·shutdown·hint 초성 = 전부 수정 완료).
2. **오너 보류(2026-07-10, 사유 포함 — ROADMAP에 기록)**:
   - R1 머저 브리지(two-TJ 6곡): **보류** — "실제로 번호 2개가 공존하는 곡일 수
     있음"(별칭으로 숨기는 설계가 카탈로그 왜곡일 수 있다는 관점). 부속 사실:
     4쌍은 차기 빌드에서 Tier A 자동 해소, Tier F `['tj','28268','162483']`는
     inert(메커니즘 도입 시 제거), 페어 주석 id 드리프트 2건.
   - blog-id 안정 식별자/즐겨찾기 무결성: **보류**(당장 계획 없음; 권고안
     "즐겨찾기 v2 = 벤더번호 저장"은 ROADMAP에 대기).
   - 오프사이트 백업(§8)·워치독 채널(§9): **보류**(당장 계획 없음). ⚠ 릴리스
     자산 0개 확인됨(매니페스트 댕글링, NAS 유일본) — 리스크 인지 하 보류.
   - PR-2/PR-3(풀코퍼스 발행 워크플로/배포 플립): §8 보류에 종속돼 함께 보류.
   - 버전 애매 ~7건: 보류 유지.
3. **실행 중(2026-07-10 오너 go "실행 가능한 것들 실행")**: ①패리티 베이스라인
   재생성 정책(크롤 워크플로 재생성+jaccard 델타 PR 표기) ②TierB 결정적
   타이브레이크(현 산출물 보존형; "병합 여부" 질문은 브리지 보류와 함께 유보)
   ③idf drift 문서화 ④delta 힌트 문서화+가드 ⑤title_ko CSV 255건 에이전트
   사전검토(제안 픽스는 오너 사인오프 후 커밋). 이 문서 갱신 시점에 author/리서처
   작업 진행 중 — 최종 상태는 후속 PR/체크포인트 참조.
4. **시간 게이트 = 전부 보류(2026-07-10, 오너)**: 금요일 주간 크롤은 돌아가는 대로
   **관찰만**(#97 게이트 첫 실전, 소킹 체크: 병합쌍 적용·ruby 유입·classifier
   골든·167행 퍼지 유지) — 결과에 따른 후속 작업 착수는 오너 지시 필요. TJ filter
   seam 설계·classifier Phase 2도 **오너 go 없이는 착수 금지**(ROADMAP HELD 주석
   참조).
5. **v22 fullCatalog 크롤: 보류(2026-07-10, 오너)** — 착수·승격 모두 명시적 go
   필요(승격은 oci ssh 보류 해제 포함). 방법론은 memory
   `joysound-full-corpus-needs-fullcatalog-crawl` + 런북 참조.

## 영구 규칙 (기존 유지 + 이번 세션 추가)

- (기존) 권한/시크릿 느슨함 의도(수정 금지), release 디렉터리 in-place 수정 금지,
  보존 = current+1, 웹 빌드/wrangler는 PowerShell(MSYS env 오염), 에이전트 게이트 =
  CI 미러(biome/-r typecheck/-r test/-r build/knip 고정), Pages 배포 후 실브라우저
  검증 필수.
- **(신규) `pnpm -r test`는 bail** — 첫 패키지 실패가 뒤 패키지 결과를 은폐. 전수
  판정은 `-r --no-bail` 또는 패키지별 실행으로.
- **(신규) 크롤 PR에는 ci.yml이 안 돎**(GITHUB_TOKEN PR은 pull_request 미트리거) —
  #97 게이트가 방어선. 크롤로 코퍼스가 바뀌면 패리티 베이스라인 재생성 필요.
- **(신규) blog-* id는 위치 기반, 크롤마다 재배정** — id를 고정하는 픽스처/기능
  금지, 안정키는 karaoke number(tj/ky/joysound).

## Next first action

1. 오너 go 대기: Open items 3의 실행 가능 5건(패리티 정책이 최우선 — 금요일 전).
2. 금요일 주간 크롤 결과 확인(#97 게이트 첫 실전 + 소킹 체크 + 베이스라인 재생성).
3. 보류 항목은 ROADMAP의 HELD 주석이 정본 — 재론 시 그 사유부터 읽을 것.
