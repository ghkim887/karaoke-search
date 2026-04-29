# TJ Media — Full API Surface Map

**Date:** 2026-04-29
**Purpose:** Replace the planned NamuWiki adapter (Phase 3) with TJ-native data sources.
**Method:** Sitemap walk + Playwright MCP XHR capture + blind endpoint probing on `www.tjmedia.com`.

---

## TL;DR

TJ Media exposes a small but rich JSON API at `/legacy/api/*` (POST, form-urlencoded) that we have only partially used. Three working endpoints were confirmed:

1. **`/legacy/api/newSongOfMonth`** — bulk catalog (67,324 records); already used by `tj-media-direct` adapter. **Lacks `nationalcode`.**
2. **`/legacy/api/topAndHot100`** — chart endpoint with **per-genre** filter; returns `nationalcode` per item.
3. **`/legacy/api/searchSong`** — search endpoint that **returns `nationalcode`, `sortTitleKo`, `sortSongKo`** per result. **Newly discovered.** Capped at ~40 results per call.

The combination of `topAndHot100` (genre-filterable, with `nationalcode`) + `searchSong` (per-record enrichment with Korean transliterations + `nationalcode`) is a **viable NamuWiki replacement** for nationality tagging and Korean readings — without the namu scrape risk.

Anime/vocaloid sub-categorization still requires the existing TJ anisong PDF; TJ's API only categorizes at nationality level (`KOR`/`ENG`/`JPN`).

---

## Confirmed JSON Endpoints

All endpoints: `POST` to `https://www.tjmedia.com/legacy/api/<name>` with `Content-Type: application/x-www-form-urlencoded`. All return `{ resultCode, resultMsg, resultData, GNB_MENU }` envelope. `resultCode === "99"` = success; `"98"` = empty/no-data; `"20"` = missing required param.

### 1. `/legacy/api/newSongOfMonth`

**Existing usage:** `tj-media-direct` crawler adapter (`packages/crawler/src/adapters/tj-media-direct/`) calls this with `searchYm=200001`.

**Required params:**
| Param | Type | Notes |
|---|---|---|
| `searchYm` | `YYYYMM` (no hyphen) | `200001` = "from 2000-01 onward" = full 67,324-record catalog (~17 MB JSON). `202404` = "from 2024-04 onward" = 8,090 records. Future months (`202612`) = empty. Empty/malformed = error. |

**Response shape:**
```json
{
  "resultCode": "99",
  "resultMsg": "성공",
  "resultData": {
    "itemsTotalCount": 67324,
    "items": [
      {
        "rownumber": 1,
        "thumbnailImg": "https://www.tjmedia.com/SONG_ALBUMIMG/SONG_MATCH/074031_thumb.jpg",
        "pro": 74031,
        "indexTitle": "On & On",
        "indexSong": "Cartoon(Feat.Daniel Levi)",
        "word": "JAERVESAAR JOOSEP,...",
        "com": "JAERVESAAR JOOSEP,...",
        "icongubun": "",
        "mv_yn": "N",
        "publishdate": "2026-04-29"
      }
    ]
  },
  "GNB_MENU": [/* navigation tree, ignorable */]
}
```

**Field meanings:**
- `pro` — TJ song number (PK, 5–6 digits)
- `indexTitle` — title in original script
- `indexSong` — artist name in original script
- `word` — lyricist
- `com` — composer
- `icongubun` — `""` (none) / `MR` / `LV` (live) / `60` (60-series-only) / `MEDLEY`
- `mv_yn` — `Y`/`N` music video available
- `publishdate` — TJ catalog publish date

**Critical gap:** **No `nationalcode` field on bulk catalog.** This is why the existing adapter falls back to a loose-JP regex + Chinese-artist denylist + rescue-from-blog logic to identify Japanese songs.

### 2. `/legacy/api/topAndHot100`

**Triggered by:** `/chart/top100` page (XHR on filter change).

**Required params:**
| Param | Type | Notes |
|---|---|---|
| `chartType` | `TOP` or `HOT` | `TOP` = top 100 popular; `HOT` = top 100 hot (recent) |
| `searchStartDate` | `YYYY-MM-DD` | Client-side enforced 2-year max window |
| `searchEndDate` | `YYYY-MM-DD` | |
| `strType` | `0`–`11` | Genre code (see below); empty string = `0` |

**Genre code map (verified by per-code probe):**

| `strType` | UI label | #1 song @ 2026-04-01..29 |
|---|---|---|
| `0` | 전체 (overall) | TICK TOCK — 김하온 et al. (HOT) / Drowning — WOODZ (TOP) |
| `1` | 가요 (K-pop) | Drowning — WOODZ |
| `2` | POP | Let It Go — Idina Menzel |
| `3` | **JPOP** | **Pretender — Official髭男dism** |
| `4` | 발라드 (Ballad) | 내머리가나빠서 — SS501 |
| `5` | 댄스 (Dance) | 애상 — 쿨 |
| `6` | 트로트 (Trot) | 사랑은늘도망가 — 임영웅 |
| `7` | 포크 (Folk) | 봄봄봄 — 로이킴 |
| `8` | OST | 내머리가나빠서 — SS501 |
| `9` | 락/메탈 | Drowning — WOODZ |
| `10` | 랩/힙합 | 죽일놈 — 다이나믹듀오 |
| `11` | R&B/어반 | 시작의아이 — 마크툽 |

`strType ≥ 12` returns no data. Both `chartType=TOP` and `chartType=HOT` work; they return different orderings.

**Response item fields:**
```json
{
  "rank": "1",
  "pro": 68058,
  "indexTitle": "Pretender",
  "indexSong": "Official髭男dism",
  "word": "藤原聡",
  "com": "藤原聡",
  "icongubun": "",
  "mv_yn": "N",
  "imgthumb_path": "https://www.tjmedia.com/SONG_ALBUMIMG/SONG_MATCH/068058_thumb.jpg"
}
```

Note: chart items **do not** include `nationalcode` either — but a `strType=3` filter implicitly tags everything as J-pop.

### 3. `/legacy/api/searchSong` (newly discovered)

**Not referenced anywhere in the public site's JS** — the public search uses the HTML form route `/song/accompaniment_search` instead. Discovered by blind probing.

**Required params:**
| Param | Notes |
|---|---|
| `searchTxt` | Query string. **Cannot be empty** (returns `code: 98`). Single-char queries OK. |
| `strType` | `0` = integrated (returns 6-bucket array), `1` = title (flat array), `2` = artist (flat array). `3,5,6,7` return `code: 98`. |
| `nationType` | `""` (all), `KOR` (가요), `ENG` (팝송), `JPN` (일본곡). Other values return empty. |

**Response shape (`strType=0`, integrated):**
```json
{
  "resultCode": "99",
  "resultData": [
    { "items1TotalCount": 0, "items1": [] },   // bucket 0
    { "items2TotalCount": 10, "items2": [...] },// bucket 1 (artist match)
    /* ... 6 buckets total */
  ]
}
```

**Response item shape (rich!):**
```json
{
  "rownumber": 1,
  "imgthumb_path": "https://www.tjmedia.com/SONG_ALBUMIMG/SONG_MATCH/068781_thumb.jpg",
  "pro": 68781,
  "indexTitle": "アイドル(推しの子 OP)",
  "subTitle": "",
  "indexSong": "YOASOBI",
  "word": "AYASE",
  "com": "AYASE",
  "sortTitleKo": "아이도루(최애의 아이 OP)",
  "sortSongKo": "",
  "icongubun": "",
  "mv_yn": "N",
  "nationalcode": "JPN",
  "publishdate": "2023-05-24"
}
```

**Three new fields not in `newSongOfMonth`:**
- **`nationalcode`** — `KOR` / `ENG` / `JPN` — authoritative nationality
- **`sortTitleKo`** — Korean transliteration of title (e.g., `アイドル` → `아이도루`)
- **`sortSongKo`** — Korean transliteration of artist (often empty when artist is already in Latin)
- **`subTitle`** — title sub-line (often empty)

**Cap**: server returns ~30–40 records per query. `pageRowCnt` parameter is **not** respected (tested up to 10000). `pageNo` parameter unverified — bulk dump via this endpoint is therefore impractical without iterating across many `searchTxt` values.

---

## Page-Level Endpoints (HTML)

| Path | Notes |
|---|---|
| `/song/accompaniment` | Search form (default loads top 15) |
| `/song/accompaniment_search` | GET search results (server-rendered HTML). Form fields: `pageNo`, `pageRowCnt`, `strSotrGubun`, `strSortType`, `nationType`, `strType`, `searchTxt`, `strWord`. **Empty `searchTxt` returns "no results"** — cannot bulk-dump JPN catalog this way. |
| `/song/recent_song` | Current month new-songs page; uses `newSongOfMonth` underneath |
| `/chart/top100` | Top-100 chart UI; uses `topAndHot100` XHR for genre/date filter changes |
| `/chart/hot100` | "Year's hot 100" chart, **server-rendered** (no XHR) |
| `/chart/hit_song` | "Hit song" chart, **server-rendered** (no XHR) |
| `/sitemap` | HTML sitemap |
| `/sitemap.xml` | XML sitemap |
| `/musicroom/song_room` | Karaoke marketing page (no song data) |
| `/support/paidsong` | Paid-song registration info (no song list) |
| `/support/exit` | Emergency-evacuation video registration (compliance, no songs) |
| `/product/product_list?cate_cd=G01..G07` | Hardware product catalog (반주기, 앰프, 스피커, 마이크, TV, 관리기, 기타) |
| `/introduce/*`, `/story/*`, `/support/*`, `/terms/*` | Corporate pages |

---

## Subdomains (Surveyed)

| Host | Purpose | Has song data? |
|---|---|---|
| `www.tjmedia.com` | Main site, public APIs | **Yes** (the `/legacy/api/*` set) |
| `smartcard.tjmedia.com` | Business smart-card software downloads | No |
| `membership.tjmedia.com` | Dealer/retailer membership portal | No |
| `scm.tjmedia.com` | Internal SCM (`setup.exe`, manual PDF) | No |
| `newsong.tjmedia.com` | Home-karaoke product showcase landing | No (despite the name) |
| `m.tjmedia.com` | **Does not exist (404)** | — |
| `www.tjmedia.co.kr` | **301 redirect to `www.tjmedia.com`** | — |
| `newsong.tjmedia.com.ph` | TJ Philippines new-song catalog (`/function/down_index.asp`) | Yes — but Philippines/PH catalog (different from KR) |

`m.tjmedia.com` 404 is expected — the main site is responsive and serves both desktop and mobile from the same origin.

---

## Negative Results (so we don't re-try)

**Endpoint names probed under `/legacy/api/` that returned the maintenance page (none of these exist):**
`hitSong`, `hitChart`, `monthChart`, `monthHit`, `yearHit`, `yearChart`, `newSong`, `newSongs`, `songNew`, `songInfo`, `songDetail`, `songSearch`, `getSong`, `getSongList`, `getSearch`, `songCount`, `getCount`, `searchSongCount`, `getCountSong`, `songYear`, `songYearList`, `jpopList`, `medleyList`, `melody`, `medley`, `songOfYear`, `songOfMonth`, `allSong`, `songList`, `getMenu`, `getCode`, `getCommonCode`, `getInfo`, `getNationCode`, `version`, `ping`, `health`, `getGNBMenu`, `adminLogin`, `login`, `getSongCount`, `songStatistics`, `songFavorite`, `singFavorite`, `recentSearch`, `getRecentSong`, `recommandSong`, `suggestSong`, `songYM`, `songMonth`, `songYear`, `songCategory`, `songCate`, `songVendor`, `songNation`, `getCategory`, `getNation`, `getJpop`, `getKpop`, `getPop`, `songRecent`, `songNewest`, `newestSong`, `recentSong`, `songGetByPro`, `songGet`, `songByPro`, `songByNumber`, `songInfoByPro`, `byPro`, `findSong`, `songFind`, `getSongDetail`, `songMeta`, `songMetadata`, `songData`, `getSongData`, `allSongList`, `songsAll`, `allSongs`, `catalog`, `getCatalog`, `songCatalog`.

**Alternate API roots probed (all served maintenance page):** `/legacy/services/`, `/legacy/v1/`, `/legacy/v2/`, `/services/`, `/rest/`, `/api/v1/`, `/api/legacy/`, `/legacy/api2/`, `/legacy/json/`, `/json/`, `/legacy/admin/api/`, `/api/`, `/front/api/`, `/web/api/`, `/song/api/`.

**Methods:** GET on the JSON endpoints returns `code: 98` (no params) or `code: 20` (missing required param) — the endpoints are POST-only in practice. No HEAD/OPTIONS hint at additional surface.

**Pagination:** `pageRowCnt` param is **not** honored on `searchSong` (server cap ~40). Date range on `topAndHot100` is client-clamped to 2 years; server-side enforcement untested but probably matches.

---

## NamuWiki-Replacement Strategy (recommendation)

The existing TJ-direct adapter (`packages/crawler/src/adapters/tj-media-direct/`) pulls all 67k records via `newSongOfMonth?searchYm=200001`, then filters to ~5,900 J-pop records using a loose-JP regex + Chinese-artist denylist + a "rescue" set sourced from the blog corpus. NamuWiki was meant to fill in nationality tagging and Korean readings.

**The newly discovered `searchSong` endpoint replaces the namu role:**

1. **Bulk fetch** stays unchanged: `newSongOfMonth?searchYm=200001` → 67k records.
2. **JP-filter** stays as-is (loose-JP regex + denylist + rescue) — this is fast and free.
3. **Add an enrichment pass:** for each surviving J-record, call `searchSong?searchTxt=<exact title>&strType=1&nationType=JPN`.
   - On match (highest-confidence: `pro` matches), pull `nationalcode`, `sortTitleKo`, `sortSongKo`, `subTitle`, `publishdate` and merge into the record.
   - This eliminates the need to compute Korean transliterations manually (currently a non-feature) and gives us an **authoritative `nationalcode`** to validate the JP filter.
4. **Anime/vocaloid sub-categorization** stays on the existing PDF ingest (`scripts/ingest-anisong-pdf.py`) — TJ's API does not distinguish below nationality.

**Cost:** ~5,900 search calls per crawl. At the current TJ rate-limit (`500 ms ± 100 ms`), that's ~50 minutes. If too long, we can batch by deduplicated artist names (~hundreds of unique J-artists) instead.

**Wins vs NamuWiki:**
- ✅ Authoritative `nationalcode` per song (no more regex guessing)
- ✅ Korean transliterations baked in (no romanization library required)
- ✅ Single rate-limited host (TJ already configured at 500 ms)
- ✅ No HTML scraping / wiki-format parsing risk
- ✅ Stable schema (versioned-looking `/legacy/api/` namespace)
- ❌ Does not provide vocaloid/anime sub-tags — keep the PDF ingest

---

## Pointers for the next session

- All endpoints documented above were verified live on 2026-04-29 against `www.tjmedia.com`. Re-verify before adapter implementation in case TJ revs the API.
- `searchSong` was discovered by blind name-probing — there may still be undiscovered endpoints. Future avenues to try:
  - Decompile the `kr.tj.tjsmartplay_U` Android app from Play Store (the consumer app with NFC-pairing, song-verification features) — it likely uses an internal API beyond the 3 we found.
  - Reverse a TJ karaoke firmware update file (if obtainable from `smartcard.tjmedia.com`) for embedded API URLs.
  - Try the Philippines API at `newsong.tjmedia.com.ph/function/down_index.asp` — different stack, may have different endpoints.
- The `tj-media-karaoke-api` GitHub project (Alfex4936) explicitly *avoided* the TJ API and pre-downloaded data — confirms TJ's API was historically un-documented.
- Robots.txt for `www.tjmedia.com` was unreachable through the WebFetch proxy (returned a maintenance shim). Direct via `fetch('/robots.txt')` from the browser would confirm; not done in this pass.
