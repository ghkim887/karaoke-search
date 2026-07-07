# Post-JOYSOUND Data Topology — 결정 문서

작성: 2026-06-10 (detail sweep 진행 중 기준). 대상: docs/ROADMAP.md Open-questions section (post-JOYSOUND data topology).
모든 수치는 이 repo에서 직접 측정/검증했고, 추정치는 [추정]으로 표시함. 검증 내역은 맨 아래 부록.

## TL;DR — 권고안

**하이브리드 (A′+C): tracked `songs.json`은 현재 25.8k baseline 그대로 유지(= offline 번들 겸 weekly crawl PR 리뷰 대상), JOYSOUND가 합쳐진 full corpus(~221k, 85.5 MB)는 git 밖으로 — crawl마다 GitHub Release asset으로 발행하고 git에는 manifest(sha256/url/counts/date)만 commit. D1 import와 self-host SQLite build는 그 asset을 소비.**

이유 요약: (1) full corpus는 이미 GitHub 50 MB warn 구간(85.5 MB)이고 100 MB hard block까지 여유가 적다. (2) wire size(gzip 9.6 MB)가 아니라 **클라이언트 index build가 진짜 병목**(측정: desktop Node에서 heap 316 MB / build 5.7s → 폰에서는 사실상 사용 불가). (3) weekly crawl은 JOYSOUND detail을 재생성하지 않으므로(detail crawl ~33h) full corpus의 갱신 주기는 어차피 baseline crawl과 분리됨 — tracked baseline + 별도 artifact가 자연스러운 구조. (4) crawl job이 이미 `contents: write` 권한을 가져서 Release 발행에 **신규 secret이 0개** 필요.

---

## 1. Forcing function — 어떤 한계가 언제 깨지나

현재 corpus: **25,842 records / 10.87 MB / gzip 1.36 MB** (측정).
JOYSOUND listing-sweep candidate (`.tmp_review/joysound-sweep-2026-06-09/songs-candidate.json`): **221,075 records / 85.5 MB / gzip 9.58 MB** (측정, ~387 B/record). 2026-06 dry-run 상한 236k면 ~91 MB [추정]. 진행 중인 detail crawl 결과물도 같은 규모.

| 한계 | 수치 | 깨지는 시점 |
| --- | --- | --- |
| GitHub blob push | 50 MB warn / **100 MB hard block** (외부 사실) | 85.5 MB는 이미 warn. hard block까지 +17% 성장 여유. 매주 push마다 경고. |
| Cloudflare Pages per-file | 25 MB (runbook §2도 인용) | 이미 3.4배 초과. 현재는 GitHub Pages라 당장은 안 깨지지만 CF Pages 이전 옵션이 영구 봉쇄됨. |
| 클라이언트 offline UX | wire gzip 9.58 MB는 견딜 만함. **그러나 JSON.parse 85 MB + MiniSearch 221k×5필드 build = heap 316 MB / RSS 485 MB / 5.7s (desktop Node 측정)** | 폰에서 3–5x 느림 → 20–30s 멈춤 + ~0.5 GB 메모리 → 모바일 탭 kill 수준 [추정]. **wholesale offline 모델은 이 규모에서 사망.** |
| git clone/history 성장 | 현 이력: songs.json blob 35개, 비압축 382 MiB → pack 15.34 MiB (~25:1, 측정) | 85 MB 주간 스냅샷이면 같은 비율로도 pack +~3.4 MB/주 ≈ **+175 MB/년** [추정]. `crawled_at`이 매 crawl 전 record 재작성되는 것도 확인 — delta가 깨끗하지 않음. |
| PR CI (`d1:verify-sql`) | ci.yml이 **모든 PR마다** committed corpus에서 D1 SQL export + 전 record Ajv 검증. 236k 규모 dry-run 측정 **946 MB SQL** | 깨지진 않음(WS-A streaming으로 OOM 해결 증명) — 그러나 PR마다 ~1 GB 디스크 쓰기 + 221k 검증 + 85 MB blob checkout. 비용만 늘고 가치는 그대로. |
| D1 free tier | 500 MB DB cap vs 946 MB SQL import | import 후 `wrangler d1 info --remote`로 측정 (deploy-time check, ROADMAP.md Open-questions). 초과 가능성 높음 [추정] → self-host 탈출구는 이미 존재 (`node-server.ts`, 008d453). |

핵심 반전: **다운로드 용량(9.6 MB gzip)은 문제가 아니다. 브라우저 메모리/CPU가 문제다.** 따라서 "full corpus를 계속 번들"하는 선택지는 git 한계 이전에 UX에서 먼저 죽는다.

## 2. Options matrix

| | A: full corpus tracked + offline top-N subset | **B: git 밖 → R2 + manifest** | **C: GitHub Release asset + manifest (권고)** | D: status quo, JOYSOUND 보류 |
| --- | --- | --- | --- | --- |
| weekly PR 리뷰 | 85 MB diff는 GitHub UI 렌더 불가 → PR body 요약만 | manifest diff + delta report (`compareCorpora`가 이미 `scripts/lib/corpus-audit-guardrails.mjs`에 존재) — 사실상 리뷰 품질 **향상** | B와 동일 + **baseline songs.json diff는 지금 그대로 유지** | 현행 유지 |
| crawl.yml 변경 | subset 생성 step 추가 | R2 업로드 step + **CF API token secret 신규** (현재 CI에 CF secret 전무 — 검증) | `gh release create` step (crawl job에 `contents: write` 이미 있음 — 검증, secret 0개) | 없음 |
| deploy.yml 변경 | subset만 dist에 포함 | 변경 없음 (tracked baseline이 offline 번들) | 동일 | 없음 |
| local dev | tracked corpus 사용 (85 MB clone) | fetch script로 R2 다운로드; offline은 tracked baseline | `gh release download` 또는 curl; offline은 tracked baseline | 현행 |
| schema validation gate | ci.yml 현행 (PR마다 221k 검증, 비쌈) | crawl 시점 (pipeline `validate-songs-json` 현행 유지) + import 전 sha256+검증; ci.yml은 baseline만 검증 (현행 그대로, 저렴) | B와 동일 | 현행 |
| rollback | git revert (85 MB blob 또 추가) | manifest revert + 이전 object로 D1 재import | manifest revert + 이전 release tag로 재import. asset은 불변 | git revert |
| cost | $0 | R2 free 10 GB ≈ 주간 스냅샷 ~2년치, 이후 prune | $0 (release asset 2 GB/file, public repo 무제한급) | $0 |
| 치명 결함 | **git 100 MB 시한폭탄 + clone +175 MB/년 + subset 선정 기준 부재(인기도 데이터 없음)** | 신규 secret + Cloudflare 콘솔 의존 | release 목록이 data tag로 채워짐 (미관) | **detail crawl·adjudication(175 ALLOW) 투자 전부 사장** |
| effort | M | M | **S–M** | S |

B vs C는 근소함. C를 권고하는 결정적 차이: **신규 credential 0개** + 자산이 repo와 같은 곳에서 공개·불변·버전드. manifest를 store-불문 스키마(`{ url, sha256, recordCount, vendorCounts, generatedAt, baselineCommit, decisionLogSha }`)로 설계하면 나중에 R2 전환은 url 필드 교체 1줄이다. Worker가 corpus 원본을 직접 읽을 일은 없으므로(Worker는 D1만 봄 — 검증) R2의 "Cloudflare 동일 계정" 이점은 현재 무의미.

A 단독은 권고하지 않음: top-N subset을 뽑을 인기도/재생수 데이터가 corpus에 없다(검증 — record 필드는 title/artist/numbers/crawled_at뿐). 자연스러운 "subset"은 결국 현행 baseline(blog+TJ) 그 자체 → 그게 바로 권고안의 tracked 파일이다.

## 3. Self-hosting과의 상호작용

검증된 사실: self-host 경로는 `apps/worker/src/node-server.ts`(`serve:node`, `KARAOKE_SQLITE_DB_PATH` env 필수) ← `scripts/build-sqlite-db.mjs --input <songs.json>`이 SQLite를 빌드. 즉 **self-host 박스는 corpus JSON(또는 미리 빌드된 .sqlite)을 어디선가 받아야 한다.**

- A(tracked)면: self-host가 85 MB+이력 git clone을 해야 함 — 최악.
- B/C(artifact)면: `curl <manifest.url> | sha256 검증 → build-sqlite-db` 한 줄. **D1 → self-host 전환 비용이 거의 0이 됨.**
- 보너스: compose 시점에 `.sqlite` 자체를 두 번째 asset으로 같이 올리면 self-host는 빌드 단계도 생략.

결론: D1 500 MB 초과가 유력한 상황(946 MB SQL)에서 self-host가 expected path라면, **corpus를 artifact화하는 B/C의 순위가 더 올라간다.** A는 self-host 시나리오에서 추가 감점.

## 4. 권고 마이그레이션 절차

전제: feature branch의 WS-A/B/C 코드 commit(runbook §2, CHECKPOINT 1 — 175 ALLOW spot-check)이 선행. 진행 중인 detail crawl(~33h) 완료 + Layer-3 재샘플링(≥99%) 통과 후 데이터 단계 진입.

1. **PR-1 (code — 지금 준비 가능, 결정 불필요):**
   - `scripts/publish-full-corpus.mjs`: candidate build(기존 `build-joysound-candidate.mjs` 재사용) → `validate-songs-json` → manifest 생성(store-agnostic 스키마) → (옵션) `.sqlite` 동시 빌드.
   - `scripts/fetch-full-corpus.mjs`: manifest 읽고 다운로드 + sha256 검증 (local dev / self-host / D1 import 공용).
   - manifest 검증 unit test.
2. **PR-2 (workflow — 결정 후):**
   - 신규 `full-corpus.yml` (workflow_dispatch): compose → `gh release create data/<date>-<run_id>` (asset: full corpus JSON [+ sqlite + decision-log]) → manifest commit PR. weekly `crawl.yml`은 **변경 없음** (baseline 경로 그대로 — 리뷰 스토리 보존의 핵심).
   - `ci.yml`: 변경 없음 (`d1:verify-sql`은 tracked baseline 대상 유지). manifest sha 검증 step만 추가(저렴).
3. **PR-3 (deploy — 결정 후):**
   - `deploy.yml` e2e FALLBACK-mode build (ROADMAP.md Open-questions — e2e는 `f260f53` 이후 required gate라 API-first 배포 **이전/동시** 필수).
   - 첫 release 발행 → 수동 D1 import (`KARAOKE_D1_REMOTE_OK=1`, ~2k+ chunks, 비원자적 — 모니터링) → `wrangler d1 info`로 500 MB 측정 → 초과 시 self-host 전환 → worker/web deploy.
4. **후속:** D1 incremental import(주간 946 MB 전체 재import는 지속 불가 — full corpus 갱신 주기를 분기/월간 dispatch로 시작), ROADMAP.md Open-questions (post-JOYSOUND data topology) 종결 문서화.

**결정 전에 준비 가능:** PR-1 전체, manifest 스키마, 테스트 tag로 release dry-run, 이 문서.
**결정을 기다려야 하는 것:** workflow 변경(PR-2/3), 실제 release 발행, D1 import, ROADMAP.md Open-questions 갱신.

## 5. Decision checklist (owner가 답할 yes/no)

1. **Full corpus(~221k)를 git 밖으로 빼는가?** → 권고 **YES** (UX·git 한계 모두에서 tracked 모델은 사망 확정. §1)
2. **Artifact store는 GitHub Release인가 (R2 대신)?** → 권고 **YES** (secret 0개, 불변 버전드, 무료. manifest가 store-agnostic이라 R2 전환은 후일 1줄)
3. **Offline 번들 = 현행 25.8k baseline 유지인가 (신규 top-N 선정 없이)?** → 권고 **YES** (인기도 데이터 부재. baseline이 이미 검증된 고품질 subset이고 weekly PR 리뷰 스토리가 그대로 살아남음)
4. **Full corpus D1 import는 weekly 자동이 아닌 dispatch 수동 cadence로 시작하는가?** → 권고 **YES** (946 MB SQL / 2k+ chunk 비원자 import는 주간 자동화 부적합; incremental import는 후속 과제)
5. **D1 측정값이 500 MB 초과면 즉시 self-host로 전환하는가?** → 권고 **측정 후 즉시 YES** (runbook §4의 expected path; artifact 방식이면 전환 비용 거의 0 — §3)

---

## 부록: 검증 vs 추정

**직접 측정/검증:** corpus 25,842 records·10,875,072 B·gzip 1,356,131 B; candidate 221,075 records·85,540,971 B·gzip 9,580,495 B; MiniSearch 221k build = parse 527 ms·index 5,665 ms·heap 316 MB·RSS 485 MB (이 호스트 Node 24); git 이력 songs.json blob 35개·비압축 382 MiB·pack 15.34 MiB; `crawled_at` 전 record 보유; crawl job `contents: write`·CI에 Cloudflare secret 부재; `ci.yml` L53 `d1:verify-sql`이 매 PR 실행; `node-server.ts`의 `KARAOKE_SQLITE_DB_PATH` 필수·`build-sqlite-db.mjs` 기본 입력이 tracked songs.json; `compareCorpora` 존재; deploy는 GitHub Pages(`actions/deploy-pages`)이며 Cloudflare Pages 아님; e2e가 required gate(`needs: [build, e2e]`); 946 MB SQL은 runbook/ARCHITECTURE 기록(2026-06 dry-run) 인용.

**추정:** 폰에서의 index-build 배속(3–5x)·탭 kill; pack 성장률(+175 MB/년, 25:1 비율 외삽); D1 DB 실측 크기(>500 MB 유력하나 미측정 — deploy-time check); 236k 시 ~91 MB. **외부 사실(미실측):** GitHub 50/100 MB 한계, Cloudflare Pages 25 MB/file, R2 free 10 GB, Release asset 2 GB/file.

참고: README/CLAUDE.md의 `tj-search-cache.json` ~5.5 MB 표기는 stale — 현재 1.4 MB (측정, 무해).
