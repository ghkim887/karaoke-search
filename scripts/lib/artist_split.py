"""Shared artist-splitting and drop-list helpers for the karaoke data pipeline.

Extracted from `scripts/ingest_anisong_pdf.py`. Used by every script that
needs to check whether an artist string matches a Korean or Chinese drop-list.

The splitter delimiter pattern is loaded from the `clustering-rules.json`
sidecar at import time (graceful fallback to a hardcoded copy if absent).

Public API:
  normalize_for_match(s)                  — whitespace-strip, lowercase, NFKC
  artist_components_for_drop_check(artist) — split artist into all matchable components
  load_drop_keys(sidecar_path)            — load a drop-list JSON sidecar -> set[str]
  is_artist_in_drop_list(artist, keys)    — True if any component is in keys

Module-level constants (used by consumers and tests):
  DROP_SPLIT_RE       — compiled splitter regex (TS SPLIT_RE parity)
  FEAT_INNER_OF_RE    — sub-splitter for feat/prod paren inner content
  FEAT_PAREN_FINDALL_RE — findall source for feat/prod parens
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

# REPO_ROOT: scripts/lib/ -> scripts/ -> repo root
_LIB_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _LIB_DIR.parent
REPO_ROOT = _SCRIPTS_DIR.parent

# Clustering-rules JSON sidecar produced by `scripts/export-clustering-rules.mjs`
# (which reads `SPLIT_RE_SOURCE` / `SPLIT_RE_FLAGS` from the built dist of
# `packages/crawler/src/clustering.ts`). Tracked in git alongside the TS source.
# Treated as graceful-degradation when missing or malformed: fall back to a
# hardcoded copy of the delimiter alternations with a stderr warning.
_CLUSTERING_RULES_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'crawler'
    / 'src'
    / 'clustering-rules.json'
)

# Hardcoded fallback used when the sidecar is unavailable. Must match the TS
# SPLIT_RE_SOURCE value exactly — this is the last resort copy, not the source
# of truth. Update alongside clustering.ts if the sidecar mechanism ever breaks.
_SPLIT_RE_SOURCE_FALLBACK = r'\s*[&＆,×｜]\s*|\s+with\s+|\s+meets\s+|\s*feat\.\s*'


def _load_splitter_pattern() -> str:
    """Load `splitterPattern` from the clustering-rules sidecar.

    Returns the pattern string on success. On any failure (missing file,
    malformed JSON, wrong schema) logs a stderr warning and returns the
    hardcoded fallback so the module remains functional in a partial-build
    state (e.g. a developer runs the script before rebuilding the crawler).
    """
    sidecar_path = _CLUSTERING_RULES_SIDECAR
    if not sidecar_path.exists():
        print(
            f'WARN: clustering-rules sidecar not found at {sidecar_path} — '
            'falling back to hardcoded splitter pattern '
            '(run `node scripts/export-clustering-rules.mjs` after building the crawler)',
            file=sys.stderr,
        )
        return _SPLIT_RE_SOURCE_FALLBACK
    try:
        data = json.loads(sidecar_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f'WARN: failed to read clustering-rules sidecar {sidecar_path}: {exc} — '
            'falling back to hardcoded splitter pattern',
            file=sys.stderr,
        )
        return _SPLIT_RE_SOURCE_FALLBACK
    pattern = data.get('splitterPattern')
    if not isinstance(pattern, str) or not pattern:
        print(
            f'WARN: clustering-rules sidecar at {sidecar_path} missing `splitterPattern` — '
            'falling back to hardcoded splitter pattern',
            file=sys.stderr,
        )
        return _SPLIT_RE_SOURCE_FALLBACK
    return pattern


def normalize_for_match(s: str) -> str:
    """Mirror of `normalizeForMatch` in `packages/crawler/src/adapters/
    tj-media-direct/normalize.ts`: strip every whitespace char, lowercase, NFKC.

    Cache keys + drop-list keys are produced by the TS rule; matching by hand
    in Python requires the exact same transform or membership tests miss.
    """
    return unicodedata.normalize('NFKC', re.sub(r'\s+', '', s).lower())


# The feat-paren prefix is Python-specific: `re.split()` with a capturing group
# returns the captured text as an element in the result list, so prepending the
# feat/prod paren pattern here lets `artist_components_for_drop_check` receive
# the inner text of every `(Feat. X)` / `(Prod. X)` as its own split piece.
# The delimiter alts that follow come from the sidecar (TS source of truth).
DROP_SPLIT_RE = re.compile(
    r'\s*\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)\s*|' + _load_splitter_pattern(),
    re.IGNORECASE,
)

# Inside a captured `(Feat. X)` / `(Prod. X)` group ONLY, ` of ` reliably means
# "member-of-group" (e.g. `(Feat. SUGA of BTS)` → SUGA + BTS). This regex is
# applied to the captured inner string in `artist_components_for_drop_check`
# — never to the bare top-level artist text.
FEAT_INNER_OF_RE = re.compile(r'\s+of\s+', re.IGNORECASE)

# Detect feat/prod parentheticals so we can identify which sub-pieces came from
# inside one (only those should get the ` of ` sub-split). We use the same
# pattern as `DROP_SPLIT_RE` but as a finditer source (not a split source).
FEAT_PAREN_FINDALL_RE = re.compile(
    r'\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)',
    re.IGNORECASE,
)


def artist_components_for_drop_check(artist: str) -> list[str]:
    """Yield every component of `artist` that should be checked against the drop set.

    Includes the original whole string plus every sub-token produced by the
    coarse splitter above. ` of ` member-of-group sub-splitting is SCOPED
    (Fix 1, 2026-05-01) to text captured inside a `(Feat. X)` / `(Prod. X)`
    parenthetical — bare ` of ` outside any feat/prod paren does NOT split,
    matching the TS `splitArtistCollab` contract so legitimate names like
    `Bump of Chicken` round-trip unchanged.

    Empty tokens are dropped; output is deduped while preserving first-seen
    order.
    """
    whole = artist.strip()
    if not whole:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def _add(piece: str) -> None:
        norm = piece.strip()
        if not norm:
            return
        if norm in seen:
            return
        seen.add(norm)
        out.append(norm)

    # 1. The whole input always rounds-trips as the first component.
    _add(whole)

    # 2. Capture every feat/prod parenthetical and emit (a) the inner string
    #    and (b) the inner string sub-split on ` of `. Only inner content gets
    #    the ` of ` sub-split — bare ` of ` at the top level is excluded.
    for inner in FEAT_PAREN_FINDALL_RE.findall(whole):
        inner_trim = inner.strip()
        if not inner_trim:
            continue
        _add(inner_trim)
        if FEAT_INNER_OF_RE.search(inner_trim):
            for sub in FEAT_INNER_OF_RE.split(inner_trim):
                _add(sub)

    # 3. Top-level split on the primary delimiters (no ` of ` here). The split
    #    runs across the original string; feat/prod parens contribute their
    #    captured inner content to the split output (same as the TS source).
    for sub in DROP_SPLIT_RE.split(whole):
        if sub is None:
            continue
        _add(sub)

    return out


def load_drop_keys(sidecar_path: Path) -> set[str]:
    """Load the drop-list JSON sidecar; return a set of normalized keys.

    On any failure (missing file, malformed JSON, schema mismatch) returns an
    empty set and logs a stderr warning — graceful degradation per spec.
    """
    if not sidecar_path.exists():
        print(
            f'WARN: drop-list sidecar not found at {sidecar_path} — '
            'running without the KPOP filter (run `node scripts/export-drop-list.mjs` after building the crawler)',
            file=sys.stderr,
        )
        return set()
    try:
        data = json.loads(sidecar_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        print(f'WARN: failed to read drop-list sidecar {sidecar_path}: {exc}', file=sys.stderr)
        return set()
    keys = data.get('keys')
    if not isinstance(keys, list):
        print(f'WARN: drop-list sidecar at {sidecar_path} missing `keys` array', file=sys.stderr)
        return set()
    # Re-normalize defensively: the TS exporter already pre-normalizes, but a
    # mismatch in normalization rules would silently miss everything.
    return {normalize_for_match(k) for k in keys if isinstance(k, str) and k}


def is_artist_in_drop_list(artist: str, drop_keys: set[str]) -> bool:
    """Return True if any component of `artist` matches the drop set.

    `drop_keys` is the normalized set returned by `load_drop_keys()`. Empty set
    (graceful-degradation case) always returns False — the filter is disabled.
    """
    if not drop_keys:
        return False
    for component in artist_components_for_drop_check(artist):
        key = normalize_for_match(component)
        if key and key in drop_keys:
            return True
    return False
