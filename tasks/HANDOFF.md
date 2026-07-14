# 세션 핸드오프 — 2026-07-14 blog 안정 식별자 출하 (#152)

직전 체크포인트(#151, 백로그 소진)를 갱신. 이 세션은 오너 결정 4건 중
**③ blog-id 안정 식별자**를 지시받아 설계→구현→검증→머지까지 완결.
오너 결정 잔여 = **3건: R3 본구현 / R5 KY 1k 스파이크 / 크롤 재개 시점.**

## Current state of record

- **main**: `6642136`(#152) — blog stable identity. PR CI green(verify 2m14s
  /e2e 54s), main push CI green. **열린 PR: 0.**
- **서빙 (oci)**: v22 라이브 유지 — 이 세션 서빙 무접촉. tracked baseline
  26,462 동결(코퍼스/parity baseline은 크롤 재개 시 재생성).
- **크롤**: `disabled_manually` 유지(재개 = 오너 1.0 선언).
- **#152 내용** (스펙 `docs/specs/2026-07-14-blog-stable-identity-design.md`,
  전부 오너 승인 D1–D5):
  - D1 SOURCE_RANK 강등 `tj>tjpdf>joysound>blog` — 병합 승자 id가 벤더
    안정 id로. KO_CHAIN(blog 최우선) 불변 = blog 고유 필드만 기여.
    `propagateArtistKo`는 KO_CHAIN에 핀(동작 동일, rank 커플링 제거).
  - D2 무번호 blog 행 드롭(현 데이터 483, 블로그 원문부터 `-`) +
    `--blog-drops-out` 리포트 아티팩트.
  - D3 역검색: standalone blog의 주장 번호 → TJ 프로브 시드 + JOYSOUND
    delisted/typo 리포트(`--reverse-lookup-out`). **갭: 프로브 자동 인제스트
    미배선**(문서화됨, 크롤 재개 전 후속).
  - D4 잔존 민팅 `blog-{artistId}-{vendor}-{번호}`(tj→ky→joysound 첫
    non-null, 중복 throw, 단일 파생함수 `mintBlogRecordId`). 스키마 무변.
  - D5 즐겨찾기 무변경 — 안정 id로 자동 해결. 기존 저장분은 id 전환 시
    무효(오너 웨이버). 발효는 크롤 재개 후 첫 릴리스.
  - 사이드카 재키잉(1회성): title_ko 캐시 blog 134 → 131 벤더id/2 잔존
    민팅/1 프룬(blog-376-104), search-hint `blog-338-10`→`blog-338-tj-28895`.

## 검증 증거 (#152)

- 게이트 5종(biome/typecheck/test/build/knip) — author 2회 + 오케스트레이터
  독립 재실행 green.
- **v22 양면 리플레이**(main@33371fe vs feat, 동일 입력 222MB decisions):
  313,553 레코드 1:1 바이젝션, id 플립 blog→joysound **20,843**, 필드 무변
  (허용 예외 = 분쟁 joysound 셀 2), 무번호 483 정확 일치, 충돌 0.
  보고서 = **PR #152 코멘트로 보존**(issuecomment-4965647963). 아티팩트
  (후보 2종·맵)는 스크래치패드 소멸성 — NAS `runs/` 쓰기권한 없어 미보존,
  decisions.jsonl(NAS)+두 커밋으로 재생성 가능. 맵은 이미 소비·커밋됨.
- 독립 리뷰어 **APPROVE**(rank 커플링 전수 감사, 재키잉 바이트 대조).

## Grant Ledger (이 세션)

- **blog-id 착수 + 기존 호환성 웨이버** — "3번 먼저. 기존과 호환성은 생각
  안 해도 돼" (2026-07-14).
- **설계 D1–D5 승인** — rank 강등/무번호 드롭("무번호는 드롭하자. 문서에만
  기록. 역검색 진행")/잔존 민팅+즐겨찾기 무변경("좋아").
- **완성까지 진행** — "플랜 스킵하고 완성까지 진행해" (구현·검증·PR).
- **머지 명시 승인** — "머지해" (#152; auto-mode 분류기가 포괄 그랜트로는
  머지 불허 → 명시 승인 후 집행).
- **미승인으로 남음**: 크롤 재활성화(오너 1.0 선언), R3 본구현, R5 KY
  스파이크.

## Open items

- **오너 결정 3건**: ①R3 오프라인 풀팩 본구현 ②R5 KY 1k 프로브 스파이크
  (권장 첫 수) ③크롤 재개 시점.
- **크롤 재개 시 확인 목록(누적)**: 기존 캐시 발효분(#151 목록: 제목 승격
  49·오분류 회수 22·미디어 컨텍스트 96·프룬 19·재키잉 3) + **#152 발효분**:
  무번호 −483, 병합 레코드 벤더 id 전환(리플레이 기준 ~20.8k+), 재키잉
  사이드카 매치 확인, parity baseline 재생성(기존 정책), **TJ 역검색 시드
  프로브 인제스트 배선**(코드 갭 — 재개 전 소작업), 297 충돌-널 잔존의
  실크롤 귀결 확인(PK에 규칙 기록됨).
- **휴면(무조치 결정 존중)**: #151과 동일(title_ko uncertain 13 /
  interior-ws 24 / R4 잔여 / korean 사이드카 서술 감사).

## Next first action

1. 새 세션: fresh clone → 이 정본 → 오너 결정 3건 중 지시된 것 착수.
2. 크롤 재개 선언 시: TJ 역검색 시드 인제스트 배선 선행 → 재개 첫 크롤
   PR에서 #151+#152 발효분 일괄 확인.
