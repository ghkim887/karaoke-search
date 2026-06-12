# CHECKPOINT 1 사전 검증 결과 (2026-06-10)

175개 JOYSOUND ALLOW 오버라이드 전수를 4개 검증 에이전트가 웹 증거로 재검증.
원본: `.tmp_review/joysound-sweep-2026-06-09/adjudication/joysound-adjudication-review.csv` (verdict=ALLOW 행).

## 결과: 172 CONFIRM / 3 SUSPECT / 0 UNVERIFIABLE

**오너 확인 필요한 3건 (이것만 보면 됨):**

| selSongNo | title | artist | 문제 |
|---|---|---|---|
| **148140** | Super Star | ハン・スンヨン(KARA) | **한국어 곡** — 한국 드라마 「메리는 외박중」 OST ED (작사 서현일/작곡 최철호). 일본에 *유통*은 됐으나 일본어 버전 없음. 재판정 사유("KARA 멤버 일본 솔로 릴리스")가 오류. 정책상 ALLOW 부적격 가능성 높음. |
| **153397** | トライアングル | 東方神起 | **한국어 곡** — 2004 한국 1집 타이틀 Tri-Angle (feat. BoA & TRAX, 유영진 작). 일본어 버전 부재 (ja-wiki 곡 목록 확인). 재판정이 인용한 소스는 일본어 *자막* 한국 MV — 판정 오류로 보임. |
| **735357** | ミチGO | G-DRAGON (from BIGBANG) | **그레이존** — 한국어 곡, LINE 디지털 싱글(한/일/태 동시, JP 한정 아님). 유일한 일본 footprint는 일본 한정 컴필레이션에 한국어 그대로 수록. "일본 한정 앨범 수록 = 일본 시장 릴리스"로 칠지 여부의 정책 판단. (같은 앨범의 あんなヤツ는 진짜 일본어 버전이라 대조적) |

**처리 완료 (2026-06-10, 오너 승인 "권고대로 진행")**: 3건 모두 `reviewedJoysoundOverrides.ts` ALLOW에서 제거 (175→172), 테스트 핀 갱신, crawler 650/650 green. ミチGO를 되살리려면 `'735357'` 한 줄 재추가.

**⚠️ 크롤-후 필수 처리**: 진행 중인 detail sweep은 175개짜리 dist를 메모리에 들고 시작했으므로 decision-log에 이 3곡이 `admit (reviewed-allow)`로 기록됨. `build-joysound-candidate.mjs`는 decision-log를 **재분류 없이 그대로 신뢰**하므로(line 482 `readJsonlAdmits` — classifier 미호출), 후보 빌드 전에 (a) 빌더에 3개 selSongNo 명시 제외 추가 또는 (b) decision-log에서 3행 스크럽 필요. 새 sweep 출력(`.tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl`)에도 동일 적용.

## 부수 발견 (verdict 무영향, 기록용)

- 재판정 `reason` 필드의 인용 오류 다수: KARA 솔로 4곡+5곡의 앨범 오기(Girl's Story→실제 KARAコレクション/Girls Forever), TXT 2곡(SWEET→誓い 싱글), BTS いいね!Pt.2(WAKE UP→2017 베스트), IZ*ONE 2곡(Vampire B-side 아님), ハナミズキ 출처 오기 등 — verdict는 전부 정당하나 reason 텍스트는 신뢰하지 말 것.
- "ive feat.初音ミク"(6곡)는 K-pop IVE가 아닌 일본 보카로P — 정확히 구분 확인됨.
- JOYSOUND 공개 웹 곡페이지 ID는 sweep의 selSongNo와 **다른 네임스페이스** — selSongNo로 직접 URL 검증 불가 (디스코그래피/가사DB 증거로 검증함).
