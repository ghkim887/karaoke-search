# Roadmap

Updated 2026-09-17 against code at `4e37fa1`, GitHub workflow state, and the
running v25 release. [The README](../README.md#current-state) contains
measurements; [project knowledge](PROJECT-KNOWLEDGE.md) records the relevant
implementation rationale and past failures.

## Current baseline

- v25 serves 312,571 songs; vendor coverage is TJ 6,111 / KY 4,787 /
  JOYSOUND 312,147 (overlapping counts).
- Reviewed merge tables have 838 units: E 271, F 482, three-way attachment 85.
  The v25 report records 834 applied units and four conflict skips.
- The remaining 424 JOYSOUND-less audit records are accounted for:
  244 genuine coverage gaps, 173 rejected merges, four genuine number conflicts,
  and three uncertain/no-action cases. There is no unclassified decision queue.
- The offline subset is complete for its chosen scope: TJ OR KY OR `blog-*`,
  26,398 records. Full-corpus offline SQLite/OPFS work is retired.
- KY crawling and v23–v25 integration are implemented. The July 10 survey's
  per-number enumeration proposal was superseded by the Japanese index walk.

## Open questions

### Crawl resumption and freshness

The regular crawl is on indefinite hold. GitHub reports `disabled_manually`,
which prevents scheduled and manual-dispatch runs despite the YAML definition.
The timing of resumption remains undecided; this documentation update does not
change that workflow state. `dbUpdatedAt` remains `2026-07-16` because later
releases recomposed existing inputs rather than fetching new source data.

The next resumed crawl is the integration point for changes that have been
tested in code or applied to frozen data but have not completed that entire
fresh-crawl path together:

- Stable blog IDs and numberless-row removal, including ID-keyed cache/hint
  alignment and the effect on existing device favorites.
- TJ reverse-number seed probing and per-song overrides.
- KY index traversal, truncated-title recovery, tie-up normalization, and
  blog/KY parity reporting.
- The final reviewed merge/three-way tables and leak filtering protections.
- New bundle extraction and a reviewed search-parity baseline update.

The default workflow covers blog/TJ/KY. JOYSOUND listing/detail refresh is a
separate lane; running the default workflow does not refresh all 312k songs.

### DAM catalog investigation

DAM is not implemented. A source survey is the remaining discovery task.
Adding it would affect the SongRecord vendor schema, SQLite provider CHECK,
search provider masks, API filtering, and web badges. Its duplicate/version
matching implications need evaluation alongside source coverage.

### Search enrichment

- **Implemented:** JOYSOUND `title_ruby` persistence and deterministic
  kana/romaji/Hangul reading recall, both server-side and on the ruby-bearing
  offline subset.
- **Deferred:** tie-up names as searchable media context.
- **Open:** lyricist/composer search.
- **Partial:** JOYSOUND artist IDs are used as audit signals. Automatic merge
  keys based on `artistId`/`naviGroupId` remain deferred: one act may have several
  IDs, so ID mismatch alone was an unreliable rejection signal.

### Data-quality residuals

- Korean-title review has no broad unreviewed backlog from the July pass.
  Its 388 medium/low entries had no confirmed canonical Korean title; future
  newly collected songs can still need translation/review.
- Twenty-four interior-whitespace title cases remain deferred because broader
  normalization can merge different songs. Three historical `tjpdf` title
  contamination cases are recorded in the #167 follow-up notes.
- Chinese-leak detection is maintenance work: the shared simplified-Han
  predicate cannot detect every traditional-script or Latin-titled case.
- Distinct valid numbers and ambiguous cuts stay separate where the current
  one-number-per-vendor model cannot safely combine them.

## Completed work relevant to future changes

| Work | Result |
| --- | --- |
| R1 merge audit, July 16–20 follow-up | Reviewed cluster attachment and 85 three-way links; remaining rows classified |
| R2 interface languages | Korean, English, Japanese UI |
| R3 offline scope | v25 TJ/KY/blog subset and reproducible extraction, #171 |
| R4 ruby search | Reading persistence and indexed transliterations |
| R5 KY | Official Japanese index adapter, title recovery, serving integration |
| R6 liveness | Public proxy-chain probes |
| R7 TJ supplemental catalog | Exact-number probe catalog replaces PDF ingest |
| Search hints/schema cleanup | Search-only hint tokens retained; dead table/column removed |
| Full-corpus distribution | NAS serving; unused Release-asset tooling retired July 13 |

The archived specs record why these implementations were chosen. Their old
estimates and source investigations are dated evidence, not current service
measurements.
