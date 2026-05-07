"""Shared category-exclusivity helper for the karaoke data pipeline.

Extracted from `scripts/ingest_anisong_pdf.py`. Mirrors
`applyCategoryExclusivity` in `packages/schema/src/index.ts` and
`packages/crawler/src/merge.ts` so all Python pipeline scripts apply the
same mutual-exclusivity rule: at most one of {jpop, vocaloid, anime} per
record, with priority vocaloid > anime > jpop.

The priority order is data-driven via the `category-priority.json` sidecar
(graceful fallback to a hardcoded copy if absent).

Public API:
  apply_category_exclusivity(cats) — enforce mutual exclusivity, return sorted list
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# REPO_ROOT: scripts/lib/ -> scripts/ -> repo root
_LIB_DIR = Path(__file__).resolve().parent
REPO_ROOT = _LIB_DIR.parent.parent

# Category-priority JSON sidecar produced by `scripts/export-category-priority.mjs`
# (which reads `CATEGORY_PRIORITY` from the built dist of
# `packages/schema/src/index.ts`). Tracked in git alongside the schema package.
# Treated as graceful-degradation when missing or malformed: fall back to a
# hardcoded copy of the priority tuple with a stderr warning.
_CATEGORY_PRIORITY_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'schema'
    / 'category-priority.json'
)

# Hardcoded fallback for `_load_category_priority()` — mirrors CATEGORY_PRIORITY
# in `packages/schema/src/index.ts`. Kept in sync by the sidecar mechanism;
# this fallback is only used when the sidecar is absent (partial-build state).
_CATEGORY_PRIORITY_FALLBACK: tuple[str, ...] = ('vocaloid', 'anime', 'jpop')


def _load_category_priority() -> tuple[str, ...]:
    """Load `priority` from the category-priority sidecar.

    Returns the priority tuple on success. On any failure (missing file,
    malformed JSON, wrong schema) logs a stderr warning and returns the
    hardcoded fallback so the module remains functional in a partial-build
    state (e.g. a developer runs the script before rebuilding the schema).
    """
    sidecar_path = _CATEGORY_PRIORITY_SIDECAR
    if not sidecar_path.exists():
        print(
            f'WARN: category-priority sidecar not found at {sidecar_path} — '
            'falling back to hardcoded category priority '
            '(run `node scripts/export-category-priority.mjs` after building the schema)',
            file=sys.stderr,
        )
        return _CATEGORY_PRIORITY_FALLBACK
    try:
        data = json.loads(sidecar_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f'WARN: failed to read category-priority sidecar {sidecar_path}: {exc} — '
            'falling back to hardcoded category priority',
            file=sys.stderr,
        )
        return _CATEGORY_PRIORITY_FALLBACK
    priority = data.get('priority')
    if not isinstance(priority, list) or not priority:
        print(
            f'WARN: category-priority sidecar at {sidecar_path} missing `priority` — '
            'falling back to hardcoded category priority',
            file=sys.stderr,
        )
        return _CATEGORY_PRIORITY_FALLBACK
    return tuple(priority)


# Priority loaded from sidecar at import time (graceful fallback if absent).
_CATEGORY_PRIORITY: tuple[str, ...] = _load_category_priority()


def apply_category_exclusivity(cats: list[str]) -> list[str]:
    """Apply the v2 category mutual-exclusivity rule: at most one of
    {jpop, vocaloid, anime} per record. Priority: vocaloid > anime > jpop.

    Mirrors `applyCategoryExclusivity` in `packages/schema/src/index.ts` and
    `packages/crawler/src/merge.ts` so this script's output matches what the
    JS pipeline would produce. Returns a new sorted list (does not mutate).

    The priority order is data-driven via `_CATEGORY_PRIORITY` (loaded from
    `packages/schema/category-priority.json` at import time). The algorithm
    iterates the priority array; the first entry present in `cats` wins and
    all other known categories are removed.

    Examples:
      ['jpop']                       -> ['jpop']      (unchanged)
      ['jpop', 'anime']              -> ['anime']
      ['jpop', 'vocaloid']           -> ['vocaloid']
      ['anime', 'vocaloid']          -> ['vocaloid']  (vocaloid wins)
      ['jpop', 'anime', 'vocaloid']  -> ['vocaloid']
    """
    s = set(cats)
    for winner in _CATEGORY_PRIORITY:
        if winner in s:
            s -= set(_CATEGORY_PRIORITY) - {winner}
            return sorted(s)
    # No known category found — return sorted as-is (unknown values preserved).
    return sorted(s)
