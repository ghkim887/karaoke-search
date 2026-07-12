# 세션 핸드오프 — 관측성 라운드 + 백로그 배치 완결 (2026-07-13 checkpoint)

직전 체크포인트(2026-07-12 18:30, #132)를 갱신. 이후 진행: ①TJ 필터 관측성
(#134) ②오너 docs #133 머지 ③무결정 백로그 배치 3종(#135·#136·.tmp_review
집행) ④filter seam 정찰→근본원인 교정→방향 확정 ⑤크롤 사전 검증 완료.
**다음 이벤트 = 오너의 검증용 크롤(사전 블로커 0).**

## Current state of record

- **main**: `8f96cc3` + 이 체크포인트 PR. #133~#136 전부 스쿼시 머지, 각 머지의
  main push CI green. **열린 PR: 0.**
- **서빙 (oci)**: v22 라이브 유지 — 이 라운드는 서빙 무접촉. 공개 체인 확인
  `/api/meta → dbUpdatedAt 2026-07-12`.
- **자동 크롤: 무기한 보류 유지** — `crawl.yml` = `disabled_manually`.
  **crawl.yml 사전 검증 완료(2026-07-13)**: main 페치본 YAML 파스 OK,
  #134 신규 배선(크롤러 `--decisions-out` ↔ 컴포저 `tj-filter.jsonl` 앵커,
  `FILTER_DECISIONS_DIR` ↔ `drop-{kpop,cpop}-leaks.jsonl`, 컴포저 4번째 인자 =
  디렉터리) 전부 일치, 아티팩트 업로드 `if: always()` + 핀 SHA + 유출 게이트보다
  앞 배치 확인.
- **`.tmp_review` (NAS)**: 정리 집행 완료 — 남은 것은 검증된 아카이브
  `joysound-detail-sweep-20260610.tar.gz`(26.6MB, SHA-256 `6CC31486…`) 하나뿐.
  원본 146.5MB 삭제. `runs/archive/`가 SMB ACL로 막혀 아카이브가 `.tmp_review/`
  안에 있음(이관은 oci에서 `mv` 한 줄). 상세는 ROADMAP 해당 항목.
- **작업 클론**: scratchpad `kwork`(+`kwork-b1`) — 소멸성, 다음 세션은 fresh clone.
- **스크래치패드 잔여물**: v22 리플레이 증명 아티팩트(`v22-replay/` — decisions
  로컬 사본 222MB + 리플레이 출력 2벌), title_ko 워커 입출력(`titleko-b2/`),
  June 스윕 아카이브 로컬 사본. 전부 재생성 가능/NAS에 정본 존재 — 보존 불요.

## Grant Ledger (2026-07-12~13 라운드)

- **#134 구현+PR** — "이거 필요해"+"계획 스킵, 구현 완료까지 진행". 머지는 "승인".
- **#133 머지** — "머지 하고" (첫 "승인"은 분류기가 #134 한정으로 해석, 재지시로 집행).
- **백로그 배치** — "백로그 처리해보자" → #135·#136 구현/PR, 머지는 "둘다 진행해".
- **.tmp_review 아카이브+삭제** — "아카이브 NAS로 복사하고 원본 삭제해"
  (명시 지시; 그 전 "둘다 진행해"는 분류기가 NAS 쓰기 불포함으로 판정).
- **filter seam 방향+순서** — "추천대로" (2026-07-13): 옵션 C 스크립트 가드 +
  검증 크롤 후 구현.
- **체크포인트 docs PR 작성+머지** — "pr 머지만 해 일단" (2026-07-13).
- **미승인으로 남음**: 크롤 재활성화(오너 "배포" 조건 + 검증용 1회는 오너 실행),
  filter seam 구현 착수(크롤 후 정량화 데이터 보고), §8 백업 실행(private 방향만
  확정), classifier Phase 2, blog-id, R5 KY 스파이크, R3 본구현.

## Completed with evidence (2026-07-12~13)

- **#134 TJ 필터 결정로그**: reject reason이 `parser.ts`에서 파기되던 것을 관통 —
  `classifyRecordWithReason` + `ParseResult.decisions` + 크롤러 `--decisions-out`
  (rescue 재파스 안전: 최종 파스만 1회 기록) + `drop-artist-leaks` 사유 기록 +
  crawl.yml 아티팩트(`if: always()`) + PR 바디 `### TJ filter attribution`
  섹션(fail-soft). 게이트 5종 + 독립 리뷰어 재실행 + CI green.
- **#135 classifier 게이트 배열**: 모놀리식 체인 → `JOYSOUND_GATES`+`PHASE_ORDER`+
  로드타임 어서션. **동작 동일성 증명 = v22 결정로그 352,290행 이중 리플레이
  바이트 동일**(양 패스 SHA-256 `F65621D8…`, 리뷰어가 재빌드로 동일 해시 독립
  재현), 골든 38/38 무수정. 로컬 리플레이 코퍼스/출력은 scratchpad(소멸성),
  원본 결정로그는 NAS `runs/data-2026-07-10-v22-fullcatalog/decisions.jsonl`.
- **#136 title_ko 선적재**: 신규 tjpdf 240곡 중 CJK 191곡 번역을 Stage-2 캐시에
  선적재(레포 런북 절차 그대로: 병렬 워커 + 실검증기 + 드리프트 핀 13/13).
  통계 titled 180/191, high 9/med 176/low 6. **선적재는 inert** — 머지가 코퍼스
  부재 id 무시, 프룬 없음 → 다음 크롤 인제스트 시 자동 발효. medium 리뷰 CSV는
  크롤이 자동 생성 안 함(원하면 수동 `merge --review-csv` 1회).
- **filter seam 근본원인 교정(정찰+캐시 실측)**: "곡 단위 KOR 신호 무시"가 아니라
  **지각(lagging) 신호** — 분류 시점 `proEnrichmentMap` 부재, KOR은 분류 후
  translit 패스가 기록(169건 08:29 타임스탬프 = 유출 168행+1). 신규 한국곡은
  1크롤 유출 후 자가치유. 확정 픽스/순서는 ROADMAP filter-seam 항목 + memory
  `tj-filter-seam-root-cause-and-fix`.

## Open items

- **다음 이벤트 = 오너의 검증용 크롤.** 절차: ①`gh workflow enable crawl.yml`
  ②`gh workflow run crawl` ③관찰 ④크롤 PR 리뷰→오너 머지 ⑤재비활성화(보류
  유지 시). 크롤 PR엔 ci.yml이 안 돌므로 워크플로 내 게이트가 유일 방어선.
  **관찰 체크리스트**(이번 크롤이 일괄 검증하는 것):
  - 런: #97 게이트 / #134 배선 첫 실행(결정로그 아티팩트 존재) / 파이프라인 완주
  - 데이터: +149 제목 복원(#129) / tjpdf +240 & K-pop 58 차단(#131) / 191곡
    title_ko 자동 적용(#136) / IVE allow+렌더·CUTIE STREET 드롭(#126)
  - 리포트: 패리티 델타(+240이라 델타 정상, 사람 사인오프) / 간체 감사 0 기대
    (#128) / **TJ filter attribution 섹션 첫 라이브(#134)**
  - 크롤 후: **seam 정량화**(아티팩트에서 `admit AND step=jpn-admit-artist AND
    한글-무일문` − reviewed-allow) → 그 데이터로 seam 구현 착수(픽스처
    tj-32100/36707/43349, 드롭리스트 없이 self-reject 증명)
- **오너 결정 대기**: §8 백업 실행(대상 v22 full-corpus ~135MB, NAS 유일본),
  classifier Phase 2(전제 충족, 스펙 = 골든 Part B2 어서션 플립), blog-id,
  R5 KY 1k 스파이크, R3 본구현, 크롤 재개 시점.
- **Deferred → ROADMAP**: title_ko uncertain 13 + interior-ws 24(dormant) +
  Latin 49곡 media_context 미조사, tjpdf 발견 스윕 자동화 여부(신규 번호 블록
  등장 시), `.tmp_review` 아카이브의 runs/archive 이관(선택).

## 영구 규칙 delta (이 라운드 신규)

- TJ 크롤은 이제 행 단위 admit/drop 사유를 남김: 크롤 아티팩트
  `filter-decisions-<run_id>`(tj-filter/drop-kpop/drop-cpop jsonl) + PR 바디
  attribution 섹션. 유출 분석은 이걸 먼저 볼 것(수동 재구성 불요).
- JOYSOUND 분류기 구조 변경은 이제 이중 리플레이 바이트 비교로 증명 가능
  (~10분, `joysound-replay-classifier.mjs` + NAS v22 decisions.jsonl; 하네스
  자체 purity check는 구정책이라 외부 byte-diff가 증명).
- NAS `runs/` 하위는 SMB로 생성 불가(oci 소유 ACL) — NAS 쓰기는 `.tmp_review/`
  등 윈도우 생성 트리만 가능, 그 외는 oci 셸 필요.

## Next first action

1. 오너: 검증용 크롤 dispatch (위 5단계 + 관찰 체크리스트).
2. 크롤 머지 후: seam 정량화 스크립트 → 결과 보고 → 오너 go 시 seam 구현
   (옵션 C, memory/ROADMAP에 스펙 고정됨).
