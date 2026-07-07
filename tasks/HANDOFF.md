# 세션 핸드오프 — ko 한국어 단독 + R4-4 + R1 전량 리뷰 (2026-07-05)

다음 세션이 stale 요약이 아니라 디스크/git/서버의 실제 상태에서 이어가도록 작성.
직전 버전(2026-07-04, v21 라이브)은 아래로 갱신됨. 2026-07-05 세션은 R2 잔여(ko
한국어 단독화)·R4-4(artistId 감사 신호)·R1(감사 결과 전량 웹리뷰)에 집중.

## Active goal

로드맵(docs/ROADMAP.md R1–R5) 순차 배송. 현재까지 **R1(감사 + 전량 리뷰),
R2(i18n+라이선스+footer+ko 한국어 단독), R4-1(ruby 검색), R4-4(artistId 감사
신호)가 main에 반영 완료**. reviewedMergePairs는 계속 누적 중이며 **다음 주간
크롤에 코퍼스로 적용**됨(현 코퍼스 v21에는 미반영).

## Current state of record

- **main**: `fb04ab5` == origin/main. 이번 세션 PR **#81–#88** 여덟 건 머지
  (전부 author/reviewer 독립 에이전트 검수 + CI(verify/e2e) 통과 후 squash).
- **서빙 DB**: hermes-host `db/current -> releases/data-2026-07-04-v21-title-ruby`
  (v21, 1.81 GiB, `/api/meta` → `2026-06-18`). **이번 세션 DB 릴리스 없음** —
  누적된 병합쌍은 다음 크롤 corpus에 적용. 롤백용 previous = v20.
- **라이브 웹**: karaokedb.pages.dev — **ko 크롬이 한국어 단독**(PR #81,
  2026-07-04 PowerShell wrangler 배포 + 실브라우저 검증 완료: 이중언어 잔재 0,
  라이브 검색 정상). 부제 `Karaoke Search` + 푸터 워드마크 `KARAOKE SEARCH`만
  브랜드로 영어 잔존. 한/영/일 스위처·MIT footer·실시간 DB 날짜·PWA 유지.
- **작업 클론**: scratchpad(세션 종료 시 소멸). 다음 세션은 새로 `git clone
  --filter=blob:none https://github.com/ghkim887/karaoke-search`.
  Z:\karaoke는 라이브 NAS 마운트(코드 작업 금지, 조회/데이터 전송용).
  ⚠️ 이번 세션 gotcha: 클론 node_modules에서 `@astrojs/markdown-remark/dist/
  types.js`가 중간에 유실돼 astro check/build/knip이 ERR_MODULE_NOT_FOUND로
  깨짐 → `corepack pnpm install --force`(재추출)로 복구(frozen install은 안 됨).

## Completed evidence (2026-07-05 세션)

1. **#81 ko 한국어 단독화**: i18n.ts ko 카탈로그 이중언어 19키 → 한국어 단독
   (aria-label 포함), `bilingual()` 헬퍼 제거, 푸터 disclaimer 로케일당 한 줄
   (`applyDisclaimer` ko→en 절 제거, Footer.astro en span `hidden`). 드리프트
   가드 테스트를 "byte-identical" → "ko Korean-only(브랜드 appSubtitle 예외)"로
   재작성. 배포 + 실브라우저 검증.
2. **#82 R4-4 artistId 감사 신호**: `scripts/build-joysound-artist-id-index.mjs`
   (NAS 상세 로그 150MB 스트리밍 → {joysoundNumberToArtistId, artistNameToArtistIds},
   gitignore), 감사에 `--artist-id-index` 플래그(candidate_artist_id/song_artist_ids/
   artist_id_match 컬럼). **핵심 발견**: match는 rename 자동승격이 아니라 tier-B
   동명이곡 **disambiguation aid**(실측 23 tier-A 매치, 0 tier-B). 순수 additive.
3. **#84 R1 tier-A 후속 + 감사 개선**: 확정 병합쌍 6건 인코딩; 감사
   `stripDecorations`가 `〈…〉`/`《…》` 태그 벗기도록 개선 → 재감사 tier A 39→50(+11).
4. **#85 R1 tier-A 배치2**: 〈〉로 발굴된 +11 리뷰 → 7 병합쌍(浜崎 GREEN 등),
   4 버전애매 보류.
5. **#86 R1 B티어**: 6개 병렬 웹검색 에이전트로 needs-review 118곡 리뷰 →
   **77 병합쌍 인코딩**(関ジャニ∞→SUPER EIGHT ~20, ENDLICHERI→ENDRECHERI,
   ナイトメア→NIGHTMARE, 한자/로마자/성우 크레딧). 코퍼스 분류 스크립트로
   표현불가 1(blog-428-4)만 배제.
6. **#87 R1 reject-set 감사**: 4 병렬 에이전트로 자동 리젝 65곡 검증 →
   **~29% false-reject 발견**(JOYSOUND가 한 아티스트에 여러 artistId 부여:
   世界の終わり=SEKAI NO OWARI, 개명, 성우-캐릭터), **14 병합쌍 복구**.
   → **R4-4 신호의 리젝 방향은 맹신 금지**(매치 방향은 고정밀).
7. **#88 R1 C-tier 검수**: 아티스트키 재후보(126곡) 9 병렬 에이전트 웹리뷰 →
   **19 표기변형 복구**(구자체 歸る=帰る·會津=会津, romaji↔카나 Ultra Relax·
   STAMINA, 부제/태그/깨진 프리픽스), 2 표현불가(ヒプマイ, 후보 자체 TJ).
   나머지 tier-C는 진짜 catalog gap(같은 아티스트·다른 곡 / 아티스트 부재).

**누적 reviewedMergePairs: Tier E = 191, Tier F = 161** (세션 시작 E84/F145).
전부 다음 크롤 때 코퍼스에 적용. **R1 감사 3개 티어(A/B/C) 전량 리뷰 완료.**

## Open items

- **크롤 소킹 게이트(다음 주간 crawl.yml 후 확인)**:
  1. 병합쌍(현 E191/F161, 세션 추가분 ~120)이 실제 적용됐는지(대상 곡 joysound
     번호 획득). 골든 스냅샷/baseline 재생성 시 게이트 재실행.
  2. 크롤러 ruby persistence(백필 미커버 ~70k곡).
  3. classifier Phase-1 골든 게이트 첫 소킹.
- **R1 잔여**:
  1. **머저 메커니즘 확장** — 확정됐으나 현 tier E/F로 인코딩 불가한 ~10쌍:
     후보가 자체 TJ 보유(tj-25103, tj-27098, tjpdf-28268, tjpdf-28871/28879),
     대상이 tj+ky 복수 번호(blog-1184-1/3, blog-487-11, blog-163-90, blog-428-4).
  2. **버전/VA 애매 보류 ~7건**(오너 판단): STILL 언어판(tj-26271/26350),
     BLACK DIAMOND 메이저/인디(tj-27017), ねねね 레코おと/본인영상(tj-52426),
     Various-Artists 플레이스홀더(tj-26410/26411/26827).
  3. C-tier(제목 매치 없음 145곡) 검수 **완료(#88)** — 19 표기변형 복구,
     나머지는 진짜 catalog gap. (더 파려면 아티스트키 후보 없던 19곡은 JOYSOUND
     자체 부재 확정.)
- **로드맵 백로그(우선순위 제안 순)**:
  1. R4-2 tieupNames → media_context / R4-3 lyricist·composer 인덱싱(원천:
     NAS runs/data-2026-06-14-.../joysound-detail-decision-log.jsonl 150MB).
  2. R4-4 Option B(artistId를 코퍼스 스키마에 영속화 → 미래 자동 병합) — 보류됨.
  3. R3 오프라인 전체 팩 / R5 ky·dam 준비(ROADMAP 참조).
- **오너 결정 보류**: ROADMAP.md Open-questions — 오프사이트 백업, 워치독 알림 채널,
  reading 필드 gram3 트림. **ko 한국어 단독화는 해소됨(#81 배송)**.
- **영구 규칙**: 권한/시크릿 느슨함 의도(수정 금지), release 디렉터리 in-place
  수정 금지(db/current 심링크), 보존 = current+1, 웹 빌드/wrangler는
  PowerShell에서(MSYS env 오염), 에이전트 게이트 = CI 미러(biome/-r typecheck/
  -r test/-r build/knip 고정), Pages 배포 후 실브라우저 검증 필수.

## Next first action

1. 주간 크롤 완료 대기 → "크롤 소킹 게이트" 3종 확인(병합쌍 적용·ruby 유입·
   골든 게이트). 문제없으면 새 corpus로 v22 릴리스 사이클(런북: README-ops
   "Release promotion runbook", 힌트 jsonl 포함 필수).
2. 또는 오너 지시대로 R1 머저 메커니즘 확장(표현불가 ~8쌍) / R4-2·R4-3 /
   버전 보류 판단부터 — 코드 작업은 전부 로컬 클론 + author/reviewer 독립
   에이전트 + CI 미러 게이트로.
