# TJ Media API 전수조사 결과 (2026-06-11)

insane-search 엔진(curl_cffi, TJ는 WAF 없음 — 1회 도달) + MCP 브라우저 네트워크 정찰 + 레거시 JSON 직접 프로브 + 코드 인벤토리 종합. 원샘플: `.tmp_review/tj-api-probe-20260611/`.

## 결론 한 줄
**새 엔드포인트가 필요한 게 아니라, 이미 매 응답에 오는 필드를 버리고 있었다.** TJ 풀카탈로그 응답(크롤당 1회, ~67k 전곡)이 곡마다 **작곡가·작사가·발매일·MR가용·MV플래그·앨범아트**를 담는데 파서가 전부 폐기 중. → 추가 HTTP 0으로 전곡 enrich 가능.

## 진입점 지도 (실측)
| 진입점 | 종류 | 상태 |
|---|---|---|
| `POST /legacy/api/newSongOfMonth` (searchYm=200001) | 풀카탈로그 JSON, ~67k 1응답 | 크롤러 사용 중 (E1) |
| `POST /legacy/api/searchSong` (strType 0/1/2/16, nationType) | 검색 JSON, **30개 하드캡** | 크롤러 사용 중 (E2) |
| `POST /legacy/api/topAndHot100` (chartType TOP/HOT, strType 1/3) | 차트 JSON | 크롤러 사용 중 (E3) |
| `GET /song/accompaniment_search?pageNo=N&nationType=&strType=&searchTxt=&strWord=` | 모던 검색 **HTML**(서버렌더, 페이지네이션 됨) | 미사용 — strType 0/1/2/4/8/16/32 노출, 컬럼: 곡번호·제목·가수·작사가·작곡가·앨범·유튜브 |
| `https://newsong.tjmedia.com/` (`.asp`) | 레거시 월별 신곡 ASP | 미사용 — 저가치(카탈로그가 상위집합) |
| 곡 상세 / 가사 엔드포인트 | — | **존재하지 않음** (5종 추측 전부 404 HTML; 모던 사이트도 가사 팝업 없음 — 라이선스상 미제공) |

## strType 열거 (모던 폼에서 확정)
0 통합 / 1 곡제목 / 2 가수명 / **4 작사가 / 8 작곡가** / 16 곡번호 / 32 메들리. nationType: ''(전체)/KOR(가요)/ENG(팝송)/JPN(일본곡).
(레거시 searchSong은 0/1/2/16만 의미. topAndHot100의 strType은 장르축: 1 가요 / 3 JPOP — 그 외 장르값은 미확인.)

## 지금 버리는 데이터 (전부 실측 확인)
풀카탈로그 row 예: `{pro, indexTitle, indexSong(=가수), word:"김병걸", com:"신일동", icongubun:"", mv_yn:"N", publishdate:"2026-06-10", thumbnailImg}`
검색 row 예(米津玄師 IRIS OUT): `{..., word:"米津玄師", com:"米津玄師", nationalcode:"JPN", publishdate:"2025-10-20", mv_yn:"N"}`

| 필드 | 의미 | 가용 범위 | 현재 |
|---|---|---|---|
| `com` | 작곡가 | 전곡(카탈로그+검색+차트) | 폐기 |
| `word` | 작사가 | 전곡 | 폐기 |
| `publishdate` | 발매일(YYYY-MM-DD) | 전곡(카탈로그) + per-pro 캐시에도 이미 저장됨 | 폐기/미표면화 |
| `icongubun` | `"MR"`=MR반주 가용, `"60"`=피처아이콘, `""`=없음 | 전곡 | 폐기 |
| `mv_yn` | MV 유무 Y/N | 전곡 | 폐기 |
| `imgthumb_path`/`thumbnailImg` | 앨범아트 + 카탈로그 경로엔 `A######` 앨범ID 임베드 | 전곡 | 폐기 |
| `subTitle` | 부제 | searchSong only | 캐시되나 미표면화 |
| `rank` | 차트순위 1-100 | 차트(104주×TOP/HOT×2장르 이미 스윕 중) | 폐기 — 곡 인기도 신호 |

## 막다른 길 (실측)
- **페이지네이션**: pageNo/pageSize/rowSize/listCnt/endRow/pageRow/cnt/startRow/startIndex/offset 9종 전부 레거시 JSON에서 무효 — page1=page2 동일. searchSong은 30캡 고정. **단 카탈로그(E1)는 무캡 전곡 반환이라 완전성엔 무영향**; 30캡은 아티스트 국적투표에만 영향(≥3 임계엔 30행 충분).
- **대량 국적**: 카탈로그에 `nationType=JPN` 필터 무효(2232 동일, nationalcode 필드 없음). 국적은 여전히 searchSong/차트 투표로만.
- **통합검색 버킷 items1~6**: 매치필드별 슬라이스일 뿐(items2=제목 등) — 신규 데이터 아님.
- **가사/key/tempo/duration/genre**: TJ 어떤 응답에도 없음.

## 제안 (오너 목표 = TJ 곡 데이터의 FP/FN 제거 기준으로 재평가, 2026-06-11)

**오너 목표는 "더 풍부한 메타데이터"가 아니라 "이 곡이 일본곡인가"의 정확도(FP/FN 제거)다. 그 렌즈로 보면:**

### ❌ 추구하지 말 것 — FP/FN과 무관
- `com`(작곡가)/`word`(작사가)/`publishdate`/`icongubun`/`mv_yn`/`rank`/앨범아트: 전부 메타데이터일 뿐 분류 신호가 아니다. composer/lyricist의 스크립트(한자 vs 한글)가 이론상 보조 국적 힌트지만 `nationalcode`가 그 일을 이미 더 정확히 해서 한계 가치 ≈ 0. **스키마 추가 비추천.**

### 결론: TJ엔 미사용 분류 신호가 더 없다
- TJ의 일본곡 판별 권위 신호는 `nationalcode`(JPN/KOR/ENG) 하나뿐이고 **이미 사용 중**(`enrichTranslit.ts:107`가 `match.nationalcode` 캐시). per-pro nationalcode는 권위적(실측: Lemon→JPN, IRIS OUT→JPN). 모던 `nationType=JPN` 서버필터도 진짜 작동(BTS JPN 1 vs 전체 15).
- 가사·장르·key/tempo·곡상세 엔드포인트는 **존재하지 않음**. 즉 "더 캐서 정확해지는" TJ 데이터는 없다.

### TJ-side에서 FP/FN을 더 줄이려면 = 새 데이터 ✗, 기존 nationalcode 완전 활용 (분류 로직 튜닝)
1. **[FP↓] KOR/ENG nationalcode도 캐시** — 현재 enrichment가 파서가 admit한 JPN-likely 곡에만 돌아(`enrichTranslit.ts:9`) 캐시가 JPN 편향 → `non-jpn-pro-reject`가 굶음(메모리 [[project_tj_nationalcode_caching]] 기록). 드롭/경계 곡의 KOR/ENG 태그를 채우면 한국·영어곡 FP를 권위적으로 reject 가능.
2. **[검증 오라클] `nationType=JPN` 전수 enumerate** — 모던 HTML(`/song/accompaniment_search`, pageNo 페이지네이션 작동)로 TJ가 JPN으로 분류한 전곡 리스트를 뽑아 코퍼스 검증 오라클로. (레거시 JSON은 30캡+pageNo무효라 불가 — 모던 HTML 경로만 가능.)

### ✅ JOYSOUND 머지 시 진짜 유의미 — 교차 벤더 국적 검증
- TJ `nationalcode` ⟂ JOYSOUND `songNameForeign`/`artistNameForeign`: 서로 독립적인 권위 신호. 같은 곡이 양쪽에 있으면(title/artist 매치 또는 공유 번호 머지) 두 판정 교차검증:
  - 양쪽 일본곡 확정 → 고신뢰 keep (FP 제거)
  - 한쪽만 → 그게 곧 FP/FN 검토 큐
- 단일 출처 추측 → 교차검증 판정. 불일치 집합이 자동 감사 대상. **이게 합쳤을 때 FP/FN을 실제로 줄이는 메커니즘이고, detail 크롤 완료 후 후보 빌드 단계에서 자연스럽게 추가 가능.**

주의: 위 1·2·교차검증은 모두 분류 파이프라인/머저 변경(스키마 무변경). author→review 필요. 같은 SongRecord/머저를 건드리므로 JOYSOUND 피처 브랜치 정리 후 착수 권장.
