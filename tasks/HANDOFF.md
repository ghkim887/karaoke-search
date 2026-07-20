# 세션 핸드오프 — 2026-07-20 미병합 완결 사이클 + v25 승격 (#166~#169)

직전 정본(#157, 2026-07-16)을 갱신. 2026-07-20 하루에 **v24 승격 → 미병합
전수 검증 → K-pop/서양팝 유출 사냥 → 오너 판정 라운드 → 3-way 병합(B2) →
v25 재구성·승격**까지 완결했다. 미병합 결정 큐는 **소진**됐다.

## Current state of record

- **main = `8e81c3f`**(#169). 오늘 머지: #166(both-vendor 46곡 Tier E),
  #167(유출 11곡 per-song 드롭 + **drop-artist-leaks JOYSOUND-anchored
  가드** — corpus-level 아티스트명 드롭이 일본발매 101곡을 오폭하던 잠복
  결함 픽스), #168(오너 판정: forbidden 8 해제 + uncertain→merge 2,
  later-file-wins 판정 규칙), #169(**B2 리뷰드 3-way 어태치표 85곡** —
  dup-J 불변식 완화, 스펙 = docs/specs/2026-07-20-reviewed-3way-attach-design.md).
- **서빙 = v25 라이브**: `db/current → releases/data-2026-07-20-v25-reviewed-cleanup`
  (songs.sqlite 2,080,272,384B · **312,571곡** · SHA256SUMS). 체인 =
  v22 corpus + KY stripped2 재병합(out 313,353) → 무번호 드롭 771 →
  **drop-artist-leaks ko(−11, 101 spared)+zh(no-op)** → sqlite. 검증:
  v24 대비 −152 전량 귀속(병합 흡수 141 — 번호 보존 141/141·유실 0 + 유출
  11), 스팟 11/11(3-way 忘れていいの = tj 26145+ky 40449+joy 1546 한 행),
  joy 312,147 불변, 공개체인+실브라우저(콘솔 0) green. 이전 v24/v23 잔존,
  롤백 = 심링크 복귀. ⚠ `dbUpdatedAt`은 데이터 유래 날짜라 재구성 릴리스
  에선 안 변함(2026-07-16 표시가 정상) — 승격 검증은 데이터 스팟으로.
- **리뷰드 병합 표 최종 상태**: Tier E 271 · Tier F 482 · 3-way 어태치 85
  = 838 단위, 실코퍼스 발화 834 + 벤더번호 충돌 스킵 4(의도된 가드).
  판정 원천 = scripts/data/b-review-merge-verdicts/(A/B/C/D 시리즈).
- **미병합 최종 현황(v25 감사 424곡, 결정 필요 0)**: 진성 갭 244 + 사람
  reject 173 + 오너 무행동 종결 7(TJ 이중번호 4 — 두 번호 병행 실재라 두
  행 유지가 정답 / uncertain 3). 교차검증 리포트 =
  NAS runs/ky-v23-20260716/audit-v25/unmerged-xref.json.
- **운영 교훈 2건**: ①merge-ky 드라이버는 conservation FAILED 시 **의도적
  exit 3**(report-only go/no-go) — 체인 스크립트의 set -e가 여기서 끊긴다,
  exit 3 허용 처리 필수(초기 "Tailscale이 nohup 킬" 진단은 오진으로 정정)
  ②oci 장기 작업은 systemd-run transient unit + 라이브 트리 git 조작은
  oci(NAS 로컬)측에서(SMB는 부분 체크아웃/unlink 실패 함정).

## Grant Ledger (2026-07-20 세션)

- v24 승격 / #164~#169 머지 / stale 릴리스 삭제(오너 직접 `!` 실행) /
  유출 사냥·판정 라운드·B2 설계·구현 / v25 재구성·승격·정본 체크포인트 PR
  — 전부 오너 지시·승인으로 집행 완료.
- **미승인으로 남음**: 크롤 재개(오너 1.0 선언), R3 본구현.

## Open items

- **오너 결정 2건**: ①크롤 재개 시점(무기한 보류 유지 중) ②R3 오프라인
  풀팩 본구현.
- **크롤 재개 시 확인 목록(누적)**: #151/#152/#154 발효분 + #158/#159 KY
  색인 워크 실동작 + blog-ky graduation + **#162~#169 크롤타임 발효분**
  (KY 스트립·리뷰드 표 838 단위·유출 per-song 드롭·D3 프로브 차단) +
  parity baseline 재생성.
- 휴면: R4-2 타이업(장르 분류용 보류), R4-4 Option B, tjpdf 제목 오염
  3건(28477 "! 서유기" 접두 등 — #167 본문 후속 메모).

## Next first action

1. 새 세션: fresh clone → 이 정본 + 루트 포인터(`Z:\karaoke\HANDOFF.md`,
   더 상세한 당일 로그) 둘 다 읽기 → 오너 결정 2건 중 지시된 것 착수.
2. 크롤 재개 선언 시: 위 확인 목록 일괄 검증. 재배포/승격 절차는 memory
   `redeploy-runbook-worker-web` 참조.
