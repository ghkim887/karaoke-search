# Roadmap

Owner-prioritized future work items, with the investigation data that scoped
them. Undecided items live in the [Open questions](#open-questions) section
below; see also [ARCHITECTURE.md](ARCHITECTURE.md). Items were added 2026-07-04
from an owner
review; numbers below were measured against the live serving DB
(`db/current/songs.sqlite`, release v20, 307,961 songs).

**Completed, closed, and resolved items are archived in [ROADMAP-LOG.md](ROADMAP-LOG.md)** — this file holds only live work (a compact index of archived items is at the bottom).

> **Serving state (2026-07-20): release v25 promoted** —
> `db/current → releases/data-2026-07-20-v25-reviewed-cleanup`: **312,571
> songs, joysound 312,147**. Recomposed from the frozen v22 lineage + KY
> integration with the full 2026-07-16~20 review cycle applied: reviewed
> merge units 838 (Tier E 271 / F 482 / 3-way attach 85, #163~#169),
> numberless purge (−771, #164), K-pop/Western-pop leak purge (−11 with the
> JOYSOUND-anchored guard sparing 101 legitimate JP releases, #167).
> Verified end-to-end (number conservation 141/141 on merges, public chain +
> real browser). Note: `dbUpdatedAt` stays 2026-07-16 (data-derived — no new
> crawl). Retention: v25+v24+v23+v22. History: v22 (2026-07-12, 313,467) →
> v23 (2026-07-16, +KY 314,209) → v24 (2026-07-20, cleanup 312,723) → v25.
>
> **Weekly automatic crawl: INDEFINITE HOLD (owner, 2026-07-12, re-affirmed
> 2026-07-13)** — see the [Open questions](#open-questions) subsection.
> The joyless-unmerged decision queue is now EXHAUSTED (v25 audit: 424
> remaining = 244 genuine gaps + 173 human-rejected + 7 owner no-action).

## R3. Full-corpus offline (PWA / fallback) — DECIDED direction, opt-in pack (2026-07-04)

> **Feasibility spike ✅ DONE (2026-07-12):** see
> `docs/research/2026-07-12-offline-pack-spike.md` (PR #130). Headlines:
> client DB is far smaller than estimated (FTS5 75.1 MiB raw / 21.6 MiB
> brotli download vs the 150–300 MB guess); HTTP-range transport works
> (~9 KiB per point query @ 1 KiB pages); FTS5/trigram floor at 3-char CJK
> confirmed empirically → the parity-complete HYBRID index remains the real
> design problem; iOS risk = eviction not quota (installed-PWA exemption;
> opfs-sahpool VFS). Verdicts: OPFS pack GO(needs device test), HTTP-range
> hybrid GO(needs real-browser follow-up). Implementation stays owner-gated.

**Owner question:** the whole DB is ~1 GB — why not ship it wholesale to the
PWA/offline fallback?

**Answer (measured):** the 1.1 GiB serving SQLite is the WRONG artifact to
ship — 77 % of it is the server-side inverted index (`search_tokens` 845 MB +
`search_token_stats` 67 MB), which only makes sense next to the worker's
query planner. The actual payload is small: `songs` 45 MB +
`karaoke_numbers` 26 MB + `search_texts` 52 MB (~130 MB uncompressed;
canonical `full-corpus.json` is 93 MB, ~25–30 MB gzipped). The current
offline path ships a 25,842-song / 10.9 MB subset and builds a MiniSearch
index client-side; the Open questions section (post-JOYSOUND data topology)
already measured client-side index build for a 221k corpus at ~316 MB heap /
~5.7 s on desktop Node — worse on
phones, and today's corpus is 307k. So "wholesale" fails not on download
size but on client index build/memory.

**Direction:** keep the default PWA as-is (subset + MiniSearch + API
fallback), and add an OPT-IN "full offline pack": a client-optimized SQLite
(songs + numbers + an FTS5 or trigram index built FOR sqlite-wasm, no server
token tables) stored in OPFS via sqlite-wasm — realistic size ~150–300 MB
download, index prebuilt so no client build cost. Risks to validate: iOS
Safari storage eviction of large OPFS files, and a second index
implementation needing its own parity gate against the worker (the golden
parity harness generalizes). Alternative worth prototyping first:
sqlite-wasm over HTTP range requests against a statically-hosted DB — no
full download, but online-only, so it complements rather than replaces the
pack.

**FTS5 is not a drop-in — only a hybrid spike is open.** The FTS5-or-trigram
index above cannot simply replace the client-side MiniSearch build: FTS5 lacks
the 1–2-char CJK, choseong, and romaji-prefix expansion that today's search
depends on, so a straight FTS5 index would regress short-query and phonetic
matching. The one open path is a *hybrid* spike — FTS5 (or trigram) for the
bulk term index plus a supplementary structure covering the short-CJK /
choseong / romaji-prefix cases — validated against the same golden parity gate
before it could replace anything.

## R4. Search enrichment from already-crawled JOYSOUND detail fields (ruby and more)

**Data already on the NAS, currently discarded by the pipeline:** the
JOYSOUND detail sweeps (e.g.
`runs/data-2026-06-14-artist-ko-ruby-full-sweep/joysound-detail-*.jsonl`,
236,434 records + retries) captured per-song `songNameRuby` (katakana
reading of the title), plus `lyricist`, `composer`, `tieupNames`
(anime/drama tie-ups), and stable `artistId`/`naviGroupId`. None of these
survive into `full-corpus.json` (schema has no ruby field) — the canonical
corpus keeps only what today's search uses.

**Work items, in value order:**

1. **Ruby → search tokens.** ✅ **DONE (#78 Stage 1 + #79 Stage 2).** Promoted
   `title_ruby` into the corpus schema (pure additive field), backfilled from
   the decision logs, indexed in `search_texts`. Unlocks searching kanji titles
   by reading ("マル" → ○), and — because kana→romaji and kana→hangul
   transliteration are deterministic — Latin-alphabet and Hangul phonetic search
   for Japanese titles ("마루" finding ○ needs no LLM, unlike title_ko).
   (Crawl-soak: ruby persistence for the ~70k backfill-uncovered songs is
   confirmed at the next weekly crawl.)
2. **Tie-up names → media context.** ⚪ **Open.** `tieupNames` extends
   `media_context_ko` coverage with authoritative Japanese tie-up titles
   (search "けいおん" and find its OP/ED songs).
3. **Lyricist/composer search** — ⚪ **Open.** A new searchable facet, cheap
   since the data is already captured.
4. **artistId/naviGroupId as merge keys** — 🟡 **Partial (#82).** Shipped as an
   R1-audit disambiguation SIGNAL (`build-joysound-artist-id-index.mjs` distils
   the detail logs; the audit takes `--artist-id-index`), NOT corpus
   persistence. Measured finding: the *match* direction confirms same-artist
   pairs, but the *reject* direction over-fires (~29 % false-reject on the
   reject set — JOYSOUND assigns one act multiple artistIds), so it needs a
   human/web pass, not blind trust. Corpus persistence for automatic future
   merges ("Option B") is deferred. Original intent: JOYSOUND's own stable
   artist IDs strengthen the R1 cluster-merge audit (two entries sharing
   `artistId` with different artist surface strings are the rename case,
   mechanically detectable).

All of these are behavior-preserving ADDITIONS (new fields, new tokens);
next crawl cycles should persist these detail fields into the corpus instead
of dropping them, with backfill from the retained run logs.

## R5. KY / DAM crawling and data expansion

**Current coverage is JOYSOUND-lopsided:** of 307,961 songs, 306,822 have a
JOYSOUND number but only 6,086 have TJ and 1,244 have KY. KY/DAM expansion
is the largest data-value item on the board.

Preparation checklist:

- **KY (Korean, kumyoung): source survey ✅ DONE (2026-07-10); adapter
  implementation stays owner-gated.** Findings (live-verified):
  - `kysing.kr` is KY's OFFICIAL catalog surface (금영엔터테인먼트 footer,
    biz-reg 221-88-00319). Legacy `kumyoung.com` still serves EUC-KR
    monthly/weekly charts (`/out_svc/chartkorea.asp`, plain HTTP only) —
    chart-only, no adapter value.
  - robots.txt allow-all (no disallow, no crawl-delay); terms
    (`/useguide/`) carry standard IP-reservation + a non-commercial clause,
    silent on bots/scraping. No anti-bot observed (no Cloudflare/CAPTCHA/
    rate-limit; search needs no login).
  - **No JSON API, no bulk feed, no kana-index equivalent** — WordPress,
    fully server-rendered GET HTML. Search:
    `GET /search/?category={N}&keyword={term}&s_page={page}` (category
    1=곡번호 2=곡명 7=아티스트 5=작곡 6=작사 4=가사 8=단곡명; ~15 rows/page;
    rows in `ul.search_chart_list > li`, clean strings in `span[title]`).
    Fields: number/title/artist/composer/lyricist/release(YYYY.MM)+flags.
  - Number search is EXACT on the UN-padded integer (`6286` hits, `06286`
    zero); the kysing 곡번호 == machine song number → a stable key aligned
    with our `karaoke_numbers`. Full enumeration = per-number probe over
    ~1..99999 (catalog ≈60k+, non-contiguous number space; ≈14 h at 500 ms
    politeness). Incremental delta = `/latest/` (이달의 신곡, recent months
    only).
  - Japanese songs are titled in JAPANESE script (good for our corpus
    keying) with tie-up appended in parens; LTS rows embed lyric/furigana
    blocks in the title cell (isolate `span[title]`). **⚠ JP title-search is
    unreliable** (existing exact titles can return 0) — an adapter must
    query by NUMBER or ARTIST and read titles from results, never search by
    JP title.
  - Adapter fit: the per-number probe + resumable decision-log pattern
    matches R7 (tjpdf→searchSong probe) and the v22 listing tool exactly;
    the new risk axis is HTML-parse fragility (fixtures + drift guards).
    The real bottleneck is MERGE pressure, not crawling: 1,244 existing KY
    numbers Tier-A-merge for free; the rest need title/artist soft-merge +
    R1-style human review rounds. Recommended sequence on go: ①1k-number
    probe spike (JP ratio / field quality) ②adapter+filter ③full sweep
    (oci, resumable) ④merge + review rounds → coverage gate.
- **DAM (Japanese, Daiichi Kosho):** NEW provider — requires widening the
  `karaoke_numbers` provider CHECK (`'tj','ky','joysound'`) in
  `packages/data-store/src/schema.ts`, the `@karaoke/schema` types, worker
  responses, and web provider badges. Source survey: denmoku/clubdam public
  search surfaces; expect JOYSOUND-scale catalog (~300k+).
- **Sequencing:** land R1 (merge audit) and R4-item-4 (artistId merge keys)
  first — every new provider multiplies duplicate-cluster pressure, and DAM
  at JOYSOUND scale would mint hundreds of thousands of merge decisions
  through whatever matcher exists at that point.

## Open questions

Live undecided items, with context and what unblocks each. Items referencing
the JOYSOUND feature branch (`feat/joysound-full-catalog-sweep`) describe
in-progress work that is NOT on `main` yet.

### Weekly automatic crawl — INDEFINITE HOLD (owner, re-affirmed 2026-07-13)

**Verification crawl COMPLETE (2026-07-13) — hold RE-AFFIRMED.** The owner's
one-off verification crawl ran successfully (runs 29201226028 + re-run
29220761383 after the `artist_ko` fix #139; crawl PR #140 merged). Every
pending surface was validated live — #125/#126/#128/#129/#131/#134/#136 —
parity flags triaged benign, gates green (this cleared the #126 live-gate and
#125 full-soak validations the hold had blocked, per the context below). The
owner then **RE-AFFIRMED the indefinite hold** (2026-07-13, "크롤 재개는
무기한 보류"); the workflow is back to `disabled_manually`.

**Owner directive: the scheduled weekly crawl is cancelled outright and held
indefinitely ("배포 전까지").** Executed via `gh workflow disable crawl`
(workflow state `disabled_manually` — blocks the Saturday 18:00 UTC cron AND
manual dispatch; no code change; reversible with `gh workflow enable
crawl.yml` but ONLY after confirming the owner's re-enable condition). The
in-flight 2026-07-12 retry run was cancelled mid-flight.

Context: the first scheduled soak (2026-07-11) worked as designed — the #97
crawler gate caught two Korean-leak rows and blocked the crawl PR (tj-68976
IVE "Will" → verified genuine JP release, allowed + render-fixed; tj-70438
CUTIE STREET "프리큐큐" → verified Korean-language version, per-song dropped;
both encoded in PR #126, unit-verified). Consequences while held: the tracked
baseline (offline bundle, TJ/blog freshness) stops updating; #126's live-gate
validation and #125's full-soak precondition cannot complete. The serving-DB
lane (v22) is unaffected.

### title_ko backlog — residuals only (web-verify pass DONE 2026-07-13)

**The review backlog is substantially RESOLVED (PR #147, owner-directed
"전곡 웹검색" pass):** every non-high cache entry (442 records incl. 22
recovered "Latin-only" mislabels) was web-searched by parallel workers —
49 upgraded to high on cited Korean sources, 16 unearned highs honestly
downgraded, and the **388 remaining medium/low are confirmed-no-canon**
(Korean sources use the Japanese titles; each record carries its search
evidence). The old ~255-row `llm-review.csv` owner-review premise is
superseded; the manual-fix workflow (`title-ko-manual-fixes.json`) stays
available for spot corrections.

Residuals: the 13 uncertain rows stay deliberately no-action; the **24 tj
interior-whitespace cases stay DORMANT** (restoring them needs
interior-space handling that risks cross-song merges — a future
harder-guarded pass; e.g. tj-26408 "One more time,One more chance"); future
new songs flow through the standing Stage-2 runbook. Full pass narrative in
[ROADMAP-LOG.md](ROADMAP-LOG.md).

### Chinese-leak detection — maintenance only

**The detector is now a classify-time defense (PR #148, 2026-07-13):**
`hasSimplifiedOnlyHan` (the same curated predicate the report-only audit
uses) vetoes artist-vote admits inside `jpn-admit-artist`, so
simplified-Chinese rows self-reject without hand-maintained drop-list
entries. Remaining live work is pure maintenance: grow the catalog-anomaly
ID list in `scripts/drop-artist-leaks.mjs` if a leak class the curated
76-char set cannot see ever surfaces (traditional-script Cantopop, kana-free
titles outside the set), and revisit list structure if the Chinese list
grows past ~20 entries (see PROJECT-KNOWLEDGE, drop lists).

(Detector, calibration, crawl-report wiring, and the classify-time
promotion are archived in [ROADMAP-LOG.md](ROADMAP-LOG.md).)

### TJ filter-seam + parity-baseline systemic follow-ups (2026-07-09 audit)

- **PRODUCT: `blog-*` record ids are positional and reshuffle each crawl.** #95
  re-assigned the Utada page ids wholesale (e.g. `blog-301-13` was 光, is now a different
  song), silently re-targeting device favorites (localStorage `karaoke-favorites:v1`).
  **SHIPPED 2026-07-14 (this PR — `docs/specs/2026-07-14-blog-stable-identity-design.md`):**
  D1 demote blog to the lowest merge rank (tj > tjpdf > joysound > blog) so merged
  clusters take the stable vendor id; D2 drop numberless blog rows (483 on the current
  corpus, report-observed); D3 reverse lookup for claimed-but-unmatched vendor numbers
  (JOYSOUND delisted report; TJ probe auto-ingest CLOSED 2026-07-14 — tj-media-direct
  self-feeds the seed post-crawl, probing blog-claimed TJ numbers it did not emit and
  admitting hits through the normal filter chain); D4 residual stable minting `blog-{artistId}-{vendor}-{number}`;
  D5 favorites unchanged (backward compat waived — stale favorites silently dangle).
  Effects land at crawl resume (corpus loses the numberless rows, merged records surface
  under vendor ids); sidecars (134 cache + 1 hint) re-keyed now via the v22 two-sided
  replay map. Parity baseline regenerates with the first resumed-crawl PR.

*(The completed parity-baseline-regeneration-policy and smoke-fixture bullets,
and the filter-seam script guard — SHIPPED 2026-07-13, PR #143 — are archived
in [ROADMAP-LOG.md](ROADMAP-LOG.md).)*

### 미병합 잔여 (2026-07-20 검증) — 오너 결정 큐

v24 서빙 기준 JOYSOUND 미병합 576곡을 전수 교차검증한 결과 (리포트: NAS
`runs/ky-v23-20260716/audit-v24r2/unmerged-xref.json`):

576 = **C 253** (진성 커버리지 갭 — 무행동) + **reject 176** (B-wave 리뷰의
reject 판정 유지) + **merge-판정 잔존 141** (merge 판정이 v24 재병합에서 발화하지
못한 잔여) + **uncertain 5** (버전 애매, 목록은 #163 본문) + **fresh 1** (신규).

#166이 merge-판정 잔존 141곡 중 **46곡(both-vendor, non-tj id)** 을 Tier E로
인코딩했다 (#163이 "표현불가(both-vendor non-tj id)"로 남긴 클래스, #165가
리뷰드 티어의 tj-슬러그/싱글턴 가드를 제거해 가능해짐). 남은 141 − 46 = 95곡 +
fresh 1 + uncertain 5에 대한 **2026-07-20 오너 판정** (이 PR이 인코딩):

1. **forbidden 충돌 8곡 = 해소 (이 PR).** B-wave 웹 확인이 각 보류 사유를
   충족해 오너가 일괄 해제 — reviewedMergePairs.ts FORBIDDEN 세트에서 제거하고
   인코더가 방출한 형태 그대로 리뷰드-강 allowlist(Tier E 5 / Tier F 3)로
   인코딩했다. 목록: tj-26121→65623, tj-6927→19868, tj-6935→21182,
   tj-25022→11802, tj-26750→168779, tj-68183→683200, tj-68258→445312,
   tj-68290→731408.
2. **uncertain 5곡 → 2 인코딩 (이 PR) + 3 무행동 종결.** 인코딩(둘 다 Tier F):
   tj-28672 "Baby I Love U"/Che'Nelle → joy 28921 (JOYSOUND의 Che'Nelle 명의
   행은 English Ver. 유일), ky-40449 "忘れていいの" 듀엣판 → joy 1546 (듀엣 행
   -愛の幕切れ- 실재 확인, 抱擁 원판 솔로와 구분). 두 곡의 B-wave 판정은
   "uncertain"이므로 D-1 보충 판정 파일(verdicts-D-1.json / batch-D-1.json)로
   근거와 함께 기록했고, 인코더는 "나중 파일 우선" 규칙으로 B-wave uncertain
   위에 D-1 merge를 명시적으로 덮어쓴다(오버라이드는 로그로 노출). 무행동 종결
   3곡: ky-42459 "くればいいのに"/KREVA (버전 판별 불가), tj-26321 "MORNING
   CALL FROM THE BEACH"/渚のオールスターズ (명의 상충 — 별 레코딩), tj-6451
   "武田節"/三橋美智也 (JOYSOUND 미수록).
3. **벤더번호 진짜 충돌 4곡 = 무행동 종결** (tj-6579 / tj-27098 / tj-27416 /
   tj-26737). 2026-07-20 오너 판정: TJ 공식 확인 결과 4곡 모두 두 TJ 번호가
   병행 실재하므로 병합 시 번호가 유실된다 — 두 행 유지가 정답이고 #165
   충돌가드의 스킵은 정당하다. (tj-26737은 인코더에서 여전히
   both-vendor-number "메커니즘 표현불가" 버킷으로 남으며, 버킷 명칭은
   무관하게 그대로 둔다.)
4. **3-way 클래스 85곡 = 해소 (2026-07-20 B2 어태치 PR).** dup-J(unique-joysound)
   불변식을 옵션 B2(리뷰드 3-way ky/tj-어태치 확장표)로 "J당 벤더별 다리 1개"로
   완화 — 리뷰드 쌍 한정, 벤더번호 충돌가드 유지. 설계·옵션 기각 근거:
   [docs/specs/2026-07-20-reviewed-3way-attach-design.md](specs/2026-07-20-reviewed-3way-attach-design.md).
   구현: `REVIEWED_TIER_F_3WAY_ATTACH_PAIRS` 85엔트리(인코더 방출 그대로) +
   Tier F 직후 어태치 스테이지(merge.ts, 콜렉터 재사용) + import-time 단언 5종
   (최초의 표 간 불변식 — 모든 어태치 J가 E∪F에 존재). 구성 = 도출 83(전원 ky측,
   소유주 tj) + 보충 ky-41123(소유주 Tier F tj-25640, C-1 판정) + 보충 tj-26145
   (소유주 Tier F ky-40449, D-2 판정 — B-wave reject를 신발견 듀엣 행 joy 1546으로
   뒤집은 later-file-wins 오버라이드; tj가 ky-소유 J에 붙는 벤더-대칭 최초 사례).
   충돌 시 어태치만 스킵+로그(우아한 부분 실패), 소유주 쌍 병합은 유지.

**발효 캐비엇:** 이 PR의 어태치 85건과 앞선 10쌍(forbidden 해제 8 + uncertain→merge
2)·#166의 46곡을 포함해 어떤 조치든 실제 발효는 다음 재병합 (크롤 재개 또는 v25
재구성) 시점이다. 이 PR에 데이터/코퍼스 재생성은 없다. 데이터 레벨 검증(diag
리뷰드 단위 838 = E 271 + F 482 + 어태치 85, 823 fired + 4 conflict-skip 기대)은
oci에서 오케스트레이터가 수행한다.

## Completed (archived)

Full narratives live in [ROADMAP-LOG.md](ROADMAP-LOG.md).

- **R1** — TJ/KY-without-JOYSOUND audit: DONE 2026-07-05 (#73/#76/#84–#88); merger-mechanism + version-ambiguous pairs RESOLVED 2026-07-10 (owner, unlinked-by-design).
- **R2** — UI language separation (ko/en/ja chrome): DONE 2026-07-04 (#75, #81).
- **R6** — Pages-Functions liveness check: DONE 2026-07-10 (PR #117).
- **R7** — tjpdf PDF ingest replaced by TJ searchSong probe: COMPLETE 2026-07-12 (PR #125 + discovery sweep #131).
- **JOYSOUND runbook owner checkpoints** — HISTORICAL / COMPLETED 2026-07-10 (shipped as serving release v21).
- **title_ko review — completed pre-review + Stage-2 drift** — pre-review + PR #109 DONE 2026-07-10; drift RESOLVED 2026-07-12 (PR #129). Incremental review remains live.
- **Search-engine dead-schema retirement** — RESOLVED 2026-07-08 (by removal).
- **D1 free-tier 500 MB vs JOYSOUND-scale corpus** — RESOLVED 2026-06-13 (by removal).
- **Post-JOYSOUND refactor backlog** — DONE 2026-07-13 (last items: classifier gate-array #135, .tmp_review cleanup).
- **2026-07-09 audit deferred findings** — RESOLVED 2026-07-10 (PR #107; refactor batch PR #100).
- **Chinese-leak detection — shipped detector/calibration/crawl-report wiring** — #120 (2026-07-10), calibration 2026-07-12, #128 (2026-07-12). Growing the anomaly list remains live.
- **TJ filter-seam + parity — completed items** — search-parity baseline regeneration policy (PR #106, 2026-07-10) + smoke-fixture stable-key re-pin (2026-07-10). Filter-seam guard SHIPPED 2026-07-13 (#143); blog-id stable-identity SHIPPED 2026-07-14.
- **Watchdog alert channel** — CLOSED 2026-07-10 (owner: no dedicated channel).
- **TJ filter-seam script guard** — SHIPPED 2026-07-13 (PR #143): Option-C veto inside `jpn-admit-artist`; incident clones self-reject without drop-list entries; Latin-titled residual tail stays on the drop list.
- **JOYSOUND classifier predicate unification (Phases 1+2)** — Phase 1 (T5-D); Phase 2 DONE 2026-07-13 (PR #142, 0 flips over the 352,290-row v22 replay).
- **Offsite full-corpus backup (§8)** — CANCELLED 2026-07-13 (owner): no backup will be made; accepted recovery path = full re-crawl. Supersedes the 2026-07-12 "private" direction.
- **Post-JOYSOUND data topology** — DECIDED 2026-06-10 → CLOSED 2026-07-13. Release-asset mechanism never used; retired in two phases (phase 1 #149 deleted the publish workflow + fetch/verify + dangling manifest; phase 2 repointed the serving runbook onto `build-sqlite-db.mjs` and deleted the `publish-full-corpus.mjs` wrapper + `lib/manifest.mjs`).
- **Minor backlog (2026-07-13 verification round)** — ALL 5 CLOSED 2026-07-13: ②③⑤ via PR #146 (deterministic `crawled_at`, 29 edge-trimmed catalog titles + 28 cache realigns, migration-orphan warning), ①④ via PR #147 (inert hipmic prune + 48 media contexts); bonus: 17 stale-Chinese cache prunes + the tjpdf-68315 re-key.
- **title_ko web-verify pass** — DONE 2026-07-13 (PR #147): 442 non-high/mislabeled records web-searched, 49 canonical upgrades, 16 honest downgrades, 388 confirmed-no-canon remain; cache 3,689 decisions (high 3,301).
- **Simplified-Chinese classify-time guard** — SHIPPED 2026-07-13 (PR #148): the audit predicate now vetoes artist-vote admits (report-only detector promoted; deny-list/audit/report stay as outer defense).
