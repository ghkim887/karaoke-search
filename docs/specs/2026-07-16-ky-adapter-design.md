# KY(kysing.kr) 크롤 어댑터 설계 (2026-07-16)

오너 승인 이력: Q1(스코프 jp만)·Q2(rank A)·Q3(절단 보정 A)·Q4(기본세트 A)·
Q5(YAGNI 제외 확정) → 관례 감사 개정(joysound식 classifier 등) →
"바로 구현 시작해"(2026-07-16, 스펙 리뷰 게이트 웨이버). 소스 근거 =
`docs/research/2026-07-16-ky-smart-enumeration-resurvey.md`.

## D1. 컴포넌트 — `packages/crawler/src/adapters/ky-kysing/`

source 식별자 `ky-kysing`, 레코드 id `ky-{번호}`(슬러그 'ky').

- **crawler.ts** — `KyKysingCrawler(http, options?)`. 색인 워크:
  `GET https://kysing.kr/karaoke-book/?city=jp&s_cd=2&keyword={색인문자}&s_page={n}`.
  색인문자 = `KY_KARAOKE_BOOK_INDEX`(export `as const`, 가나 전수+其他+A–Z+ETC
  ≈104종 — 라이브 색인 진입 페이지에서 실측 확정) + 생성자 옵션으로 서브셋
  오버라이드(테스트용, JOYSOUND_FULL_CATALOG_KANA 선례). s_page 1부터 행 0개
  까지 워크(총페이지 미표기). 곡번호 기준 dedup. **CrawlOptions.limit =
  yield 레코드 캡(joysound식) 필수 존중.** crawled_at은 런당 ISO 1개.
- **parser.ts** — 색인 행(`index_search_num`/`index_search_tit`/
  `index_search_sng`) 파싱, 페이지네이션(행 0 종료), **절단 감지**(말미 `..`
  / 미닫힌 괄호 / 최대 표시폭 도달 — 폭 상수는 fixture 실측으로 확정),
  상세 페이지(`/search/?category=1&keyword={번호}`) 파싱(전체 제목/아티스트).
- **normalizer.ts** — SongRecord 조립: id `ky-{번호}`, `source_url =
  https://kysing.kr/search/?category=1&keyword={번호}`(곡번호별 안정
  백링크), `karaoke_numbers {tj:null, ky:번호, joysound:null}`,
  `title_ko/artist_ko = null`(KY는 한국어 기여 없음), `artist_aliases`
  미설정(파이프라인 resolveArtistAliases 중앙 처리). 스키마 변경 없음.
- **classifier.ts** — joysound식 `{admit, reason}` 닫힌 enum 단일 분류기.
  판정 순서(고정): reviewed-allow → reviewed-drop → 큐레이션 드롭리스트
  (`curated/koreanArtistDropList`·`chineseArtistDropList` 재사용) →
  스크립트 가드(#143 미러 `readsAsKoreanScript` + 간체-Han) → admit.
  reason enum: `reviewed-allow | reviewed-drop | drop-korean-artist |
  drop-chinese-artist | drop-korean-script | drop-simplified-han |
  admit-index | admit-detail-repaired`.
- **reviewedKySongOverrides.ts** — 빈 allow/drop 리스트(ky 번호 키) day1
  배선(isReviewedKyAllow/Drop). 소킹 오분류를 코드 재배포 없이 교정하는 훅.
- **공유 정규화** — `normalizeKyNumber`(digits-only 정규형) 단일 함수를
  KY 어댑터와 blog 파서 ky 경로가 공유(Tier A union이 정확 문자열 일치라
  정규형 불일치 시 병합 조용히 실패). `NUMBER_LENGTH_CAPS.ky=6` 정합 유지.
  스키마 `karaoke_numbers.ky`에 `^[0-9]+$` 패턴 추가는 **기존 blog ky 값
  전수 digits 검증 통과 시에만**(additive 하드닝).
- **등록** — `buildAdapters()` 기본세트에 추가(blog·tj와 동일 프로세스,
  crawl.yml 스케줄에 자동 편승).

## D2. 절단 보정

절단 의심 행만 상세(category=1) 1요청으로 전체 제목/아티스트 대체. 작곡·
작사·출시월은 버림(R4-3 제외 결정). 보정 실패(상세 0행/불일치) = 드롭 +
decisions 기록(step `truncation-repair`, reason `detail-fetch-failed`) —
절단 제목을 코퍼스에 넣지 않는다(검색 인덱스 오염 + Tier B~G 병합 실패 방지).

## D3. HTTP/정중함

`http.ts` `ALLOWED_HOSTS`에 kysing.kr 추가(pathPrefixes: /karaoke-book,
/search), `HOST_CONFIG` 500ms(TJ와 동일). robots/재시도/조건부 캐시는 기존
상속(기본값 유지 — 수백 URL 규모라 무해). 예상 총량: 색인 ~150–200 +
절단 보정 수백 이하.

## D4. 병합 통합

- `merge.ts` `SOURCE_RANK = {tj:1, tjpdf:2, joysound:3, ky:4, blog:5}` —
  기존 joysound 병합승자 id 유지(id 전환 이벤트 최소화, Q2=A).
- `TITLE_ARTIST_CHAIN` 말미에 'ky'(절단 리스크 있는 KY 제목이 상위 소스를
  이기지 않음). `KO_CHAIN` 무변경(KY는 ko 기여 없음).
- Tier A(벤더 번호 union)는 기존 배선으로 무변경 동작.
- **캐비엇**: blog ky-민팅 잔존(`blog-{aid}-ky-{번호}`)은 라이브 `ky-{번호}`
  와 Tier A 병합 → rank상 ky 승리 → id graduation(기존 TJ graduation과
  동일 메커니즘). 대상 수는 구현 리플레이로 산출해 PR에 보고.
- 발효는 크롤 재개(오너 1.0 선언) 후 첫 릴리스부터.

## D5. 에러 처리

색인 페이지 fetch 실패(재시도 소진) = **어댑터 하드 어보트**(커버리지 홀
방지, JOYSOUND 원칙). 개별 행 파싱 실패 = decisions `row-parse-error` 기록
+ 스킵, 스킵 비율 임계(1%) 초과 시 어보트.

## D6. 테스트

- fixtures `test/fixtures/ky/` 커밋(라이브 캡처: jp 색인 페이지, 절단 행
  포함 페이지, 빈 페이지, 곡번호 상세 페이지 — 캡처는 정중하게 소수 요청).
- 파서 단위 / normalizer 불변식 / classifier(enum 전 분기+오버라이드 순서)
  / fake-http 크롤러(색인×페이지 워크 종료, 절단 보정 경로, dedup, limit 캡)
  / merge rank(joysound vs ky 승자 id, blog-ky graduation) 테스트.
- SOURCE_RANK 변경에 따른 기존 merge 테스트·골든 병합 스냅샷 갱신(게이트는
  최종 상태에서 재실행 — 관례).
- 라이브 HTTP 금지(전부 fixture/fake-http).

## D7. 게이트 — blog KY 대조

크롤후 파이프라인에 검사 추가: blog가 주장하는 ky 번호 중 라이브 ky 레코드
에 존재하는 비율 리포트. **첫 소킹 report-only**(#120 선례), 실측 후 임계
(≥95% 제안) 강제 전환. 실패 시 en 탭 확장 판단 근거. 크롤 재개 소킹 확인
목록에 "parity relevance-smoke가 KY 유입에도 통과" 포함.

## D8. 관측/감사 로그

- CLI `--ky-decisions-out` → `CrawlOptions.kyDecisionsOutPath`(cli/pipeline
  포워딩, blogDropsOutPath 선례). decisionsOutPath 재사용 금지(overwrite
  시맨틱 — TJ와 파일 공유 시 상호 덮어씀).
- KY 어댑터가 분류기 도달 **전 행(admit+drop)**을 TJ 동형 스키마로 기록:
  `{ky, title, artist, decision:'admit'|'drop', step:string|null,
  reason:string}` — step = 판정 단계(reviewed-override/drop-list/
  script-guard/truncation-repair/index), reason = enum 값. fail-soft
  (JSONL·overwrite·warn-not-throw, TJ tryWriteDecisions 패턴).
- crawl.yml: `--ky-decisions-out $RUNNER_TEMP/filter-decisions/
  ky-filter.jsonl` 1줄 추가(기존 아티팩트 업로드에 자동 포함, add-paths
  무변경). `compose-crawl-pr-body.mjs`에 "KY filter attribution" 섹션
  (TJ 집계기 재사용).

## 스코프 밖 (오너 확정)

new_ky.asp 델타 / kacsv 시드 / 애니송북 조인(한글독음·타이업) / 작곡·작사·
출시월 필드 / KO_CHAIN 편입. 재고 트리거는 research 문서 참조.

## 부록 A — D2 개정: 절단 보정 fetch 제거 + 제목 회수 맵 (오너 결정 2026-07-16)

**배경(#158 머지 후 단독 실측 run2, 4,691곡/566req)**: ①절단 보정 fetch
성공률 **0.37%**(270 시도 중 1 — 상세 `category=1` 페이지도 색인과 **동일 폭
절단**, 전체 제목이 HTML에 없음) = 요청의 47.8% 순수 낭비. ②blog KY 대조
**92.26%**(1,157/1,254), 미스 97 = 절단드롭 87 + 미도달 10. → 오너 지시:
"절단 보정 제거하고 1곡(ky 44092)은 수동 admit" + "절단 회수(애니송북) 진행".

D2(절단 보정)를 아래로 개정한다. **D1·D3–D8은 불변.**

- **D2-1 보정 fetch 제거**: 절단 감지(`..` 센티넬) 유지, 상세(category=1)
  fetch 경로 삭제. `parseKyDetailRow`·`repairTruncatedRow` 삭제, http
  ALLOWED_HOSTS의 kysing `/search` 프리픽스 제거(fetch 콜사이트 소멸). 절단
  행은 곧장 회수 맵 조회로.
- **D2-2 큐레이션 제목 회수 맵**: 커밋 데이터 파일
  `packages/crawler/src/adapters/ky-kysing/curated-title-recovery.json`
  (`{ ky: { title, artist, source } }`, 번호순 정렬). 절단 행이 맵에 있으면
  전체 title/artist로 치환 admit(reason `admit-title-recovered`, step
  `truncation-recovery`), 없으면 드롭(reason `truncation-unrecovered` — 구
  `detail-fetch-failed` 개명, step `truncation-recovery`). 분류기 admit
  플래그 `repaired`→`recovered`. 드롭리스트/스크립트 가드는 회수된 title/
  artist에 그대로 적용(한국·중국 회수곡은 여전히 드롭).
- **D2-3 맵 생성 스크립트** `scripts/build-ky-title-recovery.mjs`: 애니송북
  42탄 HTML(`article.song-card` → `.song-no`/`.song-title`/`.artist-name`)에서
  추출. 로컬 사본 `--html`(재fetch 금지), 없으면 URL 1회 fetch. 무결성
  강제(키 digits·title/artist 비어있지 않음·`..` 없음). 스크립트+생성 JSON
  커밋, 1.3MB HTML 원본 미커밋. **수록 = 2,077**(애니송북 2,076 + 수동 1).
  애니송북 카드 2,521 중 445는 `artist-name` 빈값(가사·아티스트 미표기
  한국어 더빙곡, kr 탭 성격 → jp 워크 미도달)이라 제외 — 모든 맵 엔트리가
  완전한 title+artist를 보장(제외 시 회수곡의 아티스트가 여전히 절단일
  위험 제거).
- **D2-4 수동 엔트리**: ky **44092** `Connecting` / `halyosy feat.初音ミク、
  鏡音リン・レン、巡音ルカ、KAITO、MEIKO`(run2 상세 보정으로 확보, source
  `manual-20260716`) — 맵에 병합(수동 우선).
- **D2-5 회수율 실측(정적, run2 decisions × 맵)**: 절단 드롭 **269**곡 중
  맵 회수 **215**(79.9%). blog KY 대조 관점 = 절단드롭 미스 **87** 중
  **61** 회수 → blog KY 대조 **92.26% → 97.13%**(1,157→1,218/1,254) 투영.
  남은 미스 36 = 미회수 절단 26 + 미도달 10. D7 임계(≥95%)는 회수 반영 후
  달성.

발효는 여전히 크롤 재개(오너 1.0 선언) 후 첫 릴리스부터.
