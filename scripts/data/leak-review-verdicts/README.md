# leak-review-verdicts

Provenance record for the **2026-07-20 K-pop / Western-pop leak triage**.

Owner directive: clear the K-pop / Western-pop leakage first. Starting from the
"joyless" (no-JOYSOUND) 576-row triage set, 44 candidate rows were escalated to a
parallel web review. Verdicts were then integrated by the orchestrator (two
overturns — see below) into `verdicts-2026-07-20.jsonl`.

## `verdicts-2026-07-20.jsonl`

One JSON object per line (44 rows): `{ id, title, artist, verdict, reason, evidence }`.

- `verdict` ∈ `DROP` | `KEEP`.
- Final tally: **11 DROP / 33 KEEP**.

The 11 `DROP` rows are the songs encoded for removal by this change. They are
blocked at their **stable key** (TJ / KY number) so they survive a re-crawl:

- Crawl time — `packages/crawler/src/adapters/tj-media-direct/reviewedSongOverrides.ts`
  (`REVIEWED_TJ_SONG_DROP_LIST`, step-0 `reviewed-song-drop`) and, for the KY
  claim, `packages/crawler/src/adapters/ky-kysing/reviewedKySongOverrides.ts`
  (`REVIEWED_KY_DROP_ENTRIES`).
- Frozen-corpus post-processing — `scripts/drop-artist-leaks.mjs`
  (`KOREAN_CATALOG_ANOMALY_IDS`, `--list korean` pass).

All drops are **per song (by number/ID), never by artist name** — the credited
artists (Mary McGregor, MAX, LiSA, CUTIE STREET) each collide with a legitimate
Japanese act or tie-up that must stay in scope.

## Overturns (reviewer verdict changed during integration)

- `blog-1601-1` CUTIE STREET "귀엽기만 하면 안 되나요?" — reviewer **KEEP → DROP**.
  Korean-language row (tj 52093 / ky 51322, no JOYSOUND); the JP original
  (tj 52410 / ky 57750 / joy 630523) and the JOYSOUND-hosted "(Korean ver.)"
  (joy 648842) both stay.
- `blog-630-10` "Better Half" — reviewer DROP → **KEEP** (re-overturn). The stable
  key tj 44601 is the already-ALLOW-listed Japanese version (Omoinotake, joy
  633639, "-Japanese ver.-"); the frozen corpus's Korean credit is stale parsing
  that resolves naturally on re-crawl.
