# R3 full-offline-pack feasibility spike — 2026-07-12

> **SPIKE — no production code.** Every artifact below was built by throwaway
> scripts in a scratchpad, never in the repo, and measured once. The repo change
> for this spike is **this one markdown file**. Nothing here is wired into the
> app, the worker, or the build. Numbers are single-run measurements on one
> Windows 11 desktop (Node v24.16.0, `node:sqlite` / SQLite 3.53.0); treat them
> as envelopes, not benchmarks.

## Purpose

ROADMAP §R3 decided the direction for full-corpus offline: an **opt-in "full
offline pack"** — a client-optimized SQLite (songs + karaoke numbers + an index
built *for* sqlite-wasm, **no** server token tables) in OPFS — with an
HTTP-range-over-static-DB variant to prototype first. This spike measures the
feasibility envelopes only; it does **not** attempt search parity with the
worker. Source corpus: `data-2026-07-12-v22-fullcatalog/full-corpus.json`
(135,179,032 B, **313,467 songs**), fetched once to the scratchpad.

Corpus field coverage (drives what the pack must carry), measured over all
313,467 rows:

| field | rows | coverage |
|---|---:|---:|
| `title_ruby` (katakana reading) | 287,333 | 91.7 % |
| `artist_ko` | 67,946 | 21.7 % |
| `title_ko` | 18,232 | 5.8 % |
| `artist_aliases` (songs w/ ≥1) | 4,535 | 1.4 % |
| `media_context_ko` | 1,202 | 0.4 % |
| karaoke number — joysound | 312,170 | 99.6 % |
| karaoke number — tj | 6,122 | 2.0 % |
| karaoke number — ky | 1,254 | 0.4 % |

## TL;DR (headline numbers)

- **A client-optimized DB is much smaller than the §R3 "150–300 MB" estimate —
  because it drops the 77 % server inverted index.** Raw file, page_size 4096,
  VACUUMed: **55.4 MiB** songs+numbers only; **75.1 MiB** with an FTS5
  `unicode61` index; **99.8 MiB** with an FTS5 `trigram` index. Server build
  time ≈ **4–5 s**. Compressed download (brotli-10): **21.6 MiB / 34.8 MiB**
  for the unicode61 / trigram packs.
- **BUT that FTS-only index is not search-parity-complete** — see the parity
  probe below. It omits the worker's 1–2-char-CJK / choseong / romaji-of-ruby
  structures, so **75–105 MiB is a floor**, not the shippable-with-parity size.
- **Whole-DB-local query latency is trivial**: warm 30–165 µs; cold (fresh
  process, OS-cache-cold) 2–9 ms. This is the OPFS-full-pack query cost.
- **HTTP-range transport works and is cheap for point queries**: static Range
  hosting confirmed (206 / `Accept-Ranges`), and a point lookup transfers
  **~9 KiB at page_size 1024** (9 page reads) rising to ~96 KiB at 16384 — the
  classic small-page/more-requests trade-off. FTS-heavy queries cost more.
- **The iOS risk is eviction, not size or quota.** WebKit's 7-day-no-interaction
  ITP sweep can wipe a best-effort OPFS pack; `persist()` is granted only
  heuristically (mainly for an installed Home-Screen PWA). This is the one thing
  that **cannot** be settled without a real iOS device.

**Verdict:** OPFS full pack = **GO on the measured envelope, NEEDS-DEVICE-TEST
for iOS durability.** HTTP-range hybrid = **GO as an online-only complement,
NEEDS-FOLLOW-UP for real-browser byte counts.** Details in §Q4.

---

## Method / reproducibility

All prototype code + data live in the scratchpad
(`…/scratchpad/r3-spike/`), never in the repo. Build/parse used
`node --max-old-space-size=6144`. Client DBs were built with `node:sqlite`
(`DatabaseSync`), `PRAGMA journal_mode=off; synchronous=off; temp_store=memory`,
a single insert transaction, three secondary indexes, an FTS5 external-content
(`content='songs'`) virtual table rebuilt with
`INSERT INTO fts(fts) VALUES('rebuild')`, then `VACUUM`.

The client `songs` table carries only display fields
(`id, title_primary, title_ko, artist_primary, artist_ko, media_context_ko,
title_ruby`) plus a `karaoke_numbers(sid, provider, number)` child table — i.e.
the projection the serving `songs`/`karaoke_numbers` tables expose, minus the
`search_texts` / `search_tokens` / `search_token_stats` server index tables.

Environment: Windows 11, Node v24.16.0, bundled SQLite **3.53.0** with **FTS5
compiled in** (verified) and the `trigram` tokenizer available; `dbstat` and
`node:zlib` brotli both available.

---

## Q1 — Client-optimized DB size

Built from the full v22 corpus. `raw` = VACUUMed file on disk; `gz` = gzip -9;
`br` = brotli quality 10 (a CDN would precompute brotli 11 → a few % smaller).

| variant (page_size 4096) | contents | raw | gzip-9 | brotli-10 |
|---|---|---:|---:|---:|
| `baseline` | songs + karaoke_numbers + 3 indexes, **no FTS** | 55.4 MiB (58,101,760 B) | 21.9 MiB | 14.6 MiB |
| `fts-unicode61` | + FTS5 `unicode61` over title/artist/ko/ruby/media | 75.1 MiB (78,712,832 B) | 30.5 MiB | 21.6 MiB |
| `fts-trigram` | + FTS5 `trigram` variant | 99.8 MiB (104,620,032 B) | 44.3 MiB | 34.8 MiB |

- The FTS5 `unicode61` index adds **~19.7 MiB** raw over baseline; the `trigram`
  index adds **~44.4 MiB** (trigram stores 3 postings per 3-gram, so it is ~2.2×
  the unicode61 index cost — the price of substring capability).
- **Build time** (parse + insert 313 k rows + FTS rebuild + VACUUM) measured at
  **~3.7–5.3 s** per variant (corpus parse alone ≈ 0.6–0.8 s). This is a
  server-side offline build, so build time is a non-issue.
- Context: the §R3 estimate of 150–300 MB is an over-estimate for an FTS-only
  index; **but** it is a fair *ceiling* once a parity-complete hybrid index (see
  §Q2 parity) is added. Report the 55/75/100 MiB figures as the **floor**.

**Page-size effect on file size** (fts-unicode61, raw): larger pages pack
slightly tighter (less B-tree/​header overhead):

| page_size | raw file |
|---:|---:|
| 1024 | 77.8 MiB (81,574,912 B) |
| 2048 | 75.7 MiB (79,388,672 B) |
| 4096 | 75.1 MiB (78,712,832 B) |
| 16384 | 74.6 MiB (78,184,448 B) |

---

## Q2 — HTTP-range access (statically hosted DB + sqlite-wasm)

### Transport half — empirically confirmed

A ~40-line Node static server with `Range` support (`range-server.mjs`) serving
the page_size-1024 DB answered `curl -r 0-99` with:

```
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-99/81574912
Accept-Ranges: bytes
```

Fetching `bytes=0-1023` returned exactly 1024 bytes beginning with the
`SQLite format 3\0` magic — i.e. a range client can read individual SQLite pages
off a statically hosted file. This is what `sql.js-httpvfs` / an OPFS-less
sqlite-wasm range VFS needs from the host; any CDN that supports `Range` (GitHub
Pages, R2, CloudFront, …) satisfies it.

### Bytes-transferred-per-query — model (dbstat-grounded) + tuning

Driving the *whole* sqlite-wasm range VFS from a real browser network panel was
**not** done in this spike (browser-only VFS; heavy on this Windows box) — marked
**NEEDS-FOLLOW-UP**. Instead the per-query transfer for **point queries** is
computed from the real B-tree structure via `dbstat` (`analyze-pages.mjs`):
`bytes ≈ distinct_pages_touched × page_size`, where a point lookup touches
`header page (1) + index root→leaf (tree height) + row-by-rowid in songs (tree
height)`.

| page_size | pages/point-query | bytes/point-query | index heights (idx / songs) |
|---:|---:|---:|---|
| 1024 | ~9 | **9.0 KiB** | 4 / 4 |
| 2048 | ~7 | 14.0 KiB | 3 / 3 |
| 4096 | ~7 | 28.0 KiB | 3 / 3 |
| 16384 | ~6 | 96.0 KiB | 2 / 3 |

This is the **page-size tuning trade-off** in numbers: **page_size 1024 minimises
bytes/query (9 KiB) at the cost of more round-trips (~9)**; 16384 needs fewer
reads (~6) but 96 KiB. `sql.js-httpvfs` recommends exactly this — set
`requestChunkSize` = page_size and prefer small pages (its README suggests
`pragma page_size=1024`). Measured warm/cold *local* latency (below) is the
lower bound; range latency adds one RTT per non-cached page read.

**FTS queries are the expensive case for range access.** The FTS5 index blob
(`fts_data`) is 3,856 pages (≈15 MiB) at page_size 4096; a term probe reads the
small `fts_idx` (22 pages) then the term's doclist segment pages in `fts_data`.
Published `sql.js-httpvfs` numbers put full-text search over an 8 MB table at
≈70 KiB transferred and a complex query at 130–270 KiB across 10–20 GETs — a
reasonable expectation here too, i.e. **an order of magnitude more than a point
query**. Exact bytes for *this* index need the browser measurement
(NEEDS-FOLLOW-UP).

### Local query latency (also the OPFS-full-pack query cost)

`node:sqlite`, whole DB local, `fts-unicode61` DB:

| query | warm (200-iter avg) | cold (fresh process, incl. open) |
|---|---:|---:|
| title exact (FTS `title_primary:"…"`) | 165 µs | 1.1–9.1 ms |
| artist prefix (FTS `artist_primary:BoA*`) | 69 µs | 0.9–2.0 ms |
| number lookup (indexed join) | 38 µs | 0.5–3.3 ms |
| id point lookup | 30 µs | — |

Cold numbers include DB open + first-touch OS-cache miss; the high end is the
very first query after process start. All sub-10 ms.

### FTS parity probe — why FTS5 is not a drop-in (empirical)

The worker's search does 1–2-char CJK / choseong / romaji-prefix expansion.
Probing the katakana title `ドキドキ`:

| query (interior substring) | `unicode61` matches | `trigram` matches |
|---|---:|---:|
| `キドキ` (3 chars) | **0** | 146 |
| `キド` (2 chars) | **0** | **0** |
| `キ` (1 char) | 35 (only standalone-token hits elsewhere) | **0** |

`unicode61` treats an unbroken CJK/kana run as **one token** → no interior
substring at all. `trigram` gives interior substring but only for **≥3-char**
queries; 2-char and 1-char interior queries return nothing. This directly
reproduces §R3's warning: **neither FTS5 tokenizer covers 1–2-char CJK, and
trigram's floor is 3 chars** — so an FTS-only pack would regress short and
phonetic search. Only a **hybrid** (FTS/trigram for bulk terms **plus** a
supplementary short-CJK / choseong / romaji-of-ruby structure) could reach
parity, and it must pass the existing golden parity gate.

---

## Q3 — OPFS full-pack path (write throughput + iOS eviction)

Sourced from primary docs (WebKit blog, WHATWG Storage Standard, sqlite.org/wasm,
`sql.js-httpvfs`); what needs a real iOS device is called out.

**VFS choice (sqlite.org/wasm `persistence.md`):**

| | `opfs` VFS | `opfs-sahpool` VFS |
|---|---|---|
| Min Safari | 17+ | **16.4+** |
| COOP/COEP + SharedArrayBuffer | **required** | **not required** |
| Concurrency | multi-connection | single-connection |
| Thread | Worker-only (sync access handle) | Worker-only |

→ For iOS reach + static hosting, **`opfs-sahpool`** is the right target (no
COOP/COEP headers, Safari 16.4+); trade-off is single-connection.

**Write throughput (DOCUMENTED):** the `createSyncAccessHandle` path is
Worker-only and materially faster than the async path — reported ~1 ms/write and
~2× faster bulk writes than the general OPFS API (RxDB benchmark; Chrome/WebKit
blogs). No MB/s figure for writing a 150–300 MB SQLite file, **and none for iOS
specifically** → **NEEDS-DEVICE-TEST**. (One-time write of a ~75–105 MiB pack is
plausibly a few seconds on desktop; iOS unknown.)

**iOS eviction risk (the real one):**
- WebKit evicts origin storage under quota pressure, storage pressure, **or
  ~7 days of no user interaction** (ITP script-writable-storage sweep) — this
  applies to best-effort OPFS. **Exempt: web apps added to the Home Screen.**
  (webkit.org/blog/10218, /14403; MDN Storage quotas & eviction.)
- `navigator.storage.persist()` exists and is honored on WebKit but granted
  **heuristically, with no prompt** (Safari 17+ removed the usage prompt) —
  chiefly for installed Home-Screen web apps. (webkit.org/blog/14403; WHATWG
  Storage Standard.)
- Per-origin quota ≈ 60 % of disk on Safari 17+; **at 75–105 MiB quota is a
  non-issue** — eviction is the risk, not size.

**Cannot be validated without a real iOS device:** whether a persisted, installed
PWA's OPFS pack actually survives the 7-day sweep; real iOS write throughput for
a 100 MiB file; and whether `opfs-sahpool` behaves on the target iOS build.

---

## Q4 — Verdicts + open design questions

### OPFS full pack — **GO (envelope) / NEEDS-DEVICE-TEST (iOS durability)**

Measured envelope: **75.1 MiB (unicode61) / 99.8 MiB (trigram)** raw pack
(compressed download **21.6 MiB / 34.8 MiB**), **~5 s** server build,
**sub-ms warm** / single-digit-ms cold queries once resident. Size and query
cost are comfortably feasible and well under the §R3 300 MB ceiling **for an
FTS-only index**. Blocking unknowns are all iOS-device-only: OPFS eviction
durability under `persist()`, and large-file write throughput. Recommend a
device test (installed PWA + `persist()` + `persisted()===true`, leave unused
7+ days, confirm survival) before committing to the pack as the primary path.

### HTTP-range hybrid — **GO (online-only complement) / NEEDS-FOLLOW-UP (browser bytes)**

Transport is proven and cheap for point queries (**9–28 KiB** at page_size
1024–4096). It sidesteps OPFS eviction and quota entirely (read-only, nothing
stored). Costs: one RTT per uncached page, FTS queries an order of magnitude
heavier than point queries, dependence on a lightly maintained library
(`sql.js-httpvfs`) or a hand-rolled range VFS, and host `Range` support. It
**complements** rather than replaces the pack (online-only). Follow-up: a real
headless-browser run measuring bytes/query off the network panel, and an iOS
Safari smoke test.

### Open design questions for a real implementation

1. **Index parity gate.** The FTS-only (75 MiB) and trigram (100 MiB) indexes
   both **fail** 1–2-char CJK / choseong / romaji-prefix (measured above). A
   shippable pack needs a **hybrid** index that additionally materializes the
   worker's short-CJK gram / choseong-initial / romaji-of-ruby postings, sized
   between the 75 MiB floor and the §R3 300 MiB ceiling, and it **must pass the
   existing golden search-parity harness** before it can back offline search.
2. **Update / versioning for weekly corpus changes.** The corpus regenerates
   weekly; a re-download of the whole compressed pack (21.6 MiB) each week is
   wasteful. Design needs a version manifest + a delta strategy (the pipeline
   already has a SQLite delta patcher; whether OPFS + sqlite-wasm can apply page
   deltas in place, or whether ranged re-fetch of changed pages is simpler, is
   open).
3. **Storage-quota / eviction UX.** On opt-in: request `navigator.storage
   .persist()`, surface `navigator.storage.estimate()`, require (or strongly
   nudge) Home-Screen install on iOS for durability, and handle silent eviction
   gracefully (detect missing pack, offer re-download, fall back to the default
   subset + API).

---

## Appendix — reproducible commands

From `…/scratchpad/r3-spike/` (prototype dir; not in the repo):

```
# fetch corpus once (135 MB)
scp ubuntu@oci:/srv/nas/karaoke/db/releases/data-2026-07-12-v22-fullcatalog/full-corpus.json .

node stats.mjs                 # record count + field coverage
node build-all.mjs             # baseline / fts-unicode61 / fts-trigram @4k + sizes + gzip/brotli
node build-sweep.mjs           # fts-unicode61 @ page_size 1024/2048/16384
node compress.mjs              # gzip-9 + brotli-10 of the three 4k DBs
node query.mjs                 # warm latency + FTS parity probe
node cold-query.mjs number|title|artist   # cold single-query (fresh process)
node analyze-pages.mjs         # dbstat page counts/heights + point-query range model
node range-server.mjs ftsU-1024.sqlite 8791 &   # static Range host; curl -r 0-1023 to verify 206
```

Serving-DB schema reference (`songs.sqlite`, v22): `songs` (display fields +
`title_ruby`), `karaoke_numbers`, `artist_aliases`, `search_texts`,
`search_tokens` (845 MB inverted index — **excluded from the pack**),
`search_token_stats`.
