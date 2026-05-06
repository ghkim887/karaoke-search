"""Stage 1 of title_ko backfill.

Strips TJ-derived katakana→Hangul transliteration `title_ko` values from
records whose `id` starts with `tj-` or `tjpdf-`. Salvages any Korean
parenthetical media-context tag (e.g. `(진격의 거인 OP)`) into the new
`media_context_ko` field. Tags blog records' `title_ko_source` as 'blog'.

Idempotent: re-running on unchanged input produces no diff. Atomic write
via the shared `_atomic_write_corpus` helper from `ingest-anisong-pdf.py`
(indent=2 + trailing newline) so output stays byte-compatible with the
rest of the pipeline.

Spec: docs/superpowers/specs/2026-05-06-title-ko-backfill-design.md.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Optional

# Reuse `_atomic_write_corpus` from the anisong ingest so output formatting
# (indent=2 + trailing newline) matches the rest of the pipeline. Without
# this, a minified write here would produce a ~25k-line diff in CI on the
# next non-Stage-1 step. Importing via importlib because the filename
# contains a hyphen (Python identifier rules).
_HERE = Path(__file__).resolve().parent
_INGEST_PATH = _HERE / 'ingest-anisong-pdf.py'
_spec = importlib.util.spec_from_file_location('ingest_anisong_pdf', _INGEST_PATH)
assert _spec is not None and _spec.loader is not None
_ingest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ingest)
_atomic_write_corpus = _ingest._atomic_write_corpus

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


def process_record(rec: dict) -> dict:
    """Apply Stage 1 rules to a single record. Returns a NEW dict (does
    not mutate input).

    TJ-prefixed records (`id` starts with `tj-` or `tjpdf-`):
      - Salvage media-context paren from title_ko into media_context_ko.
      - Set title_ko = None.
      - Drop pre-existing title_ko_source and title_ko_confidence.

    Blog-prefixed records (`id` starts with `blog-`) with non-empty
    title_ko:
      - Set title_ko_source = 'blog' (provenance only — value unchanged).

    All other records pass through unchanged.
    """
    out = dict(rec)
    rec_id = out.get('id') or ''

    if rec_id.startswith('tj-') or rec_id.startswith('tjpdf-'):
        salvaged = extract_media_context_paren(out.get('title_ko'))
        out['title_ko'] = None
        if salvaged is not None:
            out['media_context_ko'] = salvaged
        out.pop('title_ko_source', None)
        out.pop('title_ko_confidence', None)
    elif rec_id.startswith('blog-') and out.get('title_ko'):
        out['title_ko_source'] = 'blog'

    return out


def main(corpus_path: str) -> dict:
    """Read corpus JSON, apply process_record to every record, write
    back atomically. Returns stats dict for stdout reporting.
    """
    corpus_p = Path(corpus_path)
    records = json.loads(corpus_p.read_text(encoding='utf-8'))

    stats = {'stripped': 0, 'salvaged': 0, 'tagged': 0}
    out_records = []
    for rec in records:
        before_title_ko = rec.get('title_ko')
        before_source = rec.get('title_ko_source')
        new = process_record(rec)
        if before_title_ko and new.get('title_ko') is None:
            stats['stripped'] += 1
        if 'media_context_ko' in new and 'media_context_ko' not in rec:
            stats['salvaged'] += 1
        if new.get('title_ko_source') == 'blog' and before_source != 'blog':
            stats['tagged'] += 1
        out_records.append(new)

    _atomic_write_corpus(corpus_p, out_records)
    return stats


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: python normalize_tj_title_ko.py <songs.json>', file=sys.stderr)
        sys.exit(2)
    s = main(sys.argv[1])
    print(f"stripped: {s['stripped']}, salvaged: {s['salvaged']}, tagged: {s['tagged']}")
