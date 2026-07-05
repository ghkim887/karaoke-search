# Roadmap

Owner-prioritized future work items, with the investigation data that scoped
them. Companion to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) (undecided items) and
[ARCHITECTURE.md](ARCHITECTURE.md). Items were added 2026-07-04 from an owner
review; numbers below were measured against the live serving DB
(`db/current/songs.sqlite`, release v20, 307,961 songs).

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
review (#76/#84–#88) → `reviewedMergePairs` Tier E = 191 / Tier F = 161
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

### R1 follow-up — merger-mechanism extension (open, 2026-07-05)

The R1 audit was fully reviewed across all three tiers (A/B/C) over PRs
#76/#84–#88; ~120 reviewed pairs are now in `reviewedMergePairs.ts`
(Tier E = 191, Tier F = 161, applied at the next crawl). **~10 confirmed
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

**Work item (not yet built — documented for a later session):** extend the
merger so these are expressible, e.g. (a) a reviewed rule that lets an affected
record absorb a JOYSOUND number from a candidate that carries its own
conflicting TJ (dropping/relocating the candidate's TJ deliberately), and
(b) a multi-number reviewed-pair shape (or generalized `ALLOWED_JOY_SIDE_EXTRA_PROVIDERS`)
that attaches a both-vendor (tj+ky) affected record to one JOYSOUND number.
Keep it exact-pair-reviewed (no broad artist rule). Also holds ~7 owner-decision
version-ambiguous pairs (STILL EN/JP, BLACK DIAMOND major/indies, ねねね
presentation variants, "Various Artists" placeholders).

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

**Owner question:** the whole DB is ~1 GB — why not ship it wholesale to the
PWA/offline fallback?

**Answer (measured):** the 1.1 GiB serving SQLite is the WRONG artifact to
ship — 77 % of it is the server-side inverted index (`search_tokens` 845 MB +
`search_token_stats` 67 MB), which only makes sense next to the worker's
query planner. The actual payload is small: `songs` 45 MB +
`karaoke_numbers` 26 MB + `search_texts` 52 MB (~130 MB uncompressed;
canonical `full-corpus.json` is 93 MB, ~25–30 MB gzipped). The current
offline path ships a 25,842-song / 10.9 MB subset and builds a MiniSearch
index client-side; OPEN-QUESTIONS §1 already measured client-side index
build for a 221k corpus at ~316 MB heap / ~5.7 s on desktop Node — worse on
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

- **KY (Korean, kumyoung):** source survey (kysing.kr search endpoints /
  monthly new-song listings), robots + terms review, then a
  `packages/crawler/src/adapters/` adapter following the
  joysound-official/tj-media-direct patterns (decision-log JSONL, resumable,
  classifier goldens).
- **DAM (Japanese, Daiichi Kosho):** NEW provider — requires widening the
  `karaoke_numbers` provider CHECK (`'tj','ky','joysound'`) in
  `packages/data-store/src/schema.ts`, the `@karaoke/schema` types, worker
  responses, and web provider badges. Source survey: denmoku/clubdam public
  search surfaces; expect JOYSOUND-scale catalog (~300k+).
- **Sequencing:** land R1 (merge audit) and R4-item-4 (artistId merge keys)
  first — every new provider multiplies duplicate-cluster pressure, and DAM
  at JOYSOUND scale would mint hundreds of thousands of merge decisions
  through whatever matcher exists at that point.
