"""One-shot + re-runnable corpus cleanup: drop records whose artist matches
the Chinese-artist (Cantopop / Mandopop) drop list, plus a small set of
catalog-anomaly IDs.

Why this exists
---------------
The TJ-direct adapter applies the drop list inside its parser, so the next
re-crawl produces a clean corpus. Re-crawling, however, takes 2-3 hours of
TJ-search calls. This script re-applies the same drop set against an
already-crawled `apps/web/public/data/songs.json` so a maintainer who adds
new entries to the drop list can clean the corpus without paying the
re-crawl cost.

Mirrors `scripts/drop_kpop_leaks.py` exactly — only the sidecar path and
the additional ID drop-list differ.

Catalog-anomaly IDs
-------------------
A small hardcoded list of TJ IDs whose `artist_primary` is malformed in the
TJ source (e.g. literal `-` for tj-72638, a record whose simplified-Chinese
title `明天你是否依然爱我` confirms it as Mandopop). The artist-name match
can't catch these because the artist field itself is the anomaly. Keep this
list small and reviewed — broadening it past obviously-malformed records
risks dropping legitimate corpus entries.

Behavior
--------
1. Load `apps/web/public/data/songs.json` (UTF-8).
2. Load the drop-list sidecar at
   `packages/crawler/src/adapters/tj-media-direct/chinese-artist-drop-list.json`.
   The sidecar is produced by `scripts/export-chinese-drop-list.mjs` from the
   built TS source and is REQUIRED here — running this script without the
   sidecar is a no-op that wastes a write cycle. The sidecar is tracked in
   git so an ad-hoc local run picks up the latest list without first
   rebuilding the crawler.
3. For each record, drop if EITHER:
     (a) any component of `artist_primary` (split on the same delimiters the
         TS source uses) matches the drop set, OR
     (b) the record's `id` is in `_CATALOG_ANOMALY_IDS`.
4. Atomic-write the result back via `<file>.tmp` + `os.replace()`. When no
   records match the drop list, the corpus file is NOT rewritten — the
   existing on-disk bytes survive untouched, preserving mtime and avoiding
   spurious diffs.
5. Print a report: total before / after, dropped count, and a sample of 10
   dropped (id, artist) pairs for spot-checking.

Idempotent — running twice produces a no-op on the second run (no rewrite,
no mtime change).

Usage
-----
    python scripts/drop_cpop_leaks.py
    python scripts/drop_cpop_leaks.py --dry-run   # report without modifying
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Make `scripts/lib/` importable regardless of invocation cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from lib.corpus_io import atomic_write_corpus, ensure_utf8_stdio
from lib.artist_split import is_artist_in_drop_list, load_drop_keys

REPO_ROOT = _HERE.parent
SONGS_JSON = REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'
DROP_LIST_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'crawler'
    / 'src'
    / 'adapters'
    / 'tj-media-direct'
    / 'chinese-artist-drop-list.json'
)

# Catalog-anomaly IDs: records where `artist_primary` itself is malformed in
# the TJ source (e.g. literal `-`) so the artist-name match cannot catch them.
# Keep this list small and reviewed.
#   - tj-72638: artist literally `-`, title `明天你是否依然爱我` (simplified
#     Chinese, confirmed Mandopop).
_CATALOG_ANOMALY_IDS: frozenset[str] = frozenset({
    'tj-72638',
    'tj-71365',
})


# Apply UTF-8 stdio at module load (idempotent — also re-applied in main()).
ensure_utf8_stdio()


def main(argv: list[str] | None = None) -> int:
    ensure_utf8_stdio()

    parser = argparse.ArgumentParser(description='Drop Chinese-artist leak records from corpus.')
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Report what would be dropped without modifying the corpus file.',
    )
    args = parser.parse_args(argv)

    if not SONGS_JSON.exists():
        print(f'ERROR: missing corpus at {SONGS_JSON}', file=sys.stderr)
        return 2
    if not DROP_LIST_SIDECAR.exists():
        print(
            f'ERROR: missing drop-list sidecar at {DROP_LIST_SIDECAR}\n'
            '  Run `corepack pnpm --filter @karaoke/crawler build` (build now '
            'auto-regenerates the sidecar). Or run `node scripts/export-chinese-drop-list.mjs` '
            'directly after a previous build.',
            file=sys.stderr,
        )
        return 2

    drop_keys = load_drop_keys(DROP_LIST_SIDECAR)
    if not drop_keys:
        print(
            f'ERROR: drop-list sidecar at {DROP_LIST_SIDECAR} loaded zero keys',
            file=sys.stderr,
        )
        return 2
    print(f'loaded {len(drop_keys)} drop-list keys')

    with open(SONGS_JSON, encoding='utf-8') as f:
        corpus = json.load(f)

    total_before = len(corpus)
    kept: list[dict] = []
    dropped_samples: list[tuple[str, str]] = []
    dropped_count = 0
    for rec in corpus:
        rec_id = str(rec.get('id', ''))
        artist = rec.get('artist_primary') or ''
        if rec_id in _CATALOG_ANOMALY_IDS or is_artist_in_drop_list(artist, drop_keys):
            dropped_count += 1
            if len(dropped_samples) < 10:
                dropped_samples.append((rec_id or '<no-id>', artist))
            continue
        kept.append(rec)
    total_after = len(kept)

    if dropped_count == 0:
        print('no records matched the drop list — corpus already clean (no-op)')
        return 0

    if args.dry_run:
        print(f'dry-run — would drop: {dropped_count} (before={total_before} after={total_after})')
        print('sample (first 10 would-drop):')
        for rec_id, artist in dropped_samples:
            print(f'  {rec_id}  {artist!r}')
        print('dry-run, no changes written', file=sys.stderr)
        return 0

    # Atomic write via shared helper (songs.json.tmp -> os.replace).
    atomic_write_corpus(SONGS_JSON, kept)

    print(f'total before: {total_before}')
    print(f'total after:  {total_after}')
    print(f'dropped:      {dropped_count}')
    print('sample (first 10 dropped):')
    for rec_id, artist in dropped_samples:
        print(f'  {rec_id}  {artist!r}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
