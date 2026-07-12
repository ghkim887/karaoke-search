# 세션 핸드오프 — v22 승격 + 무결정 라운드 2회 완결 (2026-07-12 18:30 KST 체크포인트)

직전 체크포인트(2026-07-11 00:10, #124)를 갱신. 이후 진행: ①크롤 게이트 첫
실전(유출 2행 차단→검증→#126) ②**v22 승격**(오너 go) ③오너 3결정 집행
④무결정 라운드 2회(#128–#131) ⑤**자동 크롤 무기한 보류**(오너 지시).

## Current state of record

- **main**: `4ee5527` (#131까지; #131 main push CI는 폴링 중이었음 — 다음 세션
  `gh run list --branch main --limit 1`로 확인; 직전 #130 상태까지 전부 green).
  **열린 PR: 0.**
- **서빙 (oci)**: `db/current → releases/data-2026-07-12-v22-fullcatalog` —
  **v22 라이브** (313,467곡 / joysound 312,170 / ruby 91.7% / SQLite 2.08GB).
  공개 체인 검증 완료(meta `dbUpdatedAt 2026-07-12`). 보존: v22+v21(v20 삭제).
  롤백 = 심링크를 v21로 + `sudo systemctl restart karaoke-api`.
- **자동 주간 크롤: 무기한 보류(오너)** — workflow `disabled_manually`
  (스케줄+수동 디스패치 모두 차단). 재활성화 =
  `gh workflow enable crawl.yml` — **오너의 "배포" 조건 확인 후에만**.
  오너가 "검증용 크롤은 곧 진행" 예고 — 그 1회가 #125·#126·#128·#129·#131을
  일괄 실전 검증하게 됨(재활성화→디스패치→관찰→재비활성화 순서 권장).
- **oci 잔여물**: tmux 세션 0(전부 자연 종료). `~/v22/` 클론들(스윕·stage2·
  r7probe 워크트리)은 소멸성 — 다음 대형 작업 때 재사용/삭제 자유. NAS 런
  디렉터리 `runs/data-2026-07-10-v22-fullcatalog/`는 보존(결정로그 340,653행
  = classifier Phase 2의 외국명 분포 샘플; listing/candidate/discovery 포함).
- **작업 클론**: scratchpad `kwork` — 소멸성, 다음 세션은 fresh clone.

## Grant Ledger (2026-07-12 라운드)

- **v22 승격 go** — "승격하고…" → 빌드→플립→재시작→검증→보존정리 완료.
- **무결정 일괄 진행** — "내 결정 없이 진행 가능한 것들 전부 진행" →
  간체 풀코퍼스 캘리브레이션(0/313,467), R1 4쌍 확인(자동해소 안 됨 —
  ROADMAP 교정), 마감 docs #127.
- **유출 2행 처리** — "진행해" → 웹검증(IVE Will=일본 원곡 ALLOW /
  프리큐큐=한국어판 DROP) → #126 머지 → 크롤 재시도 디스패치.
- **자동 크롤 무기한 보류** — "일단 자동 크롤은 아예 캔슬해버려. 배포
  전까지는 무기한 보류다." → run 취소 + workflow disable 집행.
- **6·7·8·9 진행** — R7 발견 스윕 / R3 스파이크 / 간체 크롤 배선 / 캐시
  드리프트 측정·재키잉 → #128·#129·#130·#131 전부 오너 승인 머지.
- **#124·#125·#127~#131 머지** 전부 명시 승인("승인." / "전부 머지" /
  "머지하고 /handoff").
- **미승인으로 남음**: 크롤 재활성화(오너 "배포" 조건), §8 백업 방향,
  TJ filter seam·classifier Phase 2 보류 해제, blog-id.

## Completed with evidence (2026-07-11~12)

- **크롤 게이트 첫 실전**: 토요 정기 run이 #97 게이트에서 유출 2행 차단
  (크롤 PR 미오픈, main 무사) → TJ 곡 단위 신호 + 웹검증 →
  **#126**(IVE allow+render 1행 스코프 / CUTIE STREET 곡 단위 드롭).
- **v22 승격**: 커버리지 게이트 PASS(+5,348) → SQLite 빌드 exit 0 →
  플립·재시작 → 공개 체인 검증 → prune. 소킹: Tier E #110 5쌍 첫 발효,
  퍼지 유지, 간체 0/313k.
- **#127** 마감 docs(승격 기록·크롤 보류·R1 4쌍 교정·가드 규칙 일반화).
- **#128** 간체 크롤 리포트 배선(compose 계층, fail-soft, 리뷰 마이너 반영).
- **#129** 캐시 재키잉 — **+149 한국어 제목 복원 대기**(리뷰어가 변환
  재실행으로 바이트 동일 검증; 24건 interior-ws는 의도적 잠금).
- **#130** R3 스파이크(클라 DB 75MiB/21.6MiB 다운로드; 2자 CJK에서 FTS5
  0건 실증 → 하이브리드 필수; GO×2 판정).
- **#125+#131** R7 완결: PDF 인제스트 은퇴 → API 카탈로그(933곡) +
  발견 스윕 298곡 추가(실질 신규 240, K-pop 58은 드롭리스트 정상 차단).

## Open items

- **다음 이벤트 = 오너의 검증용 크롤**: 절차 ①`gh workflow enable crawl.yml`
  ②`gh workflow run crawl` ③관찰(게이트 통과 여부·크롤 PR의 패리티 델타+
  간체 섹션·+149 복원·240 신규 tjpdf 유입·#126 렌더) ④크롤 PR 리뷰→오너
  머지 ⑤**재비활성화**(보류 유지 조건이면). 크롤 PR엔 ci.yml이 안 돌므로
  게이트가 유일 방어선임을 기억.
- **오너 결정 대기**: §8 백업 방향(v22 유일본 2.2GB), 크롤 재개 시점,
  TJ filter seam(3번째 재발로 근거 강화)·classifier Phase 2(전제 충족) 해제.
- **Deferred → ROADMAP**: R5 KY 스파이크(승인 대기), interior-ws 24건,
  title_ko uncertain 13건 + 신규 240곡 번역 백로그, R5-DAM, R4-2/-4,
  classifier 게이트 재구조화, .tmp_review 정리, R3 본구현(스파이크 완료).

## 영구 규칙 delta (이 라운드 신규)

- title_primary 가드 규칙이 **양 표면**(manual-fixes + Stage-2 캐시)으로
  일반화됨(PK 반영, #127). 재키잉 도구 `scripts/rekey-llm-translation-titles.mjs`
  재사용 가능(blog 가드는 크롤마다 다시 드리프트).
- 크롤 workflow는 오너 보류 중 `disabled_manually` — enable도 오너 게이트.

## Next first action

1. `gh pr list --state open` + `gh run list --branch main --limit 1` —
   0 PR·#131 CI green 확인.
2. `ssh ubuntu@oci 'readlink /srv/nas/karaoke/db/current; systemctl is-active karaoke-api'` —
   v22 서빙 확인.
3. 오너가 검증용 크롤을 지시하면 위 Open items의 5단계 절차로.
