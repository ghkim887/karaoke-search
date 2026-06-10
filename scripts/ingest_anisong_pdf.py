"""One-shot enrichment: ingest TJ Media official anime songbook PDF into songs.json.

NOTE on prior bug (commit f849ce7): an earlier version of this script used
`pdftotext -layout` and a permissive column-split, which let cross-row content
leak into title/artist/translit fields (~30% of tjpdf-* records corrupted).
This rewrite switches to `pdftotext -table` (cleaner column boundaries) and
splits column lines on `\\s{4,}` runs. It also drops the sticky-title fallback
queue (no longer needed under -table) and tightens `is_pure_hangul_line()` as
defense-in-depth. A validation gate in main() asserts the new output is clean
before writing songs.json. The script is now idempotent: it drops existing
tjpdf-* records before merging the freshly-parsed ones in.

Behavior (coverage-only):
  1. Parses scripts/data/anisong_utf8.txt (pdftotext -table output) and extracts
     (tj_code, title, artist).
  2. Drops existing tjpdf-* records from apps/web/public/data/songs.json.
  3. For new TJ codes (absent from the corpus), inserts a new SongRecord with
     id 'tjpdf-{code}'. This is pure corpus coverage — the PDF is the only
     source for ~632 anime/vocaloid karaoke numbers not present in the blog or
     TJ-catalog adapters.

The category/section dimension (jpop/vocaloid/anime) was removed from the
schema, so this script no longer reads PDF section dividers, applies any
section/category tag, or mutates existing corpus rows. PDF codes that already
exist in the corpus are simply skipped.

NOT a recurring crawler — schema-equivalent to a side-channel monthly enrichment.
Run from repo root: `python scripts/ingest_anisong_pdf.py`

Regenerate the source text with:
  pdftotext -table -enc UTF-8 -nopgbrk anisong_2026-02.pdf scripts/data/anisong_utf8.txt
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# Make `scripts/lib/` importable regardless of invocation cwd.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.corpus_io import (  # noqa: E402
    atomic_write_corpus,
    ensure_utf8_stdio,
    iso_utc_now,
)
from lib.artist_split import (  # noqa: E402
    DROP_SPLIT_RE,
    FEAT_INNER_OF_RE,
    FEAT_PAREN_FINDALL_RE,
    artist_components_for_drop_check,
    is_artist_in_drop_list,
    load_drop_keys,
    normalize_for_match,
)

# Force stdout/stderr to UTF-8 at module load (idempotent).
ensure_utf8_stdio()

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_TEXT = REPO_ROOT / 'scripts' / 'data' / 'anisong_utf8.txt'
# KARAOKE_SONGS_JSON: corpus-path override exported by
# scripts/run-post-crawl-pipeline.mjs when its --corpus flag is used, so the
# whole pipeline can be exercised against a copy. Unset in CI/default runs.
SONGS_JSON = (
    Path(os.environ['KARAOKE_SONGS_JSON']).resolve()
    if os.environ.get('KARAOKE_SONGS_JSON')
    else REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'
)
SOURCE_URL = 'https://www.tjmedia.com/support/poster?cate_cd=P06'

# Korean-artist drop-list JSON sidecar produced by `scripts/export-drop-list.mjs`
# (which reads the built TS source). Lives alongside the TS source under
# `packages/crawler/src/...` and is **tracked in git** (Fix 2, 2026-05-01) —
# previously sat under `dist/` which is gitignored, allowing TS-edited-but-
# sidecar-stale scenarios to slip past review. With the sidecar tracked,
# editing the TS without regenerating shows up as a one-of-two-files diff.
# Regeneration is wired into `corepack pnpm --filter @karaoke/crawler build`.
# Treated as graceful-degradation when missing: log a warning, run without the
# filter.
DROP_LIST_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'crawler'
    / 'src'
    / 'adapters'
    / 'tj-media-direct'
    / 'korean-artist-drop-list.json'
)

# Clustering-rules JSON sidecar produced by `scripts/export-clustering-rules.mjs`
# (which reads `SPLIT_RE_SOURCE` / `SPLIT_RE_FLAGS` from the built dist of
# `packages/crawler/src/clustering.ts`). Tracked in git alongside the TS source.
# Treated as graceful-degradation when missing or malformed: fall back to a
# hardcoded copy of the delimiter alternations with a stderr warning.
CLUSTERING_RULES_SIDECAR = (
    REPO_ROOT
    / 'packages'
    / 'crawler'
    / 'src'
    / 'clustering-rules.json'
)

# Anchor: a 4-or-5 digit number not adjacent to other digits or a decimal point.
# (Most codes are 5 digits; ~33 legacy codes are 4 digits like 6479, 6899, 6943.)
# Note: lookbehind also excludes '.' to defend against decimal-like patterns.
_TJ_ANCHOR = re.compile(r'(?<![\d.])(\d{4,5})(?!\d)')

# Used by validation gate in main() and by tightened is_pure_hangul_line().
SPILL_RE = re.compile(r'\S+\s{4,}\S+')

# Numeric floor for accepting an anchor as a real TJ code. Below this we treat
# the match as a false positive (titles with "1000%"/"2000%", index columns,
# years like "1925", etc.). All known-real legacy 4-digit codes (6479, 6899,
# 6943) clear this threshold.
_MIN_TJ_CODE = 5000

# Lines that are pure boilerplate / page furniture and must not produce a record.
_BOILERPLATE_PATTERNS = [
    re.compile(r'^\s*\d{4}\s*년'),                      # '2026년 02월'
    re.compile(r'★ 표시는'),                             # legend
    re.compile(r'반주기에 탑재'),                          # disclaimer
    re.compile(r'^일본 애니메이션 곡'),                    # page header
]

def is_boilerplate(line: str) -> bool:
    return any(p.search(line) for p in _BOILERPLATE_PATTERNS)


def has_kana_or_han(text: str) -> bool:
    """Loose Japanese-script detector (hiragana, katakana, CJK han, halfwidth kana)."""
    for ch in text:
        cp = ord(ch)
        if 0x3040 <= cp <= 0x309F:    # hiragana
            return True
        if 0x30A0 <= cp <= 0x30FF:    # katakana
            return True
        if 0x4E00 <= cp <= 0x9FFF:    # CJK unified ideographs
            return True
        if 0xFF66 <= cp <= 0xFF9F:    # halfwidth katakana
            return True
    return False


def has_hangul(text: str) -> bool:
    for ch in text:
        cp = ord(ch)
        if 0xAC00 <= cp <= 0xD7A3:
            return True
        if 0x1100 <= cp <= 0x11FF:
            return True
        if 0x3130 <= cp <= 0x318F:
            return True
    return False


def is_pure_hangul_line(text: str) -> bool:
    """Pure Hangul: has Hangul, no kana, no Han. Used for Korean translit detection.

    Note (polish-pass change): the previous version of this function rejected
    long lines that contained a `\\s{4,}` run, as a defense against -layout
    cross-column leaks. Under -table mode, column gaps in translit lines are
    LEGITIMATE (they're the boundary between title_ko and artist_ko columns) —
    rejecting them caused us to lose translit for ~340 records that needed
    column-aligned 2-chunk parsing. The kana/han check is a sufficient defense:
    if JP content leaks in, the line is no longer pure Hangul and is rejected.
    """
    s = text.strip()
    if not s:
        return False
    if has_kana_or_han(s):
        return False
    return has_hangul(s)


def extract_anchor(line: str) -> tuple[str, int, int] | None:
    """Find a real TJ anchor on the line.

    Strategy: collect all \\d{4,5} matches that pass the floor (>= _MIN_TJ_CODE),
    then return the RIGHTMOST one. The PDF's column layout always places the
    real TJ code immediately before the artist string, so the rightmost
    qualifying number is the right pick. This filters out title-embedded
    numbers like '1000%' / '2000%' (also caught by the floor) and any index
    columns that happen to clear 5000.
    """
    candidates: list[tuple[str, int, int]] = []
    for m in _TJ_ANCHOR.finditer(line):
        code = m.group(1)
        if int(code) < _MIN_TJ_CODE:
            continue
        candidates.append((code, m.start(), m.end()))
    if not candidates:
        return None
    return candidates[-1]



def _split_hangul_transition(chunk: str) -> tuple[str, str]:
    """Split a chunk on the first Hangul→non-Hangul transition.

    Used for the polish-pass fix to category 1b (column gap <4 spaces): when the
    PDF row joins the anime-name column to the title column with only 1-3 spaces
    (instead of the 4+ that `\\s{4,}` requires), they merge into a single chunk
    like `'그리드맨 유니버스 UNION'`. We split at the boundary so the Hangul
    becomes the anime-name (discarded) and the rest becomes the title.

    Returns (hangul_part, rest). rest is empty if the chunk is pure Hangul.
    """
    # Walk forward through `chunk`. State: we're in Hangul. As soon as we see a
    # non-Hangul, non-space character (Latin/Japanese), split.
    seen_hangul = False
    for idx, ch in enumerate(chunk):
        cp = ord(ch)
        is_hangul_ch = (0xAC00 <= cp <= 0xD7A3) or (0x1100 <= cp <= 0x11FF) or (0x3130 <= cp <= 0x318F)
        if is_hangul_ch:
            seen_hangul = True
            continue
        if ch.isspace():
            continue
        # Non-Hangul, non-space. If we've already seen Hangul, this is the boundary.
        if seen_hangul:
            return chunk[:idx].rstrip(), chunk[idx:].lstrip()
    # No transition found.
    if seen_hangul:
        return chunk.strip(), ''
    return '', chunk.strip()


def _column_position(line: str, substring: str) -> int | None:
    """Find the column index of substring in line, returning None if absent."""
    if not substring:
        return None
    idx = line.find(substring)
    return idx if idx >= 0 else None


_ARTIST_WRAP_TOL = 12
_WRAP_THRESHOLD = 25


def _extract_title_from_prefix(prefix_clean: str) -> tuple[str, int | None]:
    """Parse the anchor-line prefix (title-area) into (title, sort_index).

    Splits on >=4-space runs (column boundaries under pdftotext -table) and
    takes the LAST non-Hangul-only chunk as the title. Handles two residual
    edge cases where the column gap collapses to <4 spaces and the anime-name
    cell fuses into the title chunk:
      - residual #1b: last chunk is pure-Hangul fused with non-Hangul →
        split at transition, take the non-Hangul tail.
      - residual #1b deeper: even a selected title_chunk itself can start with
        Hangul (e.g. tjpdf-28354 `'돌아가는 펭귄드럼  少年よ我に帰れ'`) →
        split again and take the tail.

    The second return value is always None in the current PDF schema (the PDF
    does not encode a sort index in the prefix); it is reserved for forward
    compatibility if a future PDF format adds one.

    Returns ('', None) when no usable title chunk is found.
    """
    title = ''
    chunks = re.split(r'\s{4,}', prefix_clean.strip())
    chunks = [c.strip() for c in chunks if c.strip()]
    title_chunks = [c for c in chunks if not (has_hangul(c) and not has_kana_or_han(c))]
    if title_chunks:
        title = title_chunks[-1]
    else:
        # No pure non-Hangul chunk. Try splitting the LAST chunk at the
        # Hangul→non-Hangul transition (column gap <4 spaces case).
        if chunks:
            last = chunks[-1]
            if has_hangul(last) and (
                has_kana_or_han(last) or any(ch.isascii() and ch.isalpha() for ch in last)
            ):
                _hangul, rest = _split_hangul_transition(last)
                if rest:
                    title = rest

    # Deeper residual #1b: title_chunk itself starts with Hangul+non-Hangul fusion.
    if title and has_hangul(title) and (
        has_kana_or_han(title) or any(ch.isascii() and ch.isalpha() for ch in title)
    ):
        _hangul, rest = _split_hangul_transition(title)
        if rest:
            title = rest

    return title, None


def _find_wrap_chunk(probe: str, artist_col_on_anchor: int | None) -> str | None:
    """Find an artist-wrap chunk on `probe`, or return None.

    Splits `probe` into column-chunks (>=4-space boundaries). Returns the chunk
    whose start column is closest to `artist_col_on_anchor` within
    _ARTIST_WRAP_TOL. Falls back to the leftmost qualifying chunk when
    artist_col is unknown, subject to a _WRAP_THRESHOLD indent guard.

    A wrap row can contain BOTH a new anime-name cell at col 0 AND the artist
    continuation at col ~50 (e.g. tjpdf-28238 L1273: `'오버런!  ...  ★  竹達彩奈'`).
    Pure-Hangul chunks and lone '★' markers are skipped so only the JP/Latin
    artist continuation is returned.
    """
    if extract_anchor(probe) is not None:
        return None
    if is_boilerplate(probe):
        return None
    if not probe.strip():
        return None

    chunk_positions: list[tuple[int, str]] = []
    for m in re.finditer(r'\S(?:.*?\S)?(?=(?:\s{4,}|$))', probe):
        txt = m.group(0).strip()
        if txt:
            chunk_positions.append((m.start(), txt))
    if not chunk_positions:
        return None

    candidates: list[tuple[int, str]] = []
    for col, txt in chunk_positions:
        if has_hangul(txt) and not has_kana_or_han(txt):
            continue
        if txt == '★':
            continue
        stripped = re.sub(r'^★\s*', '', txt).strip()
        if not stripped:
            continue
        candidates.append((col, stripped))
    if not candidates:
        return None

    if artist_col_on_anchor is not None:
        best: str | None = None
        best_dist = _ARTIST_WRAP_TOL + 1
        for col, txt in candidates:
            dist = abs(col - artist_col_on_anchor)
            if dist < best_dist:
                best_dist = dist
                best = txt
        return best
    else:
        # No known artist column — use legacy indent threshold.
        content_col = len(probe) - len(probe.lstrip())
        if content_col < _WRAP_THRESHOLD:
            return None
        return candidates[0][1]


def _collect_artist_wraps(
    text_lines: list[str],
    i: int,
    artist_col_on_anchor: int | None,
) -> tuple[list[str], int]:
    """Collect wrapped artist-name lines starting immediately after anchor line i.

    Scans forward from i+1, collecting continuation chunks. Tolerates exactly
    one blank-line gap (PDF row-spacing artifact, e.g. tjpdf-27708). Stops
    after 2 wraps or on anchor/boilerplate/non-wrap lines.

    Returns (pieces, new_j): `pieces` is the list of wrap chunks to append to
    the anchor suffix; `new_j` is the index of the first unconsumed line.
    Spacing between pieces is handled by the caller because it depends on
    whether both adjacent segments are Latin (see parse_pdf).

    `artist_col_on_anchor` was previously captured by the nested
    `_find_artist_wrap_chunk` closure; it is now an explicit parameter so this
    function is pure (no outer-scope capture).
    """
    n = len(text_lines)
    j = i + 1
    wraps = 0
    blank_skipped = False
    pieces: list[str] = []

    while j < n and wraps < 2:
        nxt = text_lines[j].rstrip('\n')
        if not nxt.strip():
            if blank_skipped:
                break
            if j + 1 >= n:
                break
            probe = text_lines[j + 1].rstrip('\n')
            if _find_wrap_chunk(probe, artist_col_on_anchor) is None:
                break
            blank_skipped = True
            j += 1
            continue
        piece = _find_wrap_chunk(nxt, artist_col_on_anchor)
        if not piece:
            break
        pieces.append(piece)
        j += 1
        wraps += 1

    return pieces, j


def _collect_translit_lines(text_lines: list[str], i: int, n: int) -> list[str]:
    """Scan up to 6 lines after anchor line i for pure-Hangul transliteration lines.

    Returns a list of 0, 1, or 2 raw lines (with trailing newline stripped by
    the caller). Stops early on the next anchor, boilerplate, or a second
    non-translit non-blank line after a translit line has already been found.

    The window is i+1..i+6 (inclusive). Two translit lines are allowed because
    some records split title_ko and artist_ko onto separate lines (e.g.
    tjpdf-68560 / tjpdf-28458). Non-translit interim lines (e.g. a JP title-wrap
    row like `'良いメロン~'` in tjpdf-28260) are skipped only when no translit has
    been found yet.
    """
    translit_lines: list[str] = []
    for k in range(i + 1, min(i + 7, n)):
        cand = text_lines[k].rstrip('\n')
        if not cand.strip():
            continue
        if extract_anchor(cand) is not None:
            break
        if is_boilerplate(cand):
            break
        if is_pure_hangul_line(cand):
            translit_lines.append(cand)
            if len(translit_lines) >= 2:
                break
        else:
            if translit_lines:
                break
    return translit_lines


def parse_pdf(text_lines: list[str]) -> tuple[list[dict], list[str]]:
    """Walk lines, emit one record per anchor found.

    Title / artist parsing strategy (under `pdftotext -table`):
      - Anchor line splits on the TJ code: prefix=title-area, suffix=artist-area.
      - Title is extracted from prefix via `_extract_title_from_prefix`.
      - Artist suffix may wrap to the next line(s); collected by `_collect_artist_wraps`.
      - Korean transliteration lines are collected by `_collect_translit_lines` and
        column-aligned to title/artist positions by `_assign_translit`.

    Coverage-only: the category/section dimension was removed from the schema,
    so `parse_pdf` no longer tracks PDF section dividers. Emitted records carry
    only (tj, title, artist, title_ko, artist_ko, source_line).
    """
    records: list[dict] = []
    caveats: list[str] = []

    n = len(text_lines)
    i = 0

    while i < n:
        line = text_lines[i].rstrip('\n')

        if is_boilerplate(line):
            i += 1
            continue

        anchor = extract_anchor(line)
        if anchor is None:
            i += 1
            continue

        code, code_start, code_end = anchor
        prefix = line[:code_start]
        suffix = line[code_end:]

        # Strip optional ' ★ ' marker and surrounding whitespace at the end of prefix.
        prefix_clean = re.sub(r'\s*★\s*$', ' ', prefix).rstrip()

        title, _sort_index = _extract_title_from_prefix(prefix_clean)
        title_col_on_anchor: int | None = _column_position(line, title) if title else None

        # Estimate the artist's column position: right after the TJ code + spaces.
        artist = suffix.strip()
        artist_col_on_anchor: int | None = None
        artist_match = re.search(r'\S', line[code_end:])
        if artist_match:
            artist_col_on_anchor = code_end + artist_match.start()

        wrap_pieces, j = _collect_artist_wraps(text_lines, i, artist_col_on_anchor)
        for piece in wrap_pieces:
            # Insert a space when joining two Latin segments — pdftotext -table
            # discards leading column whitespace, so `'Fear, and Loathing'` +
            # `'in Las Vegas'` would otherwise concatenate to `'Loathingin Las'`
            # (residual #4 / 27708). Skip the space for JP-script joins where
            # the visual-wrap is mid-word (e.g. tjpdf-28354).
            if (artist and artist[-1].isascii() and artist[-1].isalpha()
                    and piece[0].isascii() and piece[0].isalpha()):
                artist += ' ' + piece
            else:
                artist += piece

        title_ko: str | None = None
        artist_ko: str | None = None
        translit_lines = _collect_translit_lines(text_lines, i, n)
        if translit_lines:
            ko_chunks: list[tuple[int, str]] = []
            for tl in translit_lines:
                for m in re.finditer(r'\S(?:.*?\S)?(?=(?:\s{4,}|$))', tl):
                    piece = m.group(0).strip()
                    if piece:
                        ko_chunks.append((m.start(), piece))
            if ko_chunks:
                title_ko, artist_ko = _assign_translit(
                    ko_chunks, title_col_on_anchor, artist_col_on_anchor, title, artist
                )

        # Collapse internal whitespace runs to single spaces. PDF -table mode
        # can leave wide intra-cell padding (e.g. 'Division          All' is one
        # cell whose text was positioned with column padding).
        title = re.sub(r'\s+', ' ', title).strip()
        artist = re.sub(r'\s+', ' ', artist).strip()
        if title_ko:
            title_ko = re.sub(r'\s+', ' ', title_ko).strip() or None
        if artist_ko:
            artist_ko = re.sub(r'\s+', ' ', artist_ko).strip() or None

        # Sanity: artist must be non-empty for a usable record. Title may legitimately
        # be empty in this PDF (some songs share a title across rows). When title is
        # empty we still emit a record but mark a caveat — for matched corpus rows
        # this is harmless (we keep corpus title); for NEW rows we'll use
        # title=artist as a degenerate placeholder so the record validates.
        if not artist:
            caveats.append(f'L{i}: empty artist for code {code} — skipped')
            i += 1
            continue

        records.append({
            'tj': code,
            'title': title,
            'artist': artist,
            'title_ko': title_ko,
            'artist_ko': artist_ko,
            'source_line': i,
        })

        # Advance past the lines we consumed for artist-wrap.
        i = max(i + 1, j)

    return records, caveats


def _assign_translit(
    ko_chunks: list[tuple[int, str]],
    title_col: int | None,
    artist_col: int | None,
    title: str,
    artist: str,
) -> tuple[str | None, str | None]:
    """Assign translit chunks to (title_ko, artist_ko) using column alignment.

    `ko_chunks` is a list of (column_start, text) pairs from one or more
    pure-Hangul lines.

    Polish-pass guard: only assign title_ko when the primary title contains
    Japanese script (kana/han); only assign artist_ko when the primary artist
    contains Japanese script. Latin-only fields don't have meaningful Korean
    transliterations from this PDF, and a Hangul chunk that LOOKS aligned with
    a Latin field is almost always an anime-name column leak (e.g. tjpdf-28092
    where `오즈마` is the second line of the anime name `마츠모토레이지 오즈마`,
    not a translit of `Neverland`).

    Strategy:
      - For each target column (title, artist), pick the chunk whose start
        column is closest, within a tolerance. Tolerance is generous (12 chars)
        because translit lengths shift kana/han text leftward.
      - Each chunk gets used at most once.
      - If a chunk's column position is < (title_col - TOL), treat as anime
        continuation; drop it.
      - Skip the title_ko assignment entirely when title is Latin-only; same
        for artist_ko.
    """
    title_ko: str | None = None
    artist_ko: str | None = None

    # Tolerance: titles can shift L/R when JP→KR translit length differs.
    TOL = 12

    title_needs_translit = bool(title) and has_kana_or_han(title)
    artist_needs_translit = bool(artist) and has_kana_or_han(artist)

    used: set[int] = set()
    candidates = list(ko_chunks)

    # First pass: drop chunks clearly in the anime-name column (left of title).
    filtered: list[tuple[int, str]] = []
    for col, txt in candidates:
        if title_col is not None and title_col > 5 and col < (title_col - TOL):
            continue
        filtered.append((col, txt))
    if not filtered and candidates:
        filtered = candidates

    # Match title (only if title needs translit).
    if title_needs_translit and title_col is not None and filtered:
        best = None
        best_dist = TOL + 1
        for idx, (col, txt) in enumerate(filtered):
            if idx in used:
                continue
            dist = abs(col - title_col)
            if dist < best_dist:
                best_dist = dist
                best = idx
        if best is not None:
            title_ko = filtered[best][1]
            used.add(best)

    # Match artist (only if artist needs translit).
    if artist_needs_translit and artist_col is not None and filtered:
        best = None
        best_dist = TOL + 1
        for idx, (col, txt) in enumerate(filtered):
            if idx in used:
                continue
            dist = abs(col - artist_col)
            if dist < best_dist:
                best_dist = dist
                best = idx
        if best is not None:
            artist_ko = filtered[best][1]
            used.add(best)

    # Fallback: if column-match failed for a field that needs translit but
    # remaining chunks exist, do positional assignment.
    if title_ko is None and artist_ko is None and filtered:
        if title_needs_translit and artist_needs_translit and len(filtered) >= 2:
            title_ko = filtered[0][1]
            artist_ko = filtered[1][1]
        elif len(filtered) >= 1:
            single = filtered[0][1]
            if title_needs_translit and not artist_needs_translit:
                title_ko = single
            elif artist_needs_translit and not title_needs_translit:
                artist_ko = single
            elif title_needs_translit and artist_needs_translit:
                # Both need it but only one chunk: heuristic length pick.
                if title and artist and len(title) < len(artist):
                    title_ko = single
                else:
                    artist_ko = single

    return title_ko, artist_ko


def main() -> int:
    if not PDF_TEXT.exists():
        print(f'ERROR: missing {PDF_TEXT}', file=sys.stderr)
        return 2
    if not SONGS_JSON.exists():
        print(f'ERROR: missing {SONGS_JSON}', file=sys.stderr)
        return 2

    with open(PDF_TEXT, encoding='utf-8') as f:
        text_lines = f.readlines()

    parsed, caveats = parse_pdf(text_lines)

    # Dedupe by TJ code: PDF can list a code twice across pages. Keep the first.
    seen: set[str] = set()
    unique: list[dict] = []
    for r in parsed:
        if r['tj'] in seen:
            continue
        seen.add(r['tj'])
        unique.append(r)

    # Validation gate: assert the parser output is clean. Failures here mean
    # the parser is regressing (column-spillover or degenerate title==artist).
    artist_spill = sum(1 for r in unique if r['artist'] and SPILL_RE.search(r['artist']))
    title_spill = sum(1 for r in unique if r['title'] and SPILL_RE.search(r['title']))
    title_eq_artist = sum(1 for r in unique if r['title'] and r['title'] == r['artist'])
    title_eq_artist_ratio = title_eq_artist / max(len(unique), 1)
    if artist_spill > 0:
        raise SystemExit(f'validation failed: {artist_spill} records with column spillover in artist field')
    if title_spill > 0:
        raise SystemExit(f'validation failed: {title_spill} records with column spillover in title field')
    if title_eq_artist_ratio >= 0.05:
        raise SystemExit(
            f'validation failed: {title_eq_artist}/{len(unique)} '
            f'({title_eq_artist_ratio:.1%}) records have title == artist (>=5%)'
        )

    with open(SONGS_JSON, encoding='utf-8') as f:
        corpus = json.load(f)

    # Harvest crawled_at timestamps from existing tjpdf-* rows BEFORE the
    # pre-pass drops them. This preserves byte-idempotency: re-running the
    # script on an unchanged PDF produces a byte-identical songs.json because
    # each record gets back its original ingest timestamp rather than a fresh
    # datetime.now() value.
    tj_to_old_crawled_at: dict[str, str] = {
        r['karaoke_numbers']['tj']: r['crawled_at']
        for r in corpus
        if str(r.get('id', '')).startswith('tjpdf-')
        and r.get('karaoke_numbers', {}).get('tj')
        and r.get('crawled_at')
    }
    # Harvest artist_aliases + artist_primary from existing tjpdf-* rows
    # alongside crawled_at (same idempotency rationale: the new-record-insert
    # path below otherwise drops the alias list every run). artist_primary is
    # retained so the re-insert path can detect a semantic artist change and
    # decline to forward stale aliases.
    tj_to_old_aliases: dict[str, list[str]] = {
        r['karaoke_numbers']['tj']: list(r['artist_aliases'])
        for r in corpus
        if str(r.get('id', '')).startswith('tjpdf-')
        and r.get('karaoke_numbers', {}).get('tj')
        and isinstance(r.get('artist_aliases'), list)
        and r['artist_aliases']
    }
    tj_to_old_artist_primary: dict[str, str] = {
        r['karaoke_numbers']['tj']: r['artist_primary']
        for r in corpus
        if str(r.get('id', '')).startswith('tjpdf-')
        and r.get('karaoke_numbers', {}).get('tj')
        and r.get('artist_primary')
    }

    # Idempotent pre-pass: drop any existing tjpdf-* records so re-running the
    # script always produces the same final corpus instead of accumulating.
    dropped_old_tjpdf = 0
    new_corpus: list[dict] = []
    for rec in corpus:
        if str(rec.get('id', '')).startswith('tjpdf-'):
            dropped_old_tjpdf += 1
            continue
        new_corpus.append(rec)
    corpus = new_corpus

    # Build TJ -> record-index map for the corpus.
    tj_to_idx: dict[str, int] = {}
    for idx, rec in enumerate(corpus):
        tj = rec.get('karaoke_numbers', {}).get('tj')
        if tj:
            tj_to_idx[tj] = idx

    # Load the drop-list sidecar (graceful degradation if missing/malformed).
    drop_keys = load_drop_keys(DROP_LIST_SIDECAR)

    already_in_corpus = 0  # PDF codes already present (skipped — coverage-only)
    dropped_kpop = 0  # PDF rows skipped because the artist matched the drop list
    new_records: list[dict] = []
    title_fallbacks: list[str] = []  # codes where title_primary fell back to artist

    for r in unique:
        code = r['tj']
        # Coverage-only: codes already present in the corpus are left untouched
        # (no category/section dimension remains to mutate). Only brand-new
        # codes are inserted.
        if code in tj_to_idx:
            already_in_corpus += 1
            continue
        # Drop-list filter: Korean acts that leak through both the TS adapter's
        # filter chain AND the PDF ingest must be refused at this gate too, so a
        # tjpdf-* never gets created for a known Korean act.
        if is_artist_in_drop_list(r['artist'], drop_keys):
            dropped_kpop += 1
            continue
        # New record. Need non-empty title_primary; fall back to artist if title missing.
        # Track this fallback as a caveat for the report.
        if not r['title']:
            title_fallbacks.append(code)
        title = r['title'] or r['artist']
        artist = r['artist']
        # Preserve the original crawled_at for codes already seen in a prior
        # tjpdf-* row (byte-idempotency: unchanged inputs produce an identical
        # file). Fall back to a fresh timestamp only for genuinely new tj codes.
        crawled_at_for_record = tj_to_old_crawled_at.get(code) or iso_utc_now()
        # Preserve artist_aliases from the prior tjpdf-* row when the artist
        # identity is unchanged. The pre-pass drops the old row, so without
        # this carry-forward every pipeline run silently strips aliases from
        # tjpdf-* records (byte-instability + data loss). We compare on
        # `normalize_for_match` of the canonical artist string so trivial
        # surface differences (case, whitespace, full-width/ASCII variants)
        # don't trigger a false-positive drop; if the PDF emits a genuinely
        # different artist we decline to forward potentially-stale aliases.
        preserved_aliases = tj_to_old_aliases.get(code)
        if preserved_aliases is not None:
            prior_artist = tj_to_old_artist_primary.get(code, '')
            if normalize_for_match(prior_artist) != normalize_for_match(artist):
                preserved_aliases = None
        new_record: dict = {
            'id': f'tjpdf-{code}',
            'source_url': SOURCE_URL,
            'title_primary': title,
            # title_ko: populated when the column-aligned translit match produces
            # a chunk for the title column — real Korean transliterations from the
            # official PDF that provide meaningful JP→KR search coverage.
            'title_ko': r['title_ko'],
            'artist_primary': artist,
            'artist_ko': r['artist_ko'],
        }
        # Inject artist_aliases at the canonical position (after artist_ko,
        # before karaoke_numbers — matches the merger's emission order in
        # packages/crawler/src/merge.ts and the alias-resolver output).
        if preserved_aliases:
            new_record['artist_aliases'] = preserved_aliases
        new_record.update({
            'karaoke_numbers': {
                'tj': code,
                'ky': None,
                'joysound': None,
            },
            'crawled_at': crawled_at_for_record,
        })
        new_records.append(new_record)

    corpus.extend(new_records)

    # Write back via shared atomic-write helper (UTF-8, no BOM, no ensure_ascii,
    # indent=2 + trailing newline to match the existing on-disk pretty-printed
    # shape). Helper writes to `<path>.tmp` and `os.replace()`s onto the final
    # path so a crash mid-write can never leave a truncated/corrupt songs.json.
    atomic_write_corpus(SONGS_JSON, corpus)

    # Report.
    log_path = REPO_ROOT / '.omc' / 'anisong_ingest_report.txt'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, 'w', encoding='utf-8') as f:
        f.write(f'Total PDF anchor lines parsed: {len(parsed)}\n')
        f.write(f'Unique TJ codes after dedupe: {len(unique)}\n')
        f.write(f'Validation: artist_spill={artist_spill} title_spill={title_spill} '
                f'title_eq_artist={title_eq_artist} ({title_eq_artist_ratio:.1%})\n')
        f.write(f'Pre-pass dropped existing tjpdf-* rows: {dropped_old_tjpdf}\n')
        f.write(f'  PDF codes already in corpus (skipped — coverage-only): {already_in_corpus}\n')
        f.write(f'  New records inserted: {len(new_records)}\n')
        f.write(f'    of which had to fall back title_primary->artist: {len(title_fallbacks)}\n')
        f.write(f'  Dropped (artist matched Korean-artist drop list): {dropped_kpop}\n')
        f.write(f'  Drop-list keys loaded: {len(drop_keys)}\n')
        f.write(f'Caveats / skipped: {len(caveats)}\n')
        for c in caveats:
            f.write(f'  - {c}\n')
        f.write('\n--- new records sample (first 20) ---\n')
        for nr in new_records[:20]:
            f.write(f'  {nr["karaoke_numbers"]["tj"]}  {nr["title_primary"]!r:40s}  {nr["artist_primary"]!r}\n')

    print(
        f'parsed={len(parsed)} unique={len(unique)} '
        f'dropped_old_tjpdf={dropped_old_tjpdf} '
        f'already_in_corpus={already_in_corpus} '
        f'new={len(new_records)} dropped_kpop={dropped_kpop} '
        f'skipped={len(caveats)}'
    )
    print(f'report: {log_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
