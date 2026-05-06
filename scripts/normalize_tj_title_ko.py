"""Stage 1 of title_ko backfill.

Strips TJ-derived katakana→Hangul transliteration `title_ko` values from
records whose `id` starts with `tj-` or `tjpdf-`. Salvages any Korean
parenthetical media-context tag (e.g. `(진격의 거인 OP)`) into the new
`media_context_ko` field. Tags blog records' `title_ko_source` as 'blog'.

Idempotent: re-running on unchanged input produces no diff. Atomic write
via `<file>.tmp + os.replace`.

Spec: docs/superpowers/specs/2026-05-06-title-ko-backfill-design.md.
"""

from __future__ import annotations

import re
from typing import Optional

# Korean (Hangul Syllables block) detection.
_HANGUL_RE = re.compile(r'[가-힯]')

# Media-context keyword set. Any of these inside a parenthetical alongside
# Hangul classifies that parenthetical as salvageable Korean media context.
_MEDIA_KEYWORDS = ('OST', 'OP', 'ED', '극장판', 'TV', 'OVA', '삽입곡', 'MV', '오프닝', '엔딩')


def extract_media_context_paren(text: Optional[str]) -> Optional[str]:
    """Extract Korean media-context parentheticals from `text`.

    Scans every `(...)` segment. A segment qualifies if it contains
    Hangul AND at least one media keyword (OST/OP/ED/극장판/TV/OVA/삽입곡/
    MV/오프닝/엔딩). When multiple segments qualify, returns them
    concatenated with a single space. Returns None when nothing
    qualifies.
    """
    if not text:
        return None
    matches = []
    for paren_match in re.finditer(r'\([^()]*\)', text):
        segment = paren_match.group(0)
        if not _HANGUL_RE.search(segment):
            continue
        if not any(kw in segment for kw in _MEDIA_KEYWORDS):
            continue
        matches.append(segment)
    if not matches:
        return None
    return ' '.join(matches)
