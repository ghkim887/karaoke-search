# 세션 핸드오프 — 2026-07-16 워커+웹 재배포 + funnel origin 리네임 커밋화 (#156)

직전 체크포인트(#155, blog 안정 식별자 #152+#154)를 갱신. 이 세션은 오너
지시("재배포 해")로 **서빙 3표면 중 뒤처져 있던 워커·웹을 재배포**하고,
그 과정에서 발견한 **미커밋 배포 지뢰(hermes-host→oci 리네임)를 PR #156으로
커밋화 후 머지**(오너 명시 승인)까지 완결했다.
오너 결정 잔여 = **3건: R3 본구현 / R5 KY 1k 스파이크 / 크롤 재개 시점.**

## Current state of record

- **main**: `ac7fb4f`(#156 squash) — funnel origin hermes-host→oci 3파일 3줄
  (`apps/web/functions/api/[[path]].js`, `functions/healthz.js`,
  `wrangler.toml`). PR CI green(e2e/verify). **열린 PR: 이 체크포인트뿐.**
- **왜 #156이 필요했나**: 2026-07-08경 호스트 리네임(hermes-host→oci)이
  **라이브 NAS 트리의 미커밋 로컬 수정으로만** 존재했다. main 그대로 웹을
  배포하면 Pages 프록시가 죽은 호스트명을 가리켜 API가 끊기는 상태.
  이제 main == 라이브 배포 상태로 수렴.
- **워커 재배포 (oci)**: 라이브 실행 트리 `/srv/nas/karaoke/app`
  (`/srv/karaoke`는 심링크; `karaoke-api.service`가
  `app/apps/worker/dist/node-server.js` 직접 실행)를 3c47b05→main으로 ff,
  `corepack pnpm --filter @karaoke/worker... build`,
  `sudo systemctl restart karaoke-api`. 이전 로컬 수정은 stash
  `pre-redeploy-20260716`에 보존. **라이브 워커가 이제 #93~#148 serve측
  픽스 포함**(직전엔 2026-07-03/04 빌드로 8PR 뒤였음).
  검증: healthz ok / api/meta 2026-07-12 / 검색 정상 / journal 클린 /
  공개체인(oci.tail04d970.ts.net + karaokedb.pages.dev/api/meta) ok.
- **웹 재배포 (Pages)**: production `5de27093`(--branch main, source
  f9d0498=#156 내용). 직전 production은 3c47b05(1주 전). 실브라우저 검증:
  アイドル 50건 렌더(YOASOBI TJ 68781/KY 44923/JOY 616010), **ko 크롬
  한국어 단독 유지**, DB 날짜 2026-07-12, 콘솔 에러 0.
  ⚠️ 교훈: `wrangler pages deploy`는 **`--branch main` 없이는 프리뷰**로만
  올라간다(첫 시도가 그랬음).
- **oci SSH 복구 확인**: Tailscale SSH 정상(이전 "호스트키 보류" 해소),
  passwordless sudo 가용.
- **서빙 DB = v22 유지(무접촉)**. 크롤 `disabled_manually` 유지.
- **라이브 트리 고아 문서 2건**(main에 없음, 언트랙 보존 — 커밋 후보):
  `docs/runbooks/2026-07-08-soak-crawl-gates.md`,
  `docs/specs/2026-07-08-search-hint-channel-and-dead-schema-cleanup.md`.

## Grant Ledger (이 세션)

- **워커+웹 재배포** — "재배포 해. oci 아마 해결됐을거야" (2026-07-16).
  라이브 트리 git 갱신·서비스 재시작·Pages 프로덕션 배포 포함. 실행 완결.
- **PR #156 머지** — "머지 승인" (2026-07-16). 집행 완료(squash, ac7fb4f).
- **미승인으로 남음**: 크롤 재개(오너 1.0 선언), R3 본구현, R5 KY 스파이크,
  고아 문서 2건 커밋 여부.

## Open items

- **오너 결정 3건**: ①R3 오프라인 풀팩 본구현 ②R5 KY 1k 프로브 스파이크
  (권장 첫 수) ③크롤 재개 시점.
- **크롤 재개 시 확인 목록(누적, #155와 동일)**: #151 캐시 발효분 + #152
  발효분(무번호 −483, 벤더 id 전환 ~20.8k+, parity baseline 재생성) +
  #154 시드 프로브 첫 실동작(`[tj-seed]` 라인) + 297 충돌-널 잔존 귀결.
- **고아 문서 2건 커밋 여부**(위) — 오너 판단.
- **휴면(무조치 결정 존중)**: #151과 동일.

## Next first action

1. 새 세션: fresh clone → 이 정본 → 오너 결정 3건 중 지시된 것 착수.
2. 크롤 재개 선언 시: 재개 첫 크롤 PR에서 #151+#152+#154 발효분 일괄 확인
   (선행 작업 없음). 웹/워커 재배포 절차는 memory
   `redeploy-runbook-worker-web` 및 이 문서 "재배포" 절 참조.
