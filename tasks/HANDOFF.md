# 세션 핸드오프 — v22 크롤 가동 + 무결정 배치 완결 (2026-07-11 00:10 KST 체크포인트)

직전 버전(2026-07-09/10 감사 세션)을 갱신. 이번 세션(2026-07-10~11)은
①B-1 fullCatalog 리스팅 배선(#113) ②v22 풀크롤 발진(+HttpClient 캐시 사고
치유 #114) ③two-TJ 검증·종결(#115) ④무결정 배치(#116–#123) ⑤오너 결정
3건 집행(v22 stage-2 사전승인 / R7 구현 go / §9 종결 #124)을 수행.

## Current state of record

- **main**: `eea60b2` (#123까지, CI success 확인). 열린 PR: **#124**(docs:
  §9 종결 + 이 체크포인트; head는 이 커밋) — 머지 승인 대기.
  **R7 구현 PR은 아직 미오픈**(author 작업 중, 아래 In-progress).
- **v22 풀크롤 LIVE (oci)**: tmux `v22` — 리스팅 **352,290행 완료**(행 게이트
  ≥280k 통과) 후 detail-sweep 진행 중(체크포인트 시점 9,699 결정, ~2.5/s →
  **ETA 토요일(7/12) 오전 KST**). tmux `v22stage2` — sweep `code=0` 시
  **candidate 빌드+커버리지 게이트 자동 실행**(오너 사전승인, 승격 제외).
  런 디렉터리 `/srv/nas/karaoke/runs/data-2026-07-10-v22-fullcatalog/`
  (status.txt = 상태기계; 재개 = run-v22.sh 재실행이 항상 안전).
  stage-2 클론 = oci `~/v22/stage2/karaoke-search` @ eea60b2.
- **서빙**: oci `db/current → v21`(joysound 306,822 = 커버리지 게이트 기준값,
  라이브 검증 2026-07-10). 웹 배포 없음.
- **라이브니스**: `.github/workflows/liveness.yml` 가동(수동 1회 success;
  스케줄 틱은 GitHub 큐 등록 지연 중 — 첫 자동 run 확인 요).
- **작업 클론**: scratchpad `kwork`(+ 워크트리 `kw-r7`=R7 author 사용 중).
  소멸성 — 다음 세션은 fresh clone.

## Grant Ledger (2026-07-10~11)

- **B-1 리스팅 배선 구현+PR** — "B-1 리스팅 배선 진행해" → #113 머지("머지
  직접 진행해"로 명시 승인). oci ssh 재개방(Tailscale 재인증 완료).
- **v22 크롤 실행** — "전체 리스팅 진행하고 이후에 바로 풀 크롤 돌려" →
  리스팅+sweep 자동 연쇄 가동. #114 핫픽스 머지 명시 승인.
- **two-TJ 검증** — "인터넷 검색으로 실제 레코드인지 구분… 무연결 유지+검증만"
  → 12개 번호 전건 실재 확인, #115 머지 승인.
- **무결정 배치** — "내 결정 없이 진행할 수 있으면서 v22 지장 없는 것들 모아서
  처리해" → #116–#122; "전부 머지" 승인. #123(배치 마감 docs) 머지 승인.
- **오너 결정 3건 (2026-07-10 말)** — ①v22 **candidate 빌드+커버리지 게이트
  사전승인**(승격은 별도 go) ②**R7 구현 go**(tjpdf→searchSong API 카탈로그)
  ③**§9 워치독 채널 종결**(전용 채널 없음, #117로 갈음).
- **미승인(명시적으로 남김)**: v22 승격(db/current 플립·배포), R5 KY 어댑터
  구현(서베이만 완료), §8 방향, blog-id, TJ filter seam, classifier Phase 2.

## Completed with evidence (이 세션, 전부 머지·CI green)

- **#113** fullCatalog 리스팅 도구(사이드카 재개, 커버리지 하드가드) —
  author→정적 리뷰 APPROVE→실사용 e2e APPROVE(sweep 소비까지 실증).
- **#114** HttpClient `cache:'off'`(무한 캐시 → V8 상한 크래시 치유; 488MB
  캐시 부검 확인) — 리스팅이 1131페이지부터 무손실 재개.
- **#115** two-TJ 6쌍 = **무연결-by-design 종결**(TJ 공식검색으로 12개 번호
  전건 실재; 브리지 항목 CLOSED).
- **#116** ROADMAP 스테일 정리(#107/#100/#106/#109 반영). **#117** R6
  라이브니스(수동 run success로 검증). **#118** R7 설계 문서(632/632 프로브
  증거). **#119** App.tsx 훅 추출(리뷰 APPROVE, 불변식 5종). **#120** 간체
  탐지기 report-only(76자, 리뷰 APPROVE — 전수 문자 대조). **#121** curated
  이동(드리프트 게이트 이빨 실증; 백로그 3건은 이미 089e8c5에 있었음).
  **#122** tjpdf 손상 제목 2건 + **#109 가드 정렬**(무음 되돌림 차단; REVISE
  1라운드). **#123** 배치 마감 docs(R5 KY 서베이 반영 포함).
- **KY(kysing.kr) 서베이 완료** — 공식 표면/robots 전허용/JSON API 없음/전수=
  번호 프로브/JP 제목검색 불신뢰. ROADMAP R5에 기록(#123), memory
  `ky-kysing-source-survey-2026-07-10`.

## Open items

- **In-progress ① v22 sweep** (oci, 세션 독립): 완료 감지 = status.txt에
  `SWEEP EXIT` → stage-2 자동 → `STAGE2 DONE total=… joysound=… coverage=PASS|FAIL`.
  다음 세션 첫 확인: `ssh ubuntu@oci 'tail -5 /srv/nas/karaoke/runs/data-2026-07-10-v22-fullcatalog/status.txt'`.
  PASS면 **오너에게 승격 go 요청**(승격 = 새 릴리스 디렉터리 + db/current 플립
  + 배포; in-place 수정 금지, 보존 current+1, 게이트는 최종 상태에서 재실행).
- **In-progress ② R7 author** (`author-r7-catalog`, 워크트리 kw-r7, 브랜치
  feat/r7-tjpdf-api-catalog): 프로브→커밋 카탈로그→오프라인 인제스트 교체 +
  **manual-fix 가드 6건 정렬 의무**(PK의 새 규칙 참조) + LLM 캐시 키잉 조사
  (제목 키면 중단·보고 조건). **머지는 금요 크롤 소킹 후로 홀드**(오케스트레이터
  결정 — 파이프라인 스텝 교체라 소킹 오염 방지).
- **Blocked(오너 승인): #124 머지** — §9 종결 + 이 체크포인트.
- **시간 게이트: 금요일(7/11) 주간 크롤 = 관찰 전용.** 첫 실전: #97 게이트,
  #106 패리티 재생성, #121 사이드카 경로, #122 제목 교정+가드, 라이브니스
  스케줄. 결과 보고만; 후속 작업은 오너 지시.
- **Deferred → ROADMAP**: R5 KY 스파이크(제안됨, 미승인), §8 방향(승격 전
  결정 요청됨), R3 스파이크, 간체 탐지기 배선(소킹 후), classifier 게이트
  재구조화, .tmp_review 정리, title_ko uncertain 13건.

## 영구 규칙 delta (이 세션 신규 — PK/ROADMAP에 반영됨)

- HttpClient 응답 캐시는 무한 성장 — 대량 열거는 `cache:'off'`(PK).
- **title_primary를 바꾸면 title-ko-manual-fixes 가드를 같은 변경에서 정렬**
  (무음 스킵; PK에 규칙+테스트 패턴).
- blog-* id 불안정/안정키 규칙, pnpm bail, 크롤 PR CI 미트리거 — 기존 유지.

## Next first action

1. `ssh ubuntu@oci 'tail -5 /srv/nas/karaoke/runs/data-2026-07-10-v22-fullcatalog/status.txt'` —
   v22 진행/완료 확인 (STAGE2 DONE + coverage=PASS면 승격 go 질문 준비).
2. `gh pr list --repo ghkim887/karaoke-search --state open` — #124(+R7 PR)
   상태 확인; R7 PR이 열려 있으면 리뷰 파이프라인(정적 필수) 후 소킹-홀드 유지.
3. 금요 크롤 run 결과 관찰·보고 (`gh run list --workflow crawl`).
