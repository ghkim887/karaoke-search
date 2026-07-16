# KY(금영) 카탈로그 스마트 열거 경로 재조사 (2026-07-16)

오너 지시("번호 다 긁는 건 너무 무식하다")로 2026-07-10 1차 서베이(결론:
전수 = 곡번호 프로브 ~1..99999)를 재조사. 리서치 에이전트가 kysing.kr 본체
28요청(≥600ms 간격, 무차단) + GitHub 코드검색 + my.kysing.kr 플레이어 백엔드
라이브 프로브로 수행, 오케스트레이터가 핵심 주장 독립 재검증(karaoke-book
jp 색인 200행/페이지 라이브 재현, kacsv 60,636행 실측, new_ky.asp XML 및
s_date 무시 증거 대조).

**결론: 곡번호 브루트포스는 불필요.** 정식 색인 브라우즈 + 기성 데이터셋 +
정형 델타 XML 조합으로 전량 적재가 ~500–700 요청(JP만 ~150–200)으로 준다
(브루트포스 ~100k 대비 ~150분의 1).

## TL;DR

- **주력(전 카탈로그)**: `/karaoke-book/` 색인 브라우즈 — city={kr|en|jp} ×
  s_cd={2제목|3가수} × 색인문자 × 200행/페이지. **city=jp가 일본곡 전용 가나
  색인**이라 JP 식별이 열거로 해결.
- **부트스트랩 시드**: GitHub `DONXUX/kacsv`의 60,636곡 KY CSV(2026-04 크롤).
  번호공간 선확보용(서빙 직투입 금지, 라이브 대조 필수).
- **델타**: `my.kysing.kr/player/xml/new_ky.asp` — 무인증 최신 신곡 100곡
  정형 XML. `/latest/` HTML 대체.
- **막다른 길 확정**: 사이트맵/wp-json에 곡 데이터 없음, manana API의 KY는
  2026-03 고정(신선도 실격), KY 공식 앱 API 공개 리버스 없음.

## 1. 경로별 상세 (라이브 검증 증거)

### A. `/karaoke-book/` 색인 브라우즈 — ★주력

- "노래방책 검색" 메뉴. 서버렌더 HTML, 색인문자별 페이지네이션.
- 증거: `GET https://kysing.kr/karaoke-book/` → 200, **200행/페이지**,
  행 = `index_search_num`(곡번호) / `index_search_tit`(제목) /
  `index_search_sng`(아티스트).
  - `?city=jp&s_cd=2&s_page=1` → 200행 일문 표기
    (`75951 | #君と僕とが出逢った日 | 舟津真翔`, `44655` YOASOBI 怪物).
    색인문자 = 가나 전수 + 其他 + A–Z + ETC ≈ 104종.
  - `?city=kr` = 초성 ㄱ~ㅎ + A–Z + ETC = 46종. `?city=en` = 27종.
  - 페이지네이션 = prev/next 워크(총 페이지 미표기). jp あ: p1=200행,
    p5=0, p10=0 → 색인문자당 200~800행.
- 커버리지: kr/en/jp 3탭 ≈ 전 카탈로그(kr∪en∪jp 완전성은 미검증 —
  구현 시 기존 blog KY ~1.2k 대조 게이트 필수).
- 요청 수: 전량 ~60–90k곡 가정 시 ~500–700. JP만 ~150–200.
- JP 식별: city=jp 멤버십 자체가 태그.
- 리스크: ① **고정폭 절단** — 책자뷰 `41905 | * ~アスタリスク~ (` vs 상세뷰
  `* ~アスタリスク~ ("BLEACH"OP)`; 아티스트 패딩/`Simon&Garf..` → 긴 필드는
  B로 보정. ② 색인뷰엔 작곡/작사/출시월 없음. ③ 빈 페이지까지 워크
  (JOYSOUND 어댑터 패턴, JSONL 재개형).

### B. `/search/?category=1&keyword={곡번호}` 상세 — 보정/엔리치

- 증거: `keyword=41905` → 1행, 비절단 전체 제목 + 작곡/작사/출시월(2005.05)
  + 인라인 가사(한글독음+후리가나+원문).
- category 범례(GitHub `bigskylee/mmbook` 주석, 라이브 셀렉터 일치):
  곡명=2, 단일곡명=8, 가수=7, 곡번호=1, 작곡=5, 작사=6, 가사=4, LTS=11.
- 용도: 절단 곡 + JP 전곡 필드 보정. 곡당 1요청.

### C. `/latest/` — 델타(백필 불가 확정)

- 10행/페이지, 전 행 출시월 2026.08(익월 선공개), `?s_page=30`=0행,
  아카이브 파라미터 없음, 깊이 <300곡. 과거 백필 아님. D로 대체.

### D. `my.kysing.kr/player/xml/new_ky.asp` — 델타 XML

- KY 데스크톱 웹플레이어 백엔드(발견 경로: GitHub `bass9030/mafu-karaoke-pray`).
- 증거: `POST http://my.kysing.kr/player/xml/new_ky.asp` body `s_date=YYYYMMDD`,
  무인증 → `<Item SongId Title Singer Author LyricsAuthor WebKaraYn/>` 100개.
  예 `51528 짜파게티/Paul Blanco`, `57742 神っぽいな/ピノキオピー feat.初音ミク`.
- **s_date 무시**: 20200101/20250601/20260101 모두 동일 100곡 → 고정
  "최신 신곡 100" 피드. 델타 전용(백필 불가).
- 파싱 캐비엇: Author/LyricsAuthor에 고정폭 패딩 + "작곡"/"작사" 접미사.
- 막다른 길: `/player/xml/` 403, 추측 엔드포인트 6종(search_ky/list_ky/
  best_ky/popular_ky/song_ky/ky.asp) 전부 404.

### E. 애니송북 — JP/애니 서브셋 보강

- `GET /anisong/` → 39·40·41탄 PDF + **42탄(2026 여름)은 정적 HTML**
  (`/wp-content/uploads/2026/07/애니송북42탄-여름호.html`, 1.34MB).
- 42탄 구조: `song-no`(2,521) / `song-title` / `song-reading`(한글독음
  2,224) / `artist-name` / `artist-reading`(2,218) / `anime-section`(타이업
  761) / `data-search`. 예 `76519 | Burning | 버닝 | 羊文学 | 히츠지분가쿠`.
- 가치: 곡번호 조인으로 JP곡 한글독음+타이업. 분기 갱신. 구판 PDF는
  `scripts/ingest-tjpdf-catalog.mjs` 선례로 처리 가능.

### F. 아티스트 검색(category=7) — 크로스체크만

- `YOASOBI` 15행/페이지+총페이지 내비, 한자 정상, 단 `Ado` → 서브스트링
  오염(Madonna, ROAD OF MAJOR 혼입). 수천 요청으로 A보다 비효율.

### G. manana API — 교차검증/백필(주력 불가)

- `api.manana.kr/karaoke`: `no/44655.json?brand=kumyoung` 정상(kysing 일치),
  `release/{YYYYMM}` 월별 제공. **단 KY 최신 = 2026-03 고정, 202604~07 0건**
  (동월 TJ는 120곡) → 신선도 실격. GitHub `singcode`도 KY는 manana 불신.
- 용도: 2026-03 이전 곡 출시월 백필로 kysing 요청 절감.

### H. GitHub 크롤러·데이터셋 인벤토리

- **DONXUX/kacsv**: `ky_songs.csv` 60,636곡(2026-04-15, 번호/제목/가수/작곡/
  작사; 출시월·JP플래그 없음) — 부트스트랩 시드 후보.
- Yuyeol/song_crawler: category=1 브루트포스(우리가 피하려는 방식).
- RanolP/imakaraokay: category=2 페이지네이션 스크래퍼(셀렉터 검증됨).
- GulSam00/singcode: manana(TJ)+YouTube @KARAOKEKY+kysing 검증 하이브리드.
- bass9030/mafu-karaoke-pray: new_ky.asp 유일 사용처.

### I. KY 공식 앱 API — 공개 리버스 없음

`new_ky.asp` 외 문서화/리버스 없음. APK/EXE 디컴파일 미수행(규정).

## 2. 비교표

| 경로 | 커버리지 | 요청 수(전량) | 필드 | 신선도 | JP 식별 | 판정 |
|---|---|---|---|---|---|---|
| A. karaoke-book | 전 카탈로그 | ~500–700 (JP ~150–200) | 번호/제목†/아티스트† | 라이브 | city=jp 즉시 | **주력** |
| B. 곡번호 상세 | 곡당 1행 | 곡당 1 | 전 필드+출시월+가사 | 라이브 | 표기 | 보정 |
| C. /latest/ | 당월+익월 | ~10–30/월 | 전 필드 | 익월 선공개 | 표기 | D로 대체 |
| D. new_ky.asp | 최신 100 | 1/폴링 | +WebKaraYn | 최신100 고정 | 표기 | **델타 주력** |
| E. 애니송북 42 | 애니 ~2.5k | 1 | +한글독음+타이업 | 분기 | 전곡 JP | 보강 |
| F. 아티스트 검색 | 목록 의존 | 수천 | 전 필드 | 라이브 | 표기 | 크로스체크 |
| G. manana | ~2026-03 | ~450 | +날짜 | 4개월 정체 | 표기 | 교차검증 |
| H. kacsv | 60,636(스냅샷) | 1 | 5필드 | 2026-04 | 표기 | 시드 |
| I. 앱 API | — | — | — | — | — | 막다른 길 |

† 고정폭 절단 있음.

## 3. 권장 조합

1. **초기 적재**: A — jp 먼저(~150–200req), 이어 kr/en(합 ~500–700).
   JOYSOUND 어댑터 패턴(색인×페이지 워크, JSONL 재개). 1req/s ≈ ~15분.
2. **부트스트랩(선택)**: H(kacsv)로 번호공간 선확보 → A 워크 검증/차분 집중.
   서빙 직투입 금지, 라이브 대조 필수.
3. **필드 보정**: 절단행 + JP 전곡을 B로 보완. 2026-03 이전 곡 출시월은
   G(manana no/{번호})로 kysing 요청 절감.
4. **JP 보강**: E(42탄 HTML 1파일) 조인 — 한글독음·타이업.
5. **델타**: 월 1회 D + 분기 1회 E 신판 + 반기~연 1회 A 재워크(폐번/개명).
   D는 고정 최신-100이라 월 신곡 >100이면 누락 위험 → C 병행 검증.
6. **게이트**: A 결과 ⊇ 기존 blog KY(~1.2k) 대조로 완전성 확인.

## 4. 막다른 길 (재조사 방지)

- Yoast 사이트맵(자식 26) + `/wp-json/`(254 라우트 전수): 곡 데이터 없음
  (곡 DB는 WP 밖 커스텀 테이블; `lts_log` 타입은 531건·2023-04 중단 부적격).
- manana KY: 2026-03 고정·결월 다수.
- `/latest/` 백필: 아카이브 파라미터 없음, <300곡.
- my.kysing.kr 검색/목록 XML: 디렉터리 403 + 이름 추측 404.
- KY 공식 앱 API: 공개 리버스 없음.
- 아티스트 검색: 서브스트링 오염 + 비효율.

## 5. 재현성

증거 덤프는 세션 스크래치패드(휘발). 본 문서의 URL로 전부 재현 가능.
kacsv CSV는 GitHub `DONXUX/kacsv`에서 재다운로드 가능.
