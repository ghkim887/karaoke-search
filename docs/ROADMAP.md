# Roadmap

Owner-prioritized future work items, with the investigation data that scoped
them. Undecided items live in the [Open questions](#open-questions) section
below; see also [ARCHITECTURE.md](ARCHITECTURE.md). Items were added 2026-07-04
from an owner
review; numbers below were measured against the live serving DB
(`db/current/songs.sqlite`, release v20, 307,961 songs).

> **Serving state (2026-07-12): release v22 promoted** —
> `db/current → releases/data-2026-07-12-v22-fullcatalog`: **313,467 songs,
> joysound 312,170** (v21 306,822 +5,348), `title_ruby` coverage **91.7%**
> (287,333; was ~77%), reviewedMergePairs Tier E 196 fully applied (the
> #110 five fired for the first time), 167-row purge holds. Built from the
> 2026-07-10 fresh fullCatalog listing (352,290 rows) + detail sweep;
> public-chain verified (meta `dbUpdatedAt 2026-07-12`). Retention: v22+v21.
>
> **Weekly automatic crawl: INDEFINITE HOLD (owner, 2026-07-12)** — see the
> [Open questions](#open-questions) subsection.

## R1. Songs with a TJ/KY number but no JOYSOUND number (suspected unmerged clusters)

**Owner observation:** a song that TJ or KY carries should essentially always
exist in JOYSOUND's catalog too — a missing JOYSOUND number means either an
unmerged duplicate cluster or a crawl-stage miss.

**Measured (2026-07-04):** 378 songs have a TJ number (16 of those also KY)
but a NULL JOYSOUND number. Sources: `tj-*` (newSongOfMonth), `tjpdf-*`
(poster PDFs), `blog-*` playlists. (Separately, 761 songs have NO number from
any provider — all 761 are `blog-*` entries whose playlist rows carry no
numbers; that is expected, not a defect.)

**Spot-check evidence points at merge failures, not crawl gaps:**

- `tj-27185` マイホーム / 関ジャニ∞ vs `joysound-166186` マイホーム /
  SUPER EIGHT — the artist RENAMED (関ジャニ∞ → SUPER EIGHT, 2024), so
  artist-key matching failed. Note `joysound-166186` even carries its own TJ
  number (94522) — two TJ entries for the same song under old/new artist names.
- `blog-428-4` パンダヒーロー / ハチ vs `tj-27416` パンダヒーロー / GUMI
  (JOYSOUND 145546) — vocaloid producer-vs-vocalist credit mismatch.
- `tj-26849` GREEN / 浜崎あゆみ — JOYSOUND has GREEN under 4+ other artists;
  the Hamasaki entry likely exists under a differently-rendered artist key.
- Title decorations are a second axis: TJ appends tie-up suffixes
  (`Don’t say “lazy”(けいおん! ED)`) and odd spacing (`抱 擁`) that break
  exact-title clustering.

**Status (2026-07-05): ✅ DONE** — audit CLI (#73) + full tier-A/B/C human/web
review (#76/#84–#88) → `reviewedMergePairs` Tier E = 196 / Tier F = 161
(applied at the next crawl). ~10 residual confirmed pairs need the
merger-mechanism extension (see the R1 follow-up subsection below). Original
work item below.

**Work item:** scripted audit of all 378 — for each, search JOYSOUND-numbered
songs by normalized title, emit candidate pairs with artist-similarity
signals; route through the existing `reviewedMergePairs` human-review flow.
Small enough (hundreds) for one review pass. Genuine JOYSOUND catalog gaps
(e.g. Korean songs TJ licensed but JOYSOUND never carried) are the expected
residue and should be tagged as such, not force-merged. Do this BEFORE R5
(KY/DAM expansion) — the same artist-variant merge weaknesses will multiply
with every new provider.

### R1 follow-up — merger-mechanism extension (RESOLVED 2026-07-10, owner: unlinked-by-design)

**Status update (2026-07-10, live-API-verified recon):** the "embedded-TJ/KY
bridge" premise is dead — JOYSOUND-sourced rows never carry TJ/KY numbers (the
adapter hard-nulls them; the API exposes no competitor numbers). **6 songs
remain genuinely blocked** (the 5 candidate-own-TJ pairs below plus
パンダヒーロー, whose joy145546 is bound to tj-27416/GUMI) — every one is a
two-TJ conflict that the single-value-per-vendor data model cannot hold. Also:
the Tier F entry `['tj','28268','162483']` is INERT (soft-merge claims the joy
side before Tier F runs) and should be removed/superseded when any mechanism
lands; the pair comments' `blog-523-9`/`blog-163-90` ids drifted in #95 (now
-10/-91).

**Correction (2026-07-12, verified against the v22 build):** the earlier claim
that 4 both-vendor pairs (aLIEz, &Z, Astronauts, 天使と悪魔) would "resolve by
plain Tier A at the next corpus build" was WRONG. What actually happens (v21
and v22 both): `build-joysound-candidate`'s existing-number conflict-resolution
step treats the blog rows' joysound cells as misattributed (the blog↔sweep
identity match fails on artist rendering differences even though the owner's
R1 review confirmed the attribution) and NULLS them, so the blog row (tj+ky)
and the joysound-source row stay SEPARATE records — no Tier A union ever fires.
Both rows remain individually searchable by their own numbers; this is the
standing state since June, not a v22 regression, and it is consistent with the
unlinked-by-design closure above. If ever revisited, the fix is in the
conflict matcher (`normalizeForConflictMatch` vs owner-reviewed attributions),
not in Tier A.

**Owner decision (2026-07-10): RESOLVED — the 6 pairs stay separate, unlinked
records BY DESIGN.** Initially held on the suspicion that the twin TJ numbers
are legitimately distinct catalog entries; a same-day web verification (owner
directive: "keep unlinked, but verify none of the numbers is fake") CONFIRMED
that suspicion for **all 12 numbers** against TJ's own live catalog
(`tjmedia.com/song/accompaniment_search?searchTxt=<num>&strType=16`, primary;
datalibrary.info/karaoke + namu.wiki/VocaDB corroboration; 3 numbers
independently re-checked by the orchestrator). Every pair is a systematic,
deliberate double-listing — no fake/stale numbers, so no data change is needed
and no merge/alias/link mechanism will be built for them:

| Pair | TJ num — credit (verbatim) | TJ num — credit (verbatim) | Pattern |
|---|---|---|---|
| Rocket Dive | 6579 — hide with Spread Beaver (AWOL OP) | 25103 — hide | old block band credit vs later solo credit |
| ALWAYS | 27011 — 中島美嘉 | 27098 — 中島美嘉 (サヨナライツカ OST) | plain vs OST-tagged registration |
| まっがーれ↓スペクタクル | 26737 — 古泉一樹 (Character Song) | 28268 — 小野大輔 (OST) | character credit vs CV credit |
| DIVISION BATTLE ANTHEM | 28871 — Division All Stars | 68196 — same, title suffix " +" | 2xxxx base vs 6xxxx re-registration ("+" = TJ's update marker) |
| Division Rap Battle | 28879 — Division All Stars | 68160 — same, title suffix " ＋" | same re-registration pattern |
| パンダヒーロー | 28247 — ハチ(Feat.GUMI) | 27416 — GUMI | producer credit vs vocaloid credit |

Search finds every entry by its own number/title/artist today; the two rows per
song are each faithful to TJ's actual catalog. Anyone re-reading this later:
do NOT re-propose a merge/alias for these pairs without NEW evidence (e.g. TJ
retiring one of the numbers).

The R1 audit was fully reviewed across all three tiers (A/B/C) over PRs
#76/#84–#88; ~120 reviewed pairs are now in `reviewedMergePairs.ts`
(Tier E = 196, Tier F = 161, applied at the next crawl). **~10 confirmed
merges remain UN-encodable** because the current allowlist data shapes —
Tier E `[tj, joysound]` and Tier F `[vendor, number, joysound]` — can only
express "one affected vendor number ↔ one JOYSOUND number". Two shapes fall
outside that and are deliberately left out (see the comments in
`reviewedMergePairs.ts`):

1. **Candidate carries its own conflicting TJ number.** The JOYSOUND-bearing
   record also has a `tj` cell of its own, so a Tier-E `[tj, joysound]` merge
   would union two *different* TJ numbers onto one song (a conflict).
   Affected: `tj-25103`↔joy17108 (cand tj-6579), `tj-27098`↔joy91999
   (cand blog-523-9), `tjpdf-28268`↔joy162483 (cand tj 26737),
   `tjpdf-28871`↔joy448383 (cand tj 68196), `tjpdf-28879`↔joy443948
   (cand tj 68160).
2. **Affected song has BOTH `tj` and `ky` (both-vendor target).** Neither
   Tier E nor Tier F (single vendor:number key) can attach *both* numbers to
   one JOYSOUND number. Affected: `blog-1184-1` (aLIEz, tj28007+ky43845→316353),
   `blog-1184-3` (&Z→670815), `blog-487-11` (アストロノーツ→723196),
   `blog-163-90` (天使と悪魔, 世界の終わり=SEKAI NO OWARI→93423),
   `blog-428-4` (パンダヒーロー, ハチ/GUMI→145546).

A partial escape hatch already exists — `REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS`
maps an explicit `(vendor,number,joysound)` triple to ONE extra provider cell
(used for `tj-68342` 再会 + ky44631). It is not general: it doesn't cover the
candidate-own-TJ conflict, and it only permits a single extra cell.

**Work item (CLOSED 2026-07-10 by the unlinked-by-design decision — kept only
as reference should a NEW pair shape ever appear):** the mechanism sketches
were (a) a reviewed rule letting an affected record absorb a JOYSOUND number
from a candidate that carries its own conflicting TJ (dropping/relocating the
candidate's TJ deliberately), and (b) a multi-number reviewed-pair shape (or
generalized `ALLOWED_JOY_SIDE_EXTRA_PROVIDERS`) attaching a both-vendor
(tj+ky) affected record to one JOYSOUND number. If ever revived: keep it
exact-pair-reviewed (no broad artist rule), and remove the inert Tier F entry
`['tj','28268','162483']` at that time.

**Version-ambiguous pairs — RESOLVED (2026-07-10, owner).** Of the ~7 held, 5
are now encoded as Tier E: `tj-26271↔joy166525` (STILL JP-language version),
`tj-27017↔joy175060` (BLACK DIAMOND major cut over indies), `tj-52426↔joy806868`
(Nenenene reco-oto cut over honnin-eizou), and the two Various-Artists↔Musical
title-only placeholders `tj-26411↔joy166164` and `tj-26827↔joy172354`. 2 are
CLOSED as keep-separate: `tj-26350` "Still (Eng Ver.)" stays a distinct TJ-only
entry (both TJ and JOYSOUND treat language versions as separate songs; a
same-song ruling would need the held two-TJ mechanism), and `tj-26410`
"Do your Best" was rejected as too risky (title-only match against a placeholder
artist, the title has many decoys, and the candidate differs by punctuation).

## R2. UI language separation (Korean / English / Japanese)

**Status: ✅ DONE.** Shipped the ko/en/ja chrome switcher (#75 — persisted
module store + header dropdown) and then, per owner decision, made the `ko`
chrome Korean-only (#81 — dropped the bilingual `한국어 / English` fragments;
deployed to karaokedb.pages.dev + real-browser verified). Only `appSubtitle`
("Karaoke Search") and the footer `KARAOKE SEARCH` wordmark stay English as a
fixed brand. Original scope below.

The web UI was Korean-only (inline strings in
`apps/web/src/components/`). Work item: extract UI strings to locale
resources, add a language switcher (persisted), provide ko/en/ja
translations. Touches: component strings, search placeholders, error
messages (T5 error surfacing), PWA `manifest.webmanifest` name/description,
`<html lang>` (currently set per a11y round), and the offline-fallback
banner. Song DATA fields (`title_ko` etc.) are out of scope — this is chrome
i18n, not data translation. No decision blockers; pure implementation.

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

## R6. Ops / monitoring follow-ups

- **Pages-Functions liveness check.** ✅ **DONE (PR #117, 2026-07-10).**
  `.github/workflows/liveness.yml` probes the live public site every 30 minutes
  (healthz `{"ok":true}` proves the Pages Function → Funnel → origin chain;
  /api/meta contract shape; a stable /api/search probe), 3 retries per probe;
  a failed scheduled run relies on GitHub's default failure e-mail —
  deliberately no new alert channel (§9 stays owner-held). Original scope:
  `apps/web/functions/*` proxy same-origin requests to the self-host API
  (reached over Tailscale Funnel); a wedged origin used to be a silent search
  outage on the public site.

## R7. Replace the tjpdf PDF ingest with a TJ searchSong number-probe (✅ DONE — merged + discovery sweep landed)

**Status (2026-07-12): COMPLETE.** Implemented as **PR #125** (merged with
owner approval; the upcoming owner-run verification crawl is its live soak):
probe (live-validated 635/635) → committed `scripts/data/tjpdf-catalog.jsonl`
→ offline pipeline ingest replacing the python; both title_ko guard surfaces
realigned (6 manual-fix guards + 353 Stage-2 cache entries, title_ko 376→376
LOST 0 proven; drift-pin tests added). **Discovery sweep also DONE (PR #131)**:
ranges 28000–29999 + 68000–70500 probed (4,501 numbers) → 298 corpus-absent
JPN songs added to the catalog/seed (635→933); ingest slice shows **240
genuinely-new songs** enter at the next pipeline run while the Korean-artist
drop list correctly blocks the other 58 (K-pop-in-Japan releases — TWICE/BTS/
IVE/aespa etc.; individually rescuable via per-song allows like tj-68976 if
ever wanted). New songs' title_ko flows to the standing Stage-2 LLM backlog.
Remaining follow-up only: future discovery sweeps over new number blocks as
TJ's catalog grows.

**Original decision (2026-07-10): document only; implementation was gated on a
separate go (granted later the same day).** Outcome of a drop-review of the
`tjpdf` source.

**Context.** `tjpdf-*` is not a crawler: `scripts/ingest_anisong_pdf.py`
re-inserts (coverage-only, idempotent) ~632 anime/vocaloid TJ numbers parsed
from a MANUALLY downloaded TJ poster-songbook PDF
(`scripts/data/anisong_utf8.txt`, via `pdftotext -table`). It exists because
the `tj-media-direct` bulk feed (`newSongOfMonth`, one POST ≈ 67k items)
does not carry these numbers at all — measured: tjpdf fills the 28xxx block
with 518 numbers where the bulk feed has only 170. Dropping it outright was
evaluated and REJECTED: the tracked baseline would lose all 635 songs
(sole-source there), the full corpus would lose 43 songs entirely and the TJ
number on 589 more (TJ coverage −10.4%), and 376 LLM title_ko + 72
tjpdf-keyed Tier F pairs would go dead.

**Verification that unlocks the replacement (2026-07-10).** A full reverse
probe of all 632 tjpdf numbers against the legacy JSON API
(`POST /legacy/api/searchSong`, body `searchTxt=<num>&strType=16&nationType=`)
found **632/632 as exact `pro` matches, 0 errors**, every one tagged
`nationalcode=JPN`, with title/artist/publishdate — and the API titles are
CLEANER than the PDF: both known PDF column-leak corruptions come back intact
(`28477 → 紫陽花アイ愛物語(パタリロ西遊記! OP)`,
`68430 → ぐだふわエブリデー(…300年… OP)`). Probe cost ≈ 7 min at the
adapter's production TJ politeness (500ms ± 100ms).

**Design sketch (when picked up):**

- Replace the PDF post-step with an API number-probe enrichment: a committed
  seed list of the known numbers (the current 632) fetched via
  `searchSong strType=16`; emit records with the SAME `tjpdf-<num>` id shape
  (ids derive from the TJ number, so the translation cache, manual fixes,
  Tier F pairs, and parity baselines see zero churn).
- New-number DISCOVERY replaces manual PDF acquisition: a polite number-range
  sweep over the anime blocks (28xxx–29xxx, 68xxx+) — `strType=16` returns
  exact hits, so unknown numbers are directly enumerable; JPN filtering comes
  free from `nationalcode`.
- Side effects: retires `ingest_anisong_pdf.py` + `test_ingest_anisong_pdf.py`
  + `anisong_utf8.txt` + the manual PDF download/convert step. (The two
  corrupted `title_primary` values were fixed ahead of this item by PR #122,
  2026-07-10 — an API-verbatim override map in the ingest, plus realigning the
  tjpdf-28477 manual title_ko fix guard from PR #109 so it keeps applying.)
- NON-goal: `title_ko` stays on the LLM Stage-2 pipeline — the API's
  `sortTitleKo` is a katakana→hangul sort helper, exactly the class Stage 1
  deliberately strips as "not a translation"; JOYSOUND ruby is likewise a
  phonetic reading, not a Korean title. No substitute exists for the
  translation channel.

## Open questions

Live undecided items, with context and what unblocks each. Items referencing
the JOYSOUND feature branch (`feat/joysound-full-catalog-sweep`) describe
in-progress work that is NOT on `main` yet.

### Weekly automatic crawl — INDEFINITE HOLD (owner, 2026-07-12)

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

### Post-JOYSOUND data topology (DECIDED 2026-06-10)

**Decision (owner-approved, hybrid):** the tracked
`apps/web/public/data/songs.json` baseline (~25.8k) stays exactly as today
(offline bundle + weekly crawl PR diff); the post-JOYSOUND full corpus
(~221k, ~85 MB) lives OUTSIDE git as a GitHub Release asset, and git tracks
only a small manifest (`data/full-corpus.manifest.json`:
sha256/url/sizeBytes/record+vendor counts). The self-host SQLite build
consumes the release asset via the manifest. Rationale: the
full corpus breaks both git limits (85 MB vs the 100 MB hard block) and
client-side index-build UX (~316 MB heap / ~5.7 s on desktop Node — worse
on phones), while a Release asset needs zero new secrets and the
store-agnostic manifest makes a later R2 swap a one-line `url` change.

Tooling landed (PR-1): `scripts/publish-full-corpus.mjs` (validate →
manifest [+ optional SQLite]) and `scripts/fetch-full-corpus.mjs`
(download → sha256+size verify → atomic write), shared logic in
`scripts/lib/manifest.mjs`. Remaining open sub-items:

- **PR-2 (workflow):** a `workflow_dispatch` full-corpus pipeline — compose
  → `gh release create` with the corpus asset → manifest-update PR. Weekly
  `crawl.yml` stays unchanged (baseline path preserved).
- **PR-3 (first publish/import):** publish the first release, build the
  self-host SQLite database from it, stand up the self-host API, then the
  web deploy flip (Cloudflare Pages root build with same-origin
  `PUBLIC_KARAOKE_API_BASE_URL=/` and Pages Functions proxying to the
  self-host API origin).

### JOYSOUND runbook owner checkpoints

**Status (2026-07-10): HISTORICAL / COMPLETED.** The June JOYSOUND
detail-crawl → candidate-build → merge flow described below shipped as serving
release v21 (live since 2026-07-04); the `feat/joysound-full-catalog-sweep`
feature branch is merged/gone and its runbook now lives on `main`. The
checkpoints below are retained for the historical record, not as pending work.

From the deploy runbook (on the feature branch:
`docs/superpowers/runbooks/2026-06-09-joysound-deploy.md`):

- **CHECKPOINT 1:** owner spot-check of the 175 ALLOW recoveries in
  `joysound-adjudication-review.csv`
  (`.tmp_review/joysound-sweep-2026-06-09/adjudication/`, untracked) before
  the `reviewedJoysoundOverrides` ALLOW list is committed.
- **Commit approval** for the reviewed in-flight branch work (explicit-path
  commits per runbook §2).
- Status note: the **full detail-fetching crawl STARTED 2026-06-10**
  (~33 h ETA, resumable via its append-only decision log). After it
  completes: candidate build → Layer-3 re-sampling (≥99 % precision gate) →
  the data-topology decision above gates the actual merge.

### title_ko review CSV backlog

**Status update (2026-07-10):** a full agent pre-review of all 255
medium/low-confidence rows completed (ok 215 / fix 27 / uncertain 13). The 24
net owner-signed fixes (19 mistranslations + 5 empty-value fills) landed via
PR #109 — `scripts/data/title-ko-manual-fixes.json` grew 3 → 27 entries (corpus
application at the next post-crawl pipeline run). The 13 uncertain rows are
deliberately left no-action. The remainder stays incremental owner-review work.

`scripts/data/llm-review.csv` carries the ~255 medium/low-confidence LLM
translations. Workflow: spot a wrong entry → append a
`{id, title_primary, title_ko}` row to
`scripts/data/title-ko-manual-fixes.json` → commit; the next post-crawl
pipeline run applies it. Unblocked by: owner review time (incremental — any
subset helps).

**Stage-2 cache title drift — measured and largely RESOLVED (PR #129,
2026-07-12):** of the 380 drifted entries, 169 were real losses; a guarded
mechanical re-key (`scripts/rekey-llm-translation-titles.mjs`, reusable +
19 tests) realigned 298 tj- guards → **+149 Korean titles restore at the next
pipeline run**. Deliberately declined: 57 reassigned blog- ids (different
songs — positional-id reshuffle), 1 destructive-nullout hold, and **24 tj
interior-whitespace cases that stay DORMANT** (restoring them needs
interior-space handling that risks cross-song merges — a future
harder-guarded pass; e.g. tj-26408 "One more time,One more chance"). Blog
guards will drift again with future crawls — rerun the re-key tool then.

### Search-engine dead-schema retirement (RESOLVED 2026-07-08 — by removal)

A 2026-07-07 audit found serve-dead search schema: `text_norm` (on both
`search_texts` and `search_hints`), the entire `search_hints` table, and the
`title_ruby` serve projection were written on import but never read at
serve/export/rebuild (recall materializes through `search_tokens`). Retired: the
`search_texts.text_norm` column and the `search_hints` table are dropped from
`SONG_SCHEMA_SQL` (with legacy-convergence guards for delta patches on older
databases), and the worker's serve projection stops fetching `title_ruby`
(`title_ruby` still round-trips through the export projection and the corpus).
The search-only hint channel is KEPT and properly wired: the 16 curated
artist-search hints now live in the committed `data/search-hints.jsonl` and
materialize into `search_tokens(title_hint/artist_hint)` at build via
`publish-full-corpus.mjs --search-hints` (see ARCHITECTURE "Search-only hint
channel"). Recall is unchanged — the search-parity golden/baseline regenerate to
a no-op.

### D1 free-tier 500 MB vs the JOYSOUND-scale corpus (RESOLVED 2026-06-13 — by removal)

Resolved by removing the Cloudflare deploy path entirely: the owner decided
self-hosting (`apps/worker/src/node-server.ts`,
`pnpm --filter @karaoke/worker serve:node` over the SQLite database from
`sqlite:build`) is the only serving path, so the D1 500 MB free-tier cap no
longer applies. Background: the streamed D1 SQL export for the ~221k–236k
candidate measured ~946 MB during the 2026-06 JOYSOUND candidate dry-run —
well past the cap — which motivated the decision. Workers + D1 + wrangler
tooling was deleted from the repo on 2026-06-13.

### Post-JOYSOUND refactor backlog (mostly ✅ DONE as of 2026-07-10)

Originally parked to avoid feature-branch conflicts. Status audit 2026-07-10:
three items had ALREADY shipped in the tier 0-2 refactor commit `089e8c5`
(this list was stale); two more shipped today (PR #119, #121). Only two items
remain open (marked below).

- ✅ worker dedup (done in `089e8c5`): single `StoredSongRow` declaration at
  `packages/data-store/src/import-export.ts`, imported by the worker
  (the `splitSqlStatements` half was resolved by deletion when
  the D1 import scripts were removed 2026-06-13);
- ✅ `apps/worker/scripts/build-sqlite-db.mjs` bare `@karaoke/data-store`
  specifier (done in `089e8c5`);
- the worker's `D1*` interfaces (now `SearchDatabase`/`PreparedStatementLike`/
  `QueryResult`/`SqlValue`), the sqlite-adapter's `SqliteSearchDatabase`, and
  data-store's `SONG_SCHEMA_SQL` were renamed backend-neutral (T3-1). The
  `.wrangler/` scratch-dir convention in `apps/worker/scripts/build-sqlite-db.mjs`
  was neutralized to `apps/worker/.build/sqlite/` (T4-5) via a coordinated
  `.gitignore` + pin-test (`apps/worker/test/ci-pipeline-pins.test.ts`) change;
  `apps/worker/.wrangler/` stays gitignored for historical local scratch, and
  `apps/web/.wrangler/` is retained as live Cloudflare Pages local state
  (`apps/web/wrangler.toml`);
- ✅ `apps/web/src/components/App.tsx` hook extraction (PR #119, 2026-07-10):
  the remaining inline search-query/vendor-filter/retry-nonce machines moved
  to `apps/web/src/hooks/` (earlier API/corpus/results/fallback hooks were
  already extracted); App.tsx is composition + rendering;
- ✅ DONE — JOYSOUND classifier gate-array restructure (2026-07-12): the
  monolithic `classifyJoysoundRecordWithReason` guard-clause chain is now an
  ordered `JOYSOUND_GATES` array + a `PHASE_ORDER` data declaration with a
  load-time `assertPhaseOrder()` (the load-bearing order is machine-checked at
  import, no longer prose-only). Control-flow reshape ONLY — no predicate change
  (the RE_HAN/RE_HANGUL unification stays owner-held Phase 2). Behavior identity
  proved by double-replay byte-diff over the v22 sweep's 352,290-row decision
  log: baseline (pre-restructure) and restructured replay outputs are
  byte-identical (SHA-256 F65621D8…AD17), so (decision, reason) is identical for
  every row. Golden gate `classifierGolden.test.ts` unchanged; new
  `classifierGates.phaseOrder.test.ts` mirrors the TJ filterSteps guard;
- ✅ curated drop lists moved to `packages/crawler/src/curated/` (PR #121,
  2026-07-10; sidecar export wiring + both workflow drift gates re-pathed,
  sidecars byte-identical);
- ⚪ OPEN — `.tmp_review/` audit artifacts: archive then delete (untracked,
  multi-GB over time; lives on the NAS prod tree, needs operator care);
- ✅ the agent-chunk prep/merge shared lib exists (done in `089e8c5`):
  `scripts/lib/agent-chunks.mjs` (transport shared; domain logic deliberately
  stays per-consumer).

### 2026-07-09 audit deferred findings

From the whole-repo audit (the three fixed bugs — legacy-DB delta derived-row
wipe, wanakana over-long-query 500, decision-log >512 MB string read — shipped
separately). The three items below were deferred pending an owner decision and
are now all ✅ **RESOLVED by PR #107 (2026-07-10)**:

- **idf drift in delta `affected` stat mode — accepted + documented.** A token's
  idf derives from the GLOBAL song count, so any delta that changes the corpus
  size (a net add or remove) staleifies every untouched token's idf (measured
  112/148 tokens diverge from a full rebuild; ranking effect limited to near-tie
  reordering). Per owner decision this is accepted and documented precisely on the
  `tokenStatMode` field docstring in `packages/data-store/src/delta-patch.ts`; a
  full import/release build always recomputes all stats and is the authoritative
  source of idf. The recompute-on-count-change option remains available
  (`tokenStatMode: 'all'` refreshes every token's stat) but is unplanned.
- **Tier B same-source merge collapse — deterministic tie-break shipped.** Each
  cluster's members are now sorted by the existing `compareMergedRecords` total
  order (tj asc nulls-last, then normalize(title), then id) at the single
  materialize point before `mergeCluster` in `packages/crawler/src/merge.ts`, so
  the equal-SOURCE_RANK survivor is input-order-independent. This does NOT change
  WHICH records collapse; the committed corpus is preserved byte-for-byte (it is
  already globally sorted by the comparator, so the within-cluster sort is a no-op
  there, and two shuffled inputs now converge to the same hash).
- **Delta hint for an UNTOUCHED song — stderr warning guard shipped.** The
  touched-only delta path still does not materialize a hint targeting a song the
  delta did not touch (a full import/release build does), and that limit is now
  documented as intended; `warnHintsForUntouchedSongs` in
  `packages/data-store/src/delta-patch.ts` emits one non-fatal stderr warning
  naming the untouched-target count, up to three sample ids, and the remediation.
  The rebuild-all migration path materializes every song and does not warn.

Low-severity bugs (all fixed 2026-07-10, test-first):

- fixed: hiragana iteration marks ゝ/ゞ are dropped in `kanaToRomaji`/`kanaToHangul`;
- fixed: web fallback banner can show on the Browse landing view;
- fixed: Favorites tab lacks a pending state during API hydration;
- fixed: worker rate-limit bucket map is never pruned (unbounded growth);
- fixed: worker `close()` does not close idle keep-alive sockets (defensive —
  on the repo's Node 24 runtime `server.close` already reaps idle sockets, so
  the fix is a verified no-op there; no discriminating test is possible);
- fixed: hint fields emit Hangul `initial` tokens, breaking server/offline parity
  (latent — reading fields are already excluded, hint fields are not).

Behavior-preserving refactor batch — ✅ **DONE (PR #100, 2026-07-10)** — all
eight shipped as behavior-preserving refactors (self-host SQLite dump and the
search probes verified byte-identical before/after):

- remove the dead compat-jamo branch in `apps/worker/src/index.ts` (NFKC folds
  compatibility jamo U+3131–U+314E to conjoining jamo, so the branch could never
  match; the now-unused `HANGUL_INITIALS_QUERY_PATTERN` constant went with it);
- dedup `hasNonAsciiCharacter` (hoisted into `@karaoke/search`; both local copies
  deleted);
- consolidate the three `stableStringify` implementations (into
  `scripts/lib/canonical-json.mjs`);
- dedup the ja-JP NFKC normalize helper (`normalizeForConflictMatch` delegates to
  the exported `normalizeForComparison`);
- pre-normalize the reviewed-override Set key;
- fold the data-store `ensure*` marker-guard helpers (into a single
  `ensureSearchTokensFields`);
- dedup the Hangul syllable/choseong constants (single definition in
  `packages/search/src/transliterate.ts`, imported by `index.ts`);
- unify the `SearchVendor`/`Vendor` union (`Vendor` now aliases `SearchVendor`).

Test coverage:

- ✅ **DONE (2026-07-10).** Added a contract test for the implicit `/api/meta`
  date-only ↔ Footer regex coupling (`apps/worker/test/meta-contract.test.ts`
  asserts the YYYY-MM-DD / '' shape; Footer.astro points back at it).

### Chinese-leak detection future work

The flat Chinese drop list + hardcoded catalog-anomaly IDs catch known leaks,
but TJ surfaces more non-Japanese rows over time. The right detector for
simplified-Chinese-only rows is a **simplified-Chinese character heuristic**
(characters that exist only in simplified script — a broad Han-without-kana
scan false-positives on ~2k kanji-titled Japanese songs and is the wrong
tool). Grow the catalog-anomaly ID list in `scripts/drop-artist-leaks.mjs` as
anomalies surface; revisit list structure if the Chinese list grows past ~20
entries (see PROJECT-KNOWLEDGE, drop lists).

**Detector shipped REPORT-ONLY (PR #120, 2026-07-10):**
`hasSimplifiedOnlyHan` in `@karaoke/search` (curated 76-char set, precision-
first — all shinjitai-shared glyphs excluded, per-char reviewed) +
`scripts/audit-simplified-chinese.mjs` (scans a corpus JSON, emits suspect
JSONL + summary; no exit-code gating). Calibration: 0 hits over the 26,133-row
baseline (17,257 Han-bearing rows scanned; a naive Han-without-kana scan would
flag 4,105) while still firing on the known anomaly. Deliberately NOT wired
into crawl.yml (kept clear of the first #97/#106 gate soak). Next steps
(owner-gated): run it against fresh crawls, and wire confirmed hits into the
drop list or the crawl report.

**Full-corpus calibration (2026-07-12): 0 suspects over the promoted v22
corpus (313,467 rows)** — the detector stays silent on the entire serving
catalog, so any future hit is a high-signal leak candidate.

**Crawl-report wiring ✅ DONE (PR #128, 2026-07-12):** the crawl PR body now
carries a "### Simplified-Chinese audit" section (rendered in the tested
compose layer, fail-soft — can never red the crawl; detector untouched).
First live rendering happens when the owner-held crawl runs again.

### TJ filter-seam + parity-baseline systemic follow-ups (2026-07-09 audit)

- **TJ filter seam — a Korean act can be admitted JPN by the per-artist step despite a
  per-song KOR signal.** `jpn-admit-artist` (FILTER_STEPS step 5) can verdict a Korean act JPN
  from the artist-scan vote tally seeded by its JP-market catalog entries, even when the
  per-song `proEnrichmentMap` already carries `nationalcode: KOR` for that exact row. Today only
  the deterministic drop list catches these (the 2026-07-09 LUCY / Roy Kim / BOYNEXTDOOR leak
  admitted 168 rows this way). Consider consulting the per-song KOR pro signal before/at the
  per-artist admit so genuinely-Korean rows self-reject without a hand-maintained drop-list
  entry. Filter order is load-bearing (`assertPhaseOrder` at module load), so this needs design —
  e.g. a new KOR-pro-reject step placed among steps 0–3, NOT a reorder of the admit steps.
  **HELD (2026-07-10, owner): do not start without an explicit owner go**, and in any case not
  before the #97 crawl gate has soaked at least one weekly crawl.
- **Search-parity baseline regeneration policy** — ✅ **DONE (PR #106, 2026-07-10).**
  The weekly crawl changes corpus identity by design, and
  `apps/web/src/lib/search-parity.golden.test.ts` pins a sha256 + record count, so every
  crawl PR used to leave the apps/web tests red until someone hand-regenerated the baseline
  (and `-r test` masked it — pnpm bailed at the earlier crawler package; this bit #95).
  `crawl.yml` now regenerates the baseline in the crawl workflow AFTER the crawler-test
  leakage gate (never regenerate a baseline for a corpus that fails leakage), via
  `UPDATE_PARITY_SNAPSHOT=1` (the relevance-smoke assertions still run and can red the run
  before any PR opens), then `scripts/compare-parity-baselines.mjs` renders the per-query
  jaccard/top-1 delta into the crawl PR body for human sign-off and the regenerated baseline
  ships in the PR. This keeps the drift-gate meaningful (auto-regen alone would rubber-stamp
  drift; the delta report preserves the human review) without guaranteeing weekly red.
- **Smoke-fixture ids are positional and go stale on every crawl.** — ✅ **DONE (2026-07-10).**
  The parity relevance-smoke fixture (`apps/web/src/lib/fixtures/search-parity-smoke.json`)
  previously pinned expected results by `blog-*` record id, which reshuffle whenever a crawl
  re-touches those blog pages — #95 displaced 6 of them (re-pinned by hand on 2026-07-09 after
  verifying identity via stable karaoke numbers). The harness now pins by stable karaoke-number
  keys (`expectNumbers` {tj/ky/joysound} + an `expectTitle`/`expectArtist` cross-check), resolved
  to the current record id at test setup, so it no longer needs a manual re-pin every crawl.
- **PRODUCT: `blog-*` record ids are positional and reshuffle each crawl.** #95
  re-assigned the Utada page ids wholesale (e.g. `blog-301-13` was 光, is now a different
  song). Device favorites (localStorage `karaoke-favorites:v1`) and `/api/songs` lookups
  key by record id, so a user's saved favorites silently re-target DIFFERENT songs after
  such a crawl. Needs a stable record-identity design for blog rows (e.g. derive the id
  from a stable key such as a karaoke number or content hash) — owner decision.
  **HELD (2026-07-10, owner): no action planned for now.** The recommended
  narrow fix on file (favorites store a stable key — vendor numbers — and
  resolve to ids at load, one-time v1 migration) stays available for when this
  is picked up.

### JOYSOUND classifier safe-predicate unification — Phase 2 (deferred)

The JOYSOUND classifier
(`packages/crawler/src/adapters/joysound-official/classifier.ts`) historically
carried its own script-detection regexes that drifted from the shared
`@karaoke/search` predicates. T5-D unified this in two phases, gated by a golden
regression harness
(`packages/crawler/test/adapters/joysound-official/classifierGolden.test.ts`).

**Phase 1 (DONE, T5-D):** the three *safe* predicates were swapped to the shared
`@karaoke/search` functions —
- `RE_ASCII_LETTER` → `hasLatinLetter` (byte-identical, zero behaviour change);
- `hasKanaScript` (admit path) → `hasKana`;
- `RE_KANA` (foreign-name echo path) → `hasKana`.

The only behavioural effect is a strict *widening* of kana recognition, verified
by the golden gate's Part B1 (change spec) and the always-on Part C differential:
Katakana Phonetic Extensions (U+31F0–31FF) now admit as `admit-jpop-kana`, and a
Han foreign-name whose only kana is half-width (U+FF66–FF9F) or phonetic-ext is
now recognised as a Japanese-title echo (suppressing `foreign-chinese`). Both
are DROP→ADMIT flips, so genuine-JP dropout is structurally impossible. A full
`songs.json` differential (98,772 distinct strings, current corpus) showed **0
flips** in either direction for all three predicates — the widening is latent
for today's catalog and only affects future rows carrying those code points.

**Phase 2 (deferred — HELD 2026-07-10, owner: do not start without an explicit
owner go; technical precondition unchanged — proceed only after the golden gate
has soaked one crawl cycle):** unify the remaining three predicates, which sit
on ADMIT/DROP-critical paths whose real JOYSOUND foreign-name distribution is
not yet validated:
- `RE_HANGUL` → `hasHangul` (`\p{Script=Hangul}`): adds half-width Hangul and
  Jamo Extended-A/B → widens the `foreign-korean` DROP directly;
- `RE_HAN_FOREIGN` → `hasHan` (`\p{Script=Han}`): adds supplementary-plane Han →
  changes the `foreign-chinese` DROP directly;
- `RE_HAN` (drop-reason split) → `hasHan`: adds CJK-compat / supplementary-plane
  Han and drops the Yijing-hexagram block → shifts `drop-han-only` vs
  `drop-no-signal`.

Phase 2 is unblocked by: a fresh crawl cycle confirming the Phase-1 gate holds in
production, plus a real JOYSOUND foreign-name-field distribution sample for the
Hangul/Han code points above. The Phase-2 divergence points are already pinned at
their current behaviour in the golden gate's Part B2 — flipping those assertions
is the Phase-2 change spec.

### Offsite full-corpus backup — DIRECTION DECIDED: PRIVATE (owner, 2026-07-12); execution deferred

**Owner decision (2026-07-12): back up PRIVATELY, not as a public GitHub
Release.** The public-release path (the built `full-corpus.yml` publish
workflow) is therefore NOT the mechanism; a private storage target is. What
remains is EXECUTION (deferred, no date): pick the concrete private store and
wire an upload. Candidate targets (pick at execution time): a **private GitHub
repo release/asset** (reuses the existing manifest+verify tooling almost
as-is — `publish-full-corpus.mjs`/`fetch-full-corpus.mjs` are store-agnostic
via the manifest `url`), **Cloudflare R2 / S3** (a bucket + credential; the
manifest `url` becomes the object URL), or an **encrypted copy on a second
box**. Recommended: private-repo release or R2 — both let the store-agnostic
manifest do a one-line `url` swap and keep the trust-no-one re-verification.

Current artifact to back up: `data-2026-07-12-v22-fullcatalog/full-corpus.json`
(~135 MB) — the promoted v22 corpus. Since v22 promotion the NAS again holds
the ONLY copy.

**Severity note (still true 2026-07-12):** ZERO GitHub releases exist; both
tracked manifests point at 404 assets (dangling), so `fetch-full-corpus.mjs` /
the self-host SQLite build cannot reprovision from anywhere but the NAS. The
private backup, once executed, is the first real offsite copy. The public
publish workflow (`full-corpus.yml`) stays UNUSED under the private decision.

### Watchdog alert channel (CLOSED 2026-07-10, owner: no dedicated channel)

**Owner decision (2026-07-10): CLOSED — no dedicated alert channel will be
wired.** Rationale: the R6 liveness workflow (PR #117) now covers the
human-notification need from the OUTSIDE — a failed scheduled probe of the
public site (healthz/meta/search through the Pages-Functions → Funnel →
origin chain) triggers GitHub's default failure e-mail to the owner. The
remaining gap (immediate notice of host-internal restart loops that
self-heal fast enough to never fail an external probe) is accepted.

Standing facts: `karaoke-healthz.timer` (1-min healthz watchdog with
auto-restart and a 10-min restart-loop guard) stays live on the host and
logs to the journal (tag `karaoke-healthz`); a sustained restart loop DOES
surface externally via the liveness workflow. If this is ever reopened, the
hook point is the `logger` calls in `/srv/nas/karaoke/healthz-watchdog.sh`.
