"""One-shot + re-runnable corpus cleanup: retag blog records whose post-id is
in the per-post category override map from `vocaloid` to `jpop`.

Why this exists
---------------
The blog adapter (`packages/crawler/src/adapters/jpop-playlist-blog/crawler.ts`)
applies a per-post category override map (`POST_CATEGORY_OVERRIDES`) at crawl
time, so the next re-crawl produces a clean corpus. Re-crawling the blog,
however, takes hours of HTTP. This script re-applies the same override map
against an already-crawled `apps/web/public/data/songs.json` so the existing
22 mistagged records can be fixed without paying the re-crawl cost.

Mirrors the pattern of `scripts/drop-kpop-leaks.py` (filter-and-rewrite-corpus
with sidecar config) and `scripts/ingest-anisong-pdf.py` (atomic write +
`_apply_category_exclusivity` reuse).

Scope (TODO 2 of 2026-05-04 vocaloid-mistag audit)
--------------------------------------------------
Three blog posts surfaced under the Vocaloid index `/417` whose contents are
not actually Vocaloid:
  - blog-101 / 米津玄師   (post-Vocaloid solo J-pop catalog)
  - blog-105 / Zutomayo   (J-rock duo)
  - blog-112 / Aimer      (pop / anime singer)

Critical design constraint: 米津玄師's early career as ハチ was a real Vocaloid
producer. The blog already publishes that catalog separately under post /428
(artist `ハチ`). This script keys on POST-ID (`blog-101-*`), NOT on artist
name, so blog-428 records are unaffected.

Behavior
--------
1. Load `apps/web/public/data/songs.json` (UTF-8).
2. For each record whose `id` starts with `blog-101-` / `blog-105-` /
   `blog-112-` AND whose `categories` currently contains `vocaloid`:
   replace `categories` with `['jpop']`. The fix is gated on the presence of
   `vocaloid` because PDF-derived `anime` tags on the same blog posts (e.g.
   Aimer's anime tie-in tracks like `六等星の夜 (NO.6 ED)` from
   `scripts/ingest-anisong-pdf.py`) encode a real, cross-validated signal
   that must NOT be clobbered. The audit's bug is confined to the `vocaloid`
   mistag.
3. Run `_apply_category_exclusivity` on each rewritten record's categories
   (defense-in-depth — it's a no-op for `['jpop']` but matches the canonical
   pipeline shape).
4. If at least one record was retagged, atomic-write the result back via
   `<file>.tmp` + `os.replace()`. When no records match, the corpus file is
   NOT rewritten — the existing on-disk bytes survive untouched.
5. Print a report: total before / after, retagged count, and a sample of up
   to 10 retagged (id, artist) pairs for spot-checking.

Idempotent — running twice produces a no-op on the second run (no rewrite,
no mtime change).

Usage
-----
    python scripts/retag-blog-vocaloid-mistags.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

# Reuse `_apply_category_exclusivity` from the anisong ingest so this script
# applies the SAME priority rule (vocaloid > anime > jpop) the JS pipeline
# uses. Importing via importlib because the filename contains a hyphen
# (Python identifier rules).
_HERE = Path(__file__).resolve().parent
_INGEST_PATH = _HERE / 'ingest-anisong-pdf.py'
_spec = importlib.util.spec_from_file_location('ingest_anisong_pdf', _INGEST_PATH)
assert _spec is not None and _spec.loader is not None
_ingest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ingest)

REPO_ROOT = _HERE.parent
SONGS_JSON = REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'

# Per-post category override map. MUST stay in sync with
# `POST_CATEGORY_OVERRIDES` in
# `packages/crawler/src/adapters/jpop-playlist-blog/crawler.ts`. Keyed on the
# numeric post-id (the `{artistIdNumber}` segment of `blog-{N}-{rowIndex}` ids).
POST_CATEGORY_OVERRIDES: dict[str, str] = {
    '101': 'jpop',  # 米津玄師 — post-Vocaloid solo J-pop catalog (9 records).
    '105': 'jpop',  # Zutomayo — J-rock duo (11 records).
    '112': 'jpop',  # Aimer — pop / anime singer (2 records).
}

# Pre-compiled id-prefix matchers (`blog-101-`, etc.).
_ID_PREFIX_PATTERN = re.compile(
    r'^blog-(' + '|'.join(re.escape(k) for k in POST_CATEGORY_OVERRIDES) + r')-\d+$'
)


# Shared helpers from the ingest script — `_ensure_utf8_stdio()` and
# `_atomic_write_corpus()` (M1 + M2, 2026-05-04). Re-exported as module-level
# names so consumers and tests can keep the existing call sites.
_ensure_utf8_stdio = _ingest._ensure_utf8_stdio
_atomic_write_corpus = _ingest._atomic_write_corpus

# Apply UTF-8 stdio at module load (idempotent — also re-applied in main()).
_ensure_utf8_stdio()


def get_post_override(record_id: str) -> str | None:
    """Return the override category for a record id, or None if not overridden.

    Matches `blog-{post-id}-{rowIndex}` where post-id is in
    `POST_CATEGORY_OVERRIDES`. Anything else (other adapters, malformed ids,
    non-overridden blog posts) returns None.

    Exported for unit testing.
    """
    if not isinstance(record_id, str):
        return None
    m = _ID_PREFIX_PATTERN.match(record_id)
    if m is None:
        return None
    return POST_CATEGORY_OVERRIDES[m.group(1)]


def retag_record(record: dict) -> bool:
    """Apply the per-post override to a single record IN PLACE.

    Returns True if the record's `categories` field was mutated, False otherwise.
    The override only fires when `categories` currently contains `vocaloid` —
    PDF-derived `anime` tags on the same post (e.g. Aimer's anime-tie-in tracks
    like `六等星の夜 (NO.6 ED)`) are LEFT INTACT because they encode a real,
    cross-validated signal from the anisong PDF ingest. The audit's bug is
    confined to the `vocaloid` mistag; `anime` tags on the same blog posts
    are correct.

    A record whose `categories` does not contain `vocaloid` is a no-op (returns
    False). A record whose `categories` is already `[override]` is a no-op too —
    supports byte-idempotence on the second run.
    """
    override = get_post_override(record.get('id', ''))
    if override is None:
        return False
    current = list(record.get('categories') or [])
    if 'vocaloid' not in current:
        return False
    # Replace the vocaloid mistag with the override category. Run the canonical
    # exclusivity rule (vocaloid > anime > jpop) afterward so the result still
    # passes the schema's `maxItems: 1` constraint.
    desired = _ingest._apply_category_exclusivity([override])  # ['jpop'] -> ['jpop']
    if current == desired:
        return False
    record['categories'] = desired
    return True


def main() -> int:
    _ensure_utf8_stdio()

    if not SONGS_JSON.exists():
        print(f'ERROR: missing corpus at {SONGS_JSON}', file=sys.stderr)
        return 2

    with open(SONGS_JSON, encoding='utf-8') as f:
        corpus = json.load(f)

    total = len(corpus)
    retagged_samples: list[tuple[str, str]] = []
    retagged_count = 0
    for rec in corpus:
        if retag_record(rec):
            retagged_count += 1
            if len(retagged_samples) < 10:
                retagged_samples.append(
                    (str(rec.get('id', '<no-id>')), str(rec.get('artist_primary', '<no-artist>')))
                )

    if retagged_count == 0:
        print('no records matched the per-post override map — corpus already clean (no-op)')
        return 0

    # Atomic write via shared helper (songs.json.tmp -> os.replace).
    _atomic_write_corpus(SONGS_JSON, corpus)

    print(f'total records: {total}')
    print(f'retagged:      {retagged_count}')
    print('sample (first 10 retagged):')
    for rec_id, artist in retagged_samples:
        print(f'  {rec_id}  {artist!r}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
