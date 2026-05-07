"""One-shot + re-runnable corpus cleanup: drop records whose artist matches
the Korean-artist drop list.

Why this exists
---------------
The TJ-direct adapter applies the drop list inside its parser, so the next
re-crawl produces a clean corpus. Re-crawling, however, takes 2-3 hours of
TJ-search calls. This script re-applies the same drop set against an
already-crawled `apps/web/public/data/songs.json` so a maintainer who adds
new entries to the drop list (e.g. J-Walk and PLAVE in the post-Phase-2
audit) can clean the corpus without paying the re-crawl cost.

Scope (Fix 4, 2026-05-01)
-------------------------
This script applies the drop list against ALL records regardless of `id`
source prefix (`tj-`, `blog-`, `tjpdf-`, `namu-`). The TS parser drop-list
only gates `tj-` records at crawl time; this script is the after-the-fact
"cleanup also catches blog-source residue and tjpdf-source residue"
companion. The match is on `artist_primary` content, not on `id` prefix —
so a `blog-` record whose `artist_primary` is `방탄소년단` is dropped here
even though the TS parser never sees blog records. This is intentional:
the corpus-level filter is the canonical one; the parser filter is a
crawl-time efficiency win.

Behavior
--------
1. Load `apps/web/public/data/songs.json` (UTF-8).
2. Load the drop-list sidecar at
   `packages/crawler/src/adapters/tj-media-direct/korean-artist-drop-list.json`.
   The sidecar is produced by `scripts/export-drop-list.mjs` from the built TS
   source and is REQUIRED here (unlike the PDF ingest, which gracefully
   degrades) — running this script without the sidecar is a no-op that wastes
   a write cycle. The sidecar is tracked in git (Fix 2, 2026-05-01) so an
   ad-hoc local run picks up the latest list without first rebuilding the
   crawler.
3. For each record, check whether ANY component of `artist_primary`
   (split on the same delimiters the TS source uses) matches the drop set.
   If yes, drop. Categorical matching mirrors the parser's behaviour exactly
   so re-running this script after a re-crawl produces zero deletions.
4. Atomic-write the result back via `<file>.tmp` + `os.replace()` (mirrors the
   pattern used by `ingest_anisong_pdf.py` and the JS crawler workflow). When
   no records match the drop list, the corpus file is NOT rewritten — the
   existing on-disk bytes survive untouched, preserving mtime and avoiding
   spurious diffs.
5. Print a report: total before / after, dropped count, and a sample of 10
   dropped (id, artist) pairs for spot-checking.

Idempotent — running twice produces a no-op on the second run (no rewrite,
no mtime change).

Usage
-----
    python scripts/drop_kpop_leaks.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make `scripts/lib/` importable regardless of invocation cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from lib.corpus_io import atomic_write_corpus, ensure_utf8_stdio
from lib.artist_split import is_artist_in_drop_list, load_drop_keys

# Private aliases kept for backward-compat with existing tests that reference
# these names via the `script` module handle.
_ensure_utf8_stdio = ensure_utf8_stdio
_atomic_write_corpus = atomic_write_corpus

REPO_ROOT = _HERE.parent
SONGS_JSON = REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'
DROP_LIST_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'crawler'
    / 'src'
    / 'adapters'
    / 'tj-media-direct'
    / 'korean-artist-drop-list.json'
)

# Apply UTF-8 stdio at module load (idempotent — also re-applied in main()).
ensure_utf8_stdio()


def main() -> int:
    _ensure_utf8_stdio()

    if not SONGS_JSON.exists():
        print(f'ERROR: missing corpus at {SONGS_JSON}', file=sys.stderr)
        return 2
    if not DROP_LIST_SIDECAR.exists():
        print(
            f'ERROR: missing drop-list sidecar at {DROP_LIST_SIDECAR}\n'
            '  Run `corepack pnpm --filter @karaoke/crawler build` (build now '
            'auto-regenerates the sidecar). Or run `node scripts/export-drop-list.mjs` '
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
        artist = rec.get('artist_primary') or ''
        if is_artist_in_drop_list(artist, drop_keys):
            dropped_count += 1
            if len(dropped_samples) < 10:
                dropped_samples.append((str(rec.get('id', '<no-id>')), artist))
            continue
        kept.append(rec)
    total_after = len(kept)

    if dropped_count == 0:
        print('no records matched the drop list — corpus already clean (no-op)')
        return 0

    # Atomic write via shared helper (songs.json.tmp -> os.replace).
    _atomic_write_corpus(SONGS_JSON, kept)

    print(f'total before: {total_before}')
    print(f'total after:  {total_after}')
    print(f'dropped:      {dropped_count}')
    print('sample (first 10 dropped):')
    for rec_id, artist in dropped_samples:
        print(f'  {rec_id}  {artist!r}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
