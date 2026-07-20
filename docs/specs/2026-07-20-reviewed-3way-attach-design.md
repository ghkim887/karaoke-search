# 설계안: 리뷰드 3-way 병합 — dup-J(unique-joysound) 불변식 완화 (옵션 B2)

- 작성일: 2026-07-20 · 기준 커밋: main `4172e1e` (#168 이후)
- 선행: PR #163(B-wave 인코딩·표현불가 분류), #165(리뷰드 클러스터-어태치 완화),
  #166(both-vendor Tier E +46), #168(forbidden 해제 8 + uncertain→merge 2,
  later-file-wins 중복판정 규칙, parseReviewedSource const-앵커 강화)
- 대상: ROADMAP.md "미병합 잔여 오너 결정 큐" 항목 4 — **3-way 클래스 85곡**
- 상태: **오너 승인(2026-07-20) · 구현(이 PR)**. 발효는 다음 재병합(크롤 재개 또는
  v25 재구성). 데이터(코퍼스) 재생성 없음.

---

## 1. 문제 정식화

### 1.1 불변식이 지키는 것

리뷰드 병합표(`packages/crawler/src/reviewedMergePairs.ts`)의 Tier E `[tj, joysound]` /
Tier F `[vendor, number, joysound]`에는 **unique-joysound 불변식**이 있다: 한 joysound
번호당 엔트리 1개.

- **표 내(import-time)**: `assertReviewedTierEPairInvariant()` /
  `assertReviewedTierFPairInvariant()`이 모듈 로드 시 각 표 안의 J 중복을 throw로 차단.
- **표 간(encode-time)**: import-time 단언은 표 간 J 중복을 검사하지 **않았다**. 표 간
  유일성은 인코더 `scripts/encode-b-wave-merge-pairs.mjs`의 `existingJ`(양 표 합산,
  parseReviewedSource) 가드가 전담한다.

이 불변식이 방어하는 사고는 두 가지다:

1. **찢김 사고**: 한 joysound 행이 서로 **다른 곡**인 두 대상에 동시에 붙어 무관한
   레코드들이 한 클러스터로 뭉치는 것.
2. **표 오타**: 수동 인코딩 시 J 번호 오타/복붙 실수가 조용히 이중 매핑을 만드는 것 —
   중복 자체를 에러로 만들어 fail-fast.

### 1.2 3-way가 예외인 이유

85곡은 "tj행·ky행·joysound행 **셋이 같은 곡**"으로 사람이 리뷰 확정한 클래스다.
여기서 한 J에 두 대상이 붙는 것은 찢김이 아니라 **셋을 하나로 합치는 것** — 불변식이
방어하려는 사고(1)의 전제(서로 다른 곡)가 성립하지 않는다. 사고(2)의 오타 방어는
"임의 중복 금지"가 아니라 "**리뷰로 확정된 3-way만** 명시적 형태로 허용"으로 유지한다.

런타임은 이미 준비되어 있다: #165의 `collectReviewedClusterAttachGroups`(merge.ts)는
양측을 전체 벤더 색인(`firstVendorIndex`)으로 조회해 클러스터 상태 무관하게 union하며,
유일 가드는 두 클러스터 합집합에 대한 `collectVendorNumberConflicts`다. 즉 **막고 있던
것은 merge 로직이 아니라 표의 인코딩 규약(인코더 가드 + import 단언)뿐이었다.**

### 1.3 85곡의 구성 (main `4172e1e`에서 인코더 재실행으로 재검증)

빈 어태치 표 기준 `node scripts/encode-b-wave-merge-pairs.mjs` 실측:
`3way-existing-reviewed` **83건** — 전원 ky측 후보 `[ky, N, J]`이고, J의 기존 소유주는
**전원 tj측**(Tier E 26 / Tier F 57). 추가 검증: 83건 내 중복 ky 0, 중복 J 0,
ky 번호가 기존 Tier F ky 타깃과 충돌 0.

여기에 **보충 2건**:

- **ky-41123** "ひとりぼっちのハブラシ"/桜庭裕一郎 ↔ joysound-11509 (소유주 Tier F
  `['tj','25640','11509']`). v24 미병합 전수 교차검증(NAS
  `runs/ky-v23-20260716/audit-v24r2/unmerged-xref.json`)에서 fresh 발견 — B-wave에
  없어 인코더가 도출 불가. C-1 보충 판정 파일로 추가(§3.2).
- **tj-26145** "忘れていいの"/小川知子,谷村新司 ↔ joysound-1546 (소유주 Tier F
  `['ky','40449','1546']`, #168이 인코딩). **벤더 대칭 최초 사례** — 소유주가 ky측이고
  어태치가 tj측이다. B-wave의 reject 판정을, 신발견 듀엣 행 joysound-1546 실재
  확인으로 오너가 뒤집었다. D-2 보충 판정 파일 + later-file-wins 오버라이드(§3.2).

⇒ 도출 83 + 보충 2 = **어태치 표 85엔트리**(84 ky측 + 1 tj측).

---

## 2. 옵션 비교

공통 전제: 어떤 옵션이든 자동 티어(B/C/D/G) 무접촉, 리뷰드 한정, 충돌가드
(`collectVendorNumberConflicts`) 유지.

### 옵션 A — Tier F에 리뷰드-3way 플래그로 J당 다중 엔트리 허용 (기각)

Tier F 엔트리를 `['ky', N, J, '3way']`처럼 4번째 플래그로 확장하고 dup-J 단언을 조건화.
**치명적 가드 갭**: 같은 J의 tj쌍과 ky쌍이 둘 다 Tier F에 있으면 같은 plan 패스에서
계획된다. `collectReviewedClusterAttachGroups`는 티어 시작 스냅샷으로 충돌을 검사하므로,
ky쌍의 충돌 검사는 {ky클러스터 ∪ joy클러스터}만 보고 **tj클러스터를 못 본다**(J 소유주가
Tier F인 57건 전부 해당). tj측↔ky측 벤더셀 충돌이 plan을 통과해 `mergeCluster`에서
"승자 선택 + 충돌 로그"로 격하 — #165가 약속한 "충돌 시 스킵" 시맨틱이 깨진다. 고치려면
티어 내 2-패스 계획 필요 → 런타임이 오히려 복잡. **판정: 기각.**

### 옵션 B1 — 신규 트리플 표 `[tj, ky, joysound]` (원자적, 기존 쌍 치환) (차선)

새 표에 85개 트리플을 넣고 기존 tj측 쌍을 제거해 치환. 개념적으로 깔끔하나 **all-or-nothing
회귀**: ky측만 충돌을 유발해도 트리플 전체가 스킵되어 현재 발화 중인 tj↔J 병합까지
풀린다(곡 수 회귀). 부분 발화하려면 단계적 union 로직 추가 필요. 인코더가 "표에서 뺄 것"도
관리(출력 규약 확장). "기존 무영향"을 문자 그대로 만족 못 함(84+ 엔트리 치환 churn).
**판정: 차선.**

### 옵션 B2 — ky/tj-어태치 확장표 (기존 쌍 무접촉, 신규 스테이지) ★ 채택

새 표 `REVIEWED_TIER_F_3WAY_ATTACH_PAIRS: [NonJoysoundVendor, number, joysound][]`
(85 엔트리)를 신설한다. 의미: "이 J는 이미 E/F의 **다른 벤더** 쌍이 소유한다. 같은 곡으로
리뷰 확정된 **두 번째 단일벤더 다리**를 추가로 붙여라." 기존 E/F 엔트리는 **한 글자도 안
바뀐다.** 런타임은 Tier F 스테이지 **직후**에 같은 콜렉터를 그대로 쓰는 스테이지를 하나
추가한다.

- **불변식 자기검증 (신설 단언 5종 — import-time, `assertReviewedTierF3wayAttachInvariant`)**:
  1. 표 길이 = 기대 상수(85).
  2. 표 내 `vendor:number` 유일 **+ 기존 리뷰드 타깃과 교차 배타** (Tier F vendor:number
     전량 + Tier E tj 번호를 `tj:<n>`으로 — tj-어태치 대칭 케이스까지 커버).
  3. 표 내 J 유일 (J당 다리 1개).
  4. **모든 J가 Tier E 또는 F의 기존 쌍에 존재** — 고아 어태치 차단. ⇒ 이 단언이
     **최초의 import-time 표 간 검사**로, 기존(인코더 전용)보다 불변식이 오히려 강화된다.
  5. **어태치 vendor ≠ 소유주 쌍의 vendor** — J 소유주(E는 항상 tj, F는 vendor 파트)를
     역색인으로 찾아 비교. 같은 벤더 이중 어태치는 셀 충돌 확정이라 표 차원에서 차단.
  - dup-J 재해석: "J당 **표 엔트리** 1개" → "J당 **벤더별 다리** 1개"(소유주 다리 1 +
    어태치 다리 1). 오타 방어는 단언 3+4가 그대로 수행.
- **인코더 도출 로직 (벤더 대칭)**: `parseReviewedSource`가 어태치 표도 파싱
  (`attach`/`attachTargets`/`attachJ`). `buildPlan`에서 `existingJ.has(J)` 경로를 일반화:
  **J의 소유주 vendor ≠ 후보 vendor**이면 어태치 후보 — (a) 이미 어태치 표에 정확히
  있으면 `already-encoded`(멱등), (b) J가 이미 다른 다리로 브리지됐으면 `3way-dupJ`,
  (c) 어태치 vendor:number가 기존 리뷰드 타깃/커밋된 어태치와 충돌하면
  `target-conflict-existing`, (d) 아니면 `tierF3wayAttach`로 방출. 소유주 vendor ==
  후보 vendor이면 어태치 아님 — 종전 버킷(`3way-existing-reviewed` ky /
  `both-vendor-number` tj) 유지.
- **런타임 변경량 (최소)**: merge.ts에 `collectTierF3wayAttachGroups`(어태치표를 pairs로
  펼쳐 `collectReviewedClusterAttachGroups` **그대로 호출**) + `TIER_PIPELINE`에 Tier F
  뒤 스테이지 1개 추가. 스테이지 name은 기존 `'F'`를 재사용해 `TierName`/`ClusterTier`
  타입과 하류 소비자를 무접촉으로 유지(파이프라인은 배열이라 같은 name 2회 등장 가능;
  `TIER_BY_NAME['F']`는 동작이 동일한 두 번째 F 서술자로 해석돼 무해). clusterKey는
  `tierFClusterKey(vendor, N, J)` 재사용.
- **충돌가드 상호작용 (자연스럽게 원자적)**: 어태치 스테이지는 E/F union이 **적용된 후**
  계획되므로 joy클러스터에 이미 소유주 행이 들어있다. 따라서 members = {어태치클러스터 ∪
  (joy+소유주 클러스터)} — **3자 전체 합집합 충돌 검사를 콜렉터 수정 없이** 얻는다(옵션 A의
  가드 갭이 구조적으로 소멸). 충돌 시 어태치만 스킵+로그되고 기존 소유주 병합은 그대로
  발화 — **우아한 부분 실패**(옵션 B1의 all-or-nothing 회귀 없음).
- **기존 무영향**: **문자 그대로 diff 0** (Tier E 271 · Tier F 482 무변경). 기존
  충돌스킵(tj-6579/tj-27098/tj-27416/tj-26737)도 그대로.

**판정: 채택.**

### 옵션 C — Tier E 엔트리에 선택적 ky 필드 (기각)

Tier E를 `[tj, J] | [tj, J, ky]`로 확장. J 소유주가 Tier F인 다수는 F→E 이동이 필요해
두 표의 역사적 계보(E=2026-06-13 원 리뷰, F=post-crawl 감사)가 깨지고 #163/#166 재현
스크립트와 어긋난다. B1과 같은 all-or-nothing + 표 계보 훼손. **판정: 기각.**

### 요약표

| 축 | A (플래그) | B1 (트리플 치환) | **B2 (어태치 확장표)** | C (E 선택필드) |
|---|---|---|---|---|
| import-time 자기검증 | 약화 | 강화 | **강화(+최초 표 간 단언)** | 복잡화 |
| 인코더 | 조건 우회 | 방출+제거 | **방출만(멱등 자연)** | 방출+이동 |
| 런타임 변경 | 0이지만 가드 갭 | ~40줄 신규 콜렉터 | **~15줄, 콜렉터 재사용** | B1과 동일 |
| 충돌가드 | 57건 갭(승자격하) | 원자적, all-or-nothing | **원자적, 부분실패 우아** | B1과 동일 |
| 기존 753쌍 | 단언 약화 영향 | 85건 치환 | **diff 0** | 85건 이동/수정 |

---

## 3. 데이터 도출 (재현 경로)

### 3.1 83건 — 기존 verdicts에서 인코더가 도출

원천은 커밋된 `scripts/data/b-review-merge-verdicts/`(verdicts-\*.json + batch-\*.json)이며
손 리스트가 아니다. 빈 어태치 표 기준 인코더 실행 시 `existingJ.has(J) && 소유주 vendor ≠ ky`
경로가 어태치 후보로 전환돼 83건(전원 ky측)을 방출한다. 소유주 앵커는 `existingOwner`
필드(예: `tierE tj-52758`, `tierF tj:25875`)로 도출·검증한다. 구현 후 재실행하면 83건이
already-encoded(attach)로 떨어지는 것이 멱등 체크다.

### 3.2 보충 2건 — 신규/뒤집힌 판정 데이터

`loadReviews`는 `batch-*.json`/`verdicts-*.json` 글롭을 다 읽으므로 코드 수정 불요.

- **ky-41123** (fresh): `batch-C-1.json` + `verdicts-C-1.json` — merge, candidate joy 11509.
  B-wave에 없던 KY행(v24 unmerged-xref fresh 발견); 소유주 tj-25640과 동일곡.
- **tj-26145** (오버라이드): `batch-D-2.json` + `verdicts-D-2.json` — merge, candidate
  joy 1546. B-wave의 reject(verdicts-A-1)는 당시 후보가 谷村新司 솔로판·欧陽菲菲판뿐이라
  듀엣 원곡 매칭 불가였음. 듀엣 행 joysound-1546(-愛の幕切れ-, 谷村新司/小川知子) 실재
  확인으로 오너가 merge로 뒤집음. #168이 인코더에 구현한 **"나중 파일 우선"(later-file-wins)**
  규칙으로 verdicts-A-1의 reject를 D-2의 merge가 명시적으로 대체(오버라이드는 로그 노출).

이로써 인코더 1회 실행이 **어태치 85건 전체**를 방출한다. 부작용: 인코더 로그의 verdict
집계가 merge **483**(481 + ky-41123 + tj-26145)로 변한다.

---

## 4. 안전 논거 (#165와 같은 프레임)

1. **자동 티어 무접촉**: B/C/D/G 판별식·게이트 무변경. 변경은 리뷰드 데이터 표 1개 +
   리뷰드 전용 파이프라인 스테이지 1개. #165의 자동 티어 회귀 테스트가 그대로 방어.
2. **리뷰드 한정**: 85건 전건이 사람 판정(merge verdict + 근거 문자열)을 원천으로 커밋.
3. **충돌가드 유지·강화**: 유일 가드는 여전히 `collectVendorNumberConflicts` — 스테이지
   순서 덕에 3자 합집합에 대해 검사되고, 충돌 시 어태치만 스킵+로그.
4. **발화 예상 수치**: 리뷰드 단위 753(E 271 + F 482) + 85 = **838**. 기대: **+85 발화**
   (85곡의 두 번째 다리가 기존 소유주+joysound 클러스터에 합류), **기존 충돌스킵 4건 그대로**.
   diag 기대: **823 fired + 4 conflict-skip / 838** (레포 검증은 게이트+테스트, 데이터
   검증은 oci 오케스트레이터).
5. **실발효**: v25 재구성 또는 크롤 재개 시.

---

## 5. 리스크와 반례

1. **joysound행이 이미 다른 벤더값을 네이티브 보유**: 합집합 셀에 상이값 2개 → 가드가
   어태치만 스킵+로그. 기존 소유주 병합은 유지. **의도된 동작**(§6 충돌 테스트로 고정).
2. **어태치행이 이미 다른 클러스터에 병합**: 전체 색인 조회라 그 클러스터 통째로
   검사·합류(무충돌 시) / 스킵(충돌 시). #165 Case B/C와 동일 논리.
3. **소유주 쌍 자체가 충돌 스킵된 경우**: joy클러스터에 소유주 행이 없으므로 어태치는
   {어태치 ∪ joy}만 본다. 어태치↔J 자체가 독립 확정 판정이므로 발화는 정당. 단언 4는
   "표에 쌍이 존재"만 요구하므로 발화 여부와 무관.
4. **membershipByRoot 덮어쓰기**: 어태치 발화 시 루트 membership이 어태치 스테이지의
   clusterKey로 갱신(예 `tj:25875|joysound:10140` → `ky:40141|joysound:10140`). 리뷰-표식
   수준의 변화이고 하류는 이 키를 불투명 리뷰 키로만 쓰므로 무해.
5. **드리프트**: 차기 크롤에서 어태치행이 joysound 번호를 네이티브 획득하면 → 같은 J면
   Tier A가 먼저 합쳐 어태치는 no-op, 다른 J면 셀 충돌로 가드가 잡는다.
6. **4-way(한 J에 다리 3개)는 구조적으로 불가**: 벤더는 tj/ky/joysound 셋뿐이라 J당
   비-joysound 다리는 최대 2개(소유주 1 + 어태치 1). 단언 3(J 유일)이 미래에도 옳다.

---

## 6. 구현 스코프 (옵션 B2)

### 파일별 변경

| 파일 | 변경 |
|---|---|
| `packages/crawler/src/reviewedMergePairs.ts` | 어태치표 85엔트리 + 파생 Map export + 단언 5종 |
| `packages/crawler/src/merge.ts` | `collectTierF3wayAttachGroups` + `TIER_PIPELINE` 스테이지 1개(name `'F'` 재사용) |
| `scripts/encode-b-wave-merge-pairs.mjs` | 어태치 표 파싱 + 벤더-대칭 도출 경로 + 멱등 + 출력 섹션 |
| `scripts/data/b-review-merge-verdicts/batch-C-1.json`, `verdicts-C-1.json` | ky-41123 판정 원천 |
| `scripts/data/b-review-merge-verdicts/batch-D-2.json`, `verdicts-D-2.json` | tj-26145 판정 원천(override) |
| `scripts/diagnose-reviewed-tier-nonfire.mjs` | 어태치 단위(tier `F3`) 포함, 총 838 |
| `docs/ROADMAP.md` | 결정 큐 항목 4 해소 표기 |

### 테스트

- `packages/crawler/test/merge.test.ts` (+3): F-소유주 실쌍(ロボキッス tj-25875·ky-40141·
  joy-10140), E-소유주 실쌍(め組のひと tj-52758·ky-40918·joy-1006), 충돌 negative(부분실패
  — 소유주 발화 유지 + 어태치 스킵 + ky 충돌 로그). 아티스트/제목 상이로 자동 티어 차단.
- `scripts/encode-b-wave-merge-pairs.test.mjs` (+): 대칭 도출(owner tj→ky, owner ky→tj),
  타깃충돌 미방출, 멱등 already-encoded, 어태치 라인 포맷, **통합(커밋 데이터): merge 483 /
  빈 표에서 어태치 85 / 채운 표에서 멱등**.
- `scripts/diagnose-reviewed-tier-nonfire.test.mjs` (+1): 어태치 tier F3 집계.
- import-time 단언 5종은 crawler 테스트가 모듈 로드로 자동 실행.

### 발효

레포 레벨: 게이트 5종(biome/typecheck/test/build/knip) + 위 테스트. 데이터 레벨(oci,
오케스트레이터): crawler dist 재빌드 후 `scripts/diagnose-reviewed-tier-nonfire.mjs`를 v24
pre-merge 코퍼스에 재실행 → **823 fired + 4 conflict-skip / 838** 확인. 머지는 오너 승인 대기.
