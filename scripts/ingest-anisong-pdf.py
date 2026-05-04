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

Behavior:
  1. Parses scripts/data/anisong_utf8.txt (pdftotext -table output) and extracts
     (tj_code, title, artist, section).
  2. Drops existing tjpdf-* records from apps/web/public/data/songs.json.
  3. For TJ codes already in the corpus (non-tjpdf-* rows), adds the section
     ('anime' or 'vocaloid') to categories. Mutual-exclusivity rule (priority
     vocaloid > anime > jpop): every record ends with at most one of
     {jpop, vocaloid, anime}. See `_apply_category_exclusivity()` below.
  4. For new TJ codes, inserts a new SongRecord with id 'tjpdf-{code}' and
     categories=[section].

Section detection: the PDF has an in-flow left-column divider that flips the
active section. Pages 1-83 + 96-97 are tagged 'anime' (the latter is tokusatsu,
which the schema collapses into anime). Pages 84-95 (starting at the '1925'
row at L8281 of the cached text, marked by a left-column `보컬로이드,` cell)
are tagged 'vocaloid'. See `_SECTION_DIVIDERS` for the full map.

NOT a recurring crawler — schema-equivalent to a side-channel monthly enrichment.
Run from repo root: `python scripts/ingest-anisong-pdf.py`

Regenerate the source text with:
  pdftotext -table -enc UTF-8 -nopgbrk anisong_2026-02.pdf scripts/data/anisong_utf8.txt
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

# Force stdout/stderr to UTF-8 on Windows so emoji/Hangul/kana in log output
# don't trip cp949. Safe on POSIX (already UTF-8). idempotent.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_TEXT = REPO_ROOT / 'scripts' / 'data' / 'anisong_utf8.txt'
SONGS_JSON = REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'
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

# Section-divider tokens that appear as the LEFT-MOST cell of a record row, marking
# the start of a new categorical section. Map from divider keyword (matched as the
# first non-space token, with optional trailing comma) to the SongRecord category.
#
# Anchors observed in scripts/data/anisong_utf8.txt (TJ Anisong 2026-02 PDF):
#   - L8281: `보컬로이드,       1925   28000  冨田悠斗(とみー/T-POCKET)`
#       → first vocaloid track. The `보컬로이드,` (vocaloid) cell on the same line
#         as `1925` is the in-flow divider — pages 84-95 (vocaloid/utaite/nicodō).
#   - L9732: `특촬물  Alive A Life     28526  松本梨화`
#       → first tokusatsu track (page 96). Tokusatsu / sentai is anime-adjacent
#         live-action — per CLAUDE.md the schema only has jpop/vocaloid/anime, so
#         it maps back to 'anime'.
#
# IMPORTANT: we do NOT use the page-header line `일본 애니메이션 곡 ... 보컬로이드,...`
# as the divider, because page 84's page-header appears at L8178 but page 84's
# initial records (L8180-L8279, Hypnosis Mic) are still anime — only the in-flow
# left-column divider at L8281 is authoritative.
_SECTION_DIVIDERS: dict[str, str] = {
    '보컬로이드': 'vocaloid',
    '특촬물': 'anime',
}

# Regex: leftmost token of a line == one of the divider keywords (with optional
# trailing comma), followed by ≥2 spaces (column gap to title cell). Anchored at
# the start of the original line; the divider must occupy column 0.
_SECTION_DIVIDER_RE = re.compile(
    r'^(보컬로이드|특촬물),?\s{2,}\S'
)


def detect_section_divider(line: str) -> str | None:
    """If `line` starts with a known section divider, return the new category.

    Returns None for non-divider lines. The caller is responsible for using this
    BEFORE record emission so the divider's own row gets tagged with the new
    category (e.g. '1925' itself is the first vocaloid track).
    """
    m = _SECTION_DIVIDER_RE.match(line)
    if not m:
        return None
    keyword = m.group(1)
    return _SECTION_DIVIDERS.get(keyword)


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


def parse_pdf(text_lines: list[str]) -> tuple[list[dict], list[str]]:
    """Walk lines, emit one record per anchor found.

    Title / artist parsing strategy (under `pdftotext -table`):
      - Anchor line splits on the TJ code: prefix=title-area, suffix=artist-area.
      - Title prefix is split on `\\s{4,}` runs (column boundaries under -table).
        We take the LAST non-Hangul-only chunk as title. If the last chunk fuses
        Hangul + non-Hangul (column gap <4 spaces), we split at the transition.
      - Suffix may continue on the next line(s) when the artist wraps. We
        concatenate continuation lines that have no anchor and a meaningful
        indent (~>=25 chars). The wrap-loop tolerates exactly one blank-line
        gap (PDF row spacing artifact, e.g. tjpdf-27708).
      - Korean transliteration: scan the next ~6 lines for up to TWO pure-Hangul lines.
        Split it on `\\s{4,}` runs and column-align chunks to title/artist
        positions on the anchor line — chunk closest to title's column → title_ko;
        chunk closest to artist's column → artist_ko; leftover (anime-name
        column) is discarded.

    Section tracking: we maintain a `current_section` (default 'anime') that flips
    when we encounter an in-flow left-column divider row (see `_SECTION_DIVIDERS`).
    Each emitted record carries its section, used downstream as `categories[0]`.
    """
    records: list[dict] = []
    caveats: list[str] = []

    n = len(text_lines)
    i = 0
    # Default section: anime. Flips to 'vocaloid' at line 8281 (`보컬로이드,...1925`)
    # and back to 'anime' at line 9732 (`특촬물  Alive A Life`).
    current_section: str = 'anime'

    while i < n:
        line = text_lines[i].rstrip('\n')

        if is_boilerplate(line):
            i += 1
            continue

        # Section divider detection BEFORE record emission: the divider row IS
        # the first record of the new section (e.g. '1925' for vocaloid).
        new_section = detect_section_divider(line)
        if new_section is not None:
            current_section = new_section

        anchor = extract_anchor(line)
        if anchor is None:
            i += 1
            continue

        code, code_start, code_end = anchor
        prefix = line[:code_start]
        suffix = line[code_end:]

        # Strip optional ' ★ ' marker and surrounding whitespace at the end of prefix.
        prefix_clean = re.sub(r'\s*★\s*$', ' ', prefix).rstrip()

        # Decide title from prefix.
        # Split into >=4-space runs (column boundaries under -table). Take the LAST
        # non-Hangul-only chunk as title (so anime-name column gets dropped if it's
        # pure Korean).
        #
        # Polish-pass fix (residual 1b — column gap <4 spaces): if the last chunk
        # fuses Hangul + non-Hangul (e.g. `'그리드맨 유니버스 UNION'`), split at
        # the Hangul→non-Hangul transition and use the non-Hangul tail as title.
        # This recovers ~23 records that previously degenerated to title==artist.
        title = ''
        title_col_on_anchor: int | None = None  # column of title in the original line
        chunks = re.split(r'\s{4,}', prefix_clean.strip())
        chunks = [c.strip() for c in chunks if c.strip()]
        title_chunks = [c for c in chunks if not (has_hangul(c) and not has_kana_or_han(c))]
        if title_chunks:
            title = title_chunks[-1]
        else:
            # No pure non-Hangul chunk found. Try splitting the LAST chunk on
            # the Hangul→non-Hangul transition (column gap <4 spaces case).
            if chunks:
                last = chunks[-1]
                if has_hangul(last) and (has_kana_or_han(last) or any(ch.isascii() and ch.isalpha() for ch in last)):
                    _hangul, rest = _split_hangul_transition(last)
                    if rest:
                        title = rest
        # Polish-pass extra fix (residual #1b deeper case): even if we found a
        # title_chunk, if it ITSELF starts with Hangul + non-Hangul fusion
        # (e.g. tjpdf-28354 chunk `'돌아가는 펭귄드럼  少年よ我に帰れ'` with only
        # 2 spaces between anime and title), split it. The Hangul prefix is
        # the anime-name column; the rest is the actual title.
        if title and has_hangul(title) and (has_kana_or_han(title) or any(ch.isascii() and ch.isalpha() for ch in title)):
            _hangul, rest = _split_hangul_transition(title)
            if rest:
                title = rest
        # Capture title's column position on the anchor line for translit alignment.
        if title:
            title_col_on_anchor = _column_position(line, title)

        # Decide artist: the suffix, possibly wrapping to the next line.
        artist = suffix.strip()
        artist_col_on_anchor: int | None = None
        # Estimate the artist's column position: right after the TJ code + spaces.
        artist_match = re.search(r'\S', line[code_end:])
        if artist_match:
            artist_col_on_anchor = code_end + artist_match.start()
        j = i + 1
        wraps = 0
        # Wrap-column threshold: the wrap row's content must start within
        # ARTIST_TOL chars of the artist column on the anchor (defensive guard
        # against pulling in a TITLE wrap row, e.g. `WITHOUT A NAME~` at col 26
        # in tjpdf-28288 vs artist col ~56). If we don't know the artist col,
        # fall back to the legacy >=25 indent threshold.
        ARTIST_WRAP_TOL = 12
        WRAP_THRESHOLD = 25
        # Polish-pass fix (residual #4 — wrap-truncation, e.g. tjpdf-27708):
        # legitimate continuations sometimes appear AFTER a single blank line in
        # the PDF (visual row spacing). Allow exactly ONE blank-line skip.
        blank_skipped = False

        def _find_artist_wrap_chunk(probe: str) -> str | None:
            """Find an artist-wrap chunk on `probe`, or return None.

            Strategy: split the line into chunks separated by `\\s{4,}` runs
            (column boundaries). Among non-anchor, non-boilerplate, non-Hangul
            chunks, return the one whose start column is closest to
            artist_col_on_anchor (within ARTIST_WRAP_TOL). Falls back to a
            single-chunk wrap row when artist_col is unknown.

            Note: a wrap row can contain BOTH a new anime-name cell at col 0
            AND the artist continuation at col ~50 (e.g. tjpdf-28238 L1273:
            `'오버런!  ...  ★  竹達彩奈'`). We pick only the column-aligned chunk.
            """
            if extract_anchor(probe) is not None: return None
            if is_boilerplate(probe): return None
            if not probe.strip(): return None

            # Find chunks with their start columns.
            chunk_positions: list[tuple[int, str]] = []
            for m in re.finditer(r'\S(?:.*?\S)?(?=(?:\s{4,}|$))', probe):
                txt = m.group(0).strip()
                if txt:
                    chunk_positions.append((m.start(), txt))
            if not chunk_positions:
                return None

            # Candidate chunks: skip pure-Hangul (Korean translit/anime-name
            # column on a wrap row), skip ones that look like a new anime-name
            # column (low column position when artist_col is high).
            candidates: list[tuple[int, str]] = []
            for col, txt in chunk_positions:
                if has_hangul(txt) and not has_kana_or_han(txt):
                    continue
                # Drop the leading '★' marker that appears as its own chunk on
                # some wrap rows (e.g. L1273 above contains `★         竹達彩奈`,
                # which splits into ['★', '竹達彩奈']).
                if txt == '★':
                    continue
                # Strip leading '★' if it's fused.
                stripped = re.sub(r'^★\s*', '', txt).strip()
                if not stripped:
                    continue
                candidates.append((col, stripped))
            if not candidates:
                return None

            if artist_col_on_anchor is not None:
                # Pick the chunk closest to artist_col within tolerance.
                best = None
                best_dist = ARTIST_WRAP_TOL + 1
                for col, txt in candidates:
                    dist = abs(col - artist_col_on_anchor)
                    if dist < best_dist:
                        best_dist = dist
                        best = txt
                return best
            else:
                # No artist_col known. Fall back to the legacy threshold logic.
                content_col = len(probe) - len(probe.lstrip())
                if content_col < WRAP_THRESHOLD:
                    return None
                # Use the leftmost candidate as a generic wrap.
                return candidates[0][1]

        while j < n and wraps < 2:
            nxt = text_lines[j].rstrip('\n')
            if not nxt.strip():
                # Tolerate exactly one blank line — only if the NEXT non-blank
                # line yields an artist-wrap chunk (column-aligned). Otherwise stop.
                if blank_skipped:
                    break
                if j + 1 >= n:
                    break
                probe = text_lines[j + 1].rstrip('\n')
                if _find_artist_wrap_chunk(probe) is None:
                    break
                blank_skipped = True
                j += 1  # advance over the blank
                continue
            piece = _find_artist_wrap_chunk(nxt)
            if not piece:
                break
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
            j += 1
            wraps += 1

        # Best-effort Korean transliteration (under -table mode).
        # Scan the next ~6 lines for ONE pure-Hangul line (no kana/han, no
        # anchor). Split that line on `\s{4,}` runs — chunks correspond to
        # column positions on the anchor line. Use column-alignment to assign
        # each chunk to the right field (title_ko vs artist_ko); chunks that
        # align with the anime-name column (left side) are discarded.
        #
        # Polish-pass fixes:
        # - residual #2b: when an anchor's last chunk fused Hangul+title, the
        #   split-helper above produces a title; the translit line's first
        #   Hangul chunk is the anime-name's Korean, NOT title_ko/artist_ko.
        #   Column-alignment correctly drops it.
        # - residual #3a (title_ko coverage): chunks aligned with the title
        #   column become title_ko (was previously dropped at write-time).
        # - window extended from 5 → 6 lines (residual 2c was 0 in sample; harmless).
        title_ko: str | None = None
        artist_ko: str | None = None
        translit_lines: list[str] = []
        # Polish-pass fixes:
        # 1. Skip non-translit interim lines (e.g. title-wrap rows like
        #    `'良いメロン~'` between anchor and translit in tjpdf-28260) — they
        #    sit in the title column and aren't translit, but the translit
        #    appears below them. The previous version broke too early.
        # 2. Allow TWO pure-Hangul translit lines in the window (title_ko on
        #    line 1, artist_ko on line 2 — e.g. tjpdf-68560 / tjpdf-28458).
        for k in range(i + 1, min(i + 7, n)):
            cand = text_lines[k].rstrip('\n')
            stripped_cand = cand.strip()
            if not stripped_cand:
                continue  # blank: keep scanning
            if extract_anchor(cand) is not None:
                break  # next record's anchor: stop
            if is_boilerplate(cand):
                break
            if is_pure_hangul_line(cand):
                translit_lines.append(cand)
                if len(translit_lines) >= 2:
                    break
            else:
                # Non-translit interim line. If we haven't found any translit
                # yet, this is likely a title-wrap row (Japanese, sitting in
                # title column) — keep scanning. If we've already found one
                # translit line, treat this as an interruption.
                if translit_lines:
                    break
                # else: continue scanning

        if translit_lines:
            # Aggregate (col_position, chunk) pairs from all translit lines.
            ko_chunks: list[tuple[int, str]] = []
            for tl in translit_lines:
                # Find runs of non-{4-space} text.
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
        # cell whose text was positioned with column padding). Real song/artist
        # names don't legitimately contain 4+ consecutive spaces.
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
            'section': current_section,
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


def _normalize_for_match(s: str) -> str:
    """Mirror of `normalizeForMatch` in `packages/crawler/src/adapters/
    tj-media-direct/normalize.ts`: strip every whitespace char, lowercase, NFKC.

    Cache keys + drop-list keys are produced by the TS rule; matching by hand
    in Python requires the exact same transform or membership tests miss.
    """
    return unicodedata.normalize('NFKC', re.sub(r'\s+', '', s).lower())


# Mirrors the TS `splitArtistCollab` enough for the drop-list filter to spot
# Korean-act components inside collab strings. Python-side we only need
# membership lookup (no admit-path scoring), so a coarser splitter is fine.
#
# Splits on: ` & `, ` ＆ `, ` × `, ` with `, `,`, `(Feat. X)`,
# `(FEAT. X)`, `(Prod. X)` parentheticals — same primary delimiters the TS
# source is built around.
#
# Note on ` of ` scope (Fix 1, 2026-05-01): bare ` of ` is intentionally
# EXCLUDED from this regex. The TS `splitArtistCollab` only sub-splits ` of `
# inside captured `(Feat. X)` / `(Prod. X)` parenthetical content because the
# bare token is a common English word in real artist names (`Bump of Chicken`,
# `Out of the Blue`, etc.). Cross-language parity: if the TS rule wouldn't
# split it, the Python rule mustn't either. The feat/prod paren capture below
# returns the inner content, which `_artist_components_for_drop_check` then
# re-splits on ` of ` via `_FEAT_INNER_OF_RE` — that's the only place ` of `
# fires.
_DROP_SPLIT_RE = re.compile(
    r'\s*\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)\s*|\s*[&＆,×｜]\s*|\s+with\s+|\s+meets\s+|\s*feat\.\s*',
    re.IGNORECASE,
)

# Inside a captured `(Feat. X)` / `(Prod. X)` group ONLY, ` of ` reliably means
# "member-of-group" (e.g. `(Feat. SUGA of BTS)` → SUGA + BTS). This regex is
# applied to the captured inner string in `_artist_components_for_drop_check`
# — never to the bare top-level artist text.
_FEAT_INNER_OF_RE = re.compile(r'\s+of\s+', re.IGNORECASE)

# Detect feat/prod parentheticals so we can identify which sub-pieces came from
# inside one (only those should get the ` of ` sub-split). We use the same
# pattern as `_DROP_SPLIT_RE` but as a finditer source (not a split source).
_FEAT_PAREN_FINDALL_RE = re.compile(
    r'\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)',
    re.IGNORECASE,
)


def _artist_components_for_drop_check(artist: str) -> list[str]:
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
    for inner in _FEAT_PAREN_FINDALL_RE.findall(whole):
        inner_trim = inner.strip()
        if not inner_trim:
            continue
        _add(inner_trim)
        if _FEAT_INNER_OF_RE.search(inner_trim):
            for sub in _FEAT_INNER_OF_RE.split(inner_trim):
                _add(sub)

    # 3. Top-level split on the primary delimiters (no ` of ` here). The split
    #    runs across the original string; feat/prod parens contribute their
    #    captured inner content to the split output (same as the TS source).
    for sub in _DROP_SPLIT_RE.split(whole):
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
    return {_normalize_for_match(k) for k in keys if isinstance(k, str) and k}


def is_artist_in_drop_list(artist: str, drop_keys: set[str]) -> bool:
    """Return True if any component of `artist` matches the drop set.

    `drop_keys` is the normalized set returned by `load_drop_keys()`. Empty set
    (graceful-degradation case) always returns False — the filter is disabled.
    """
    if not drop_keys:
        return False
    for component in _artist_components_for_drop_check(artist):
        key = _normalize_for_match(component)
        if key and key in drop_keys:
            return True
    return False


# PDF vocaloid-section denylist (Fix 1, 2026-05-04 — see audit memory
# `project_zutomayo_pdf_section_contamination.md` and TODO 1 from the
# 2026-05-03 vocaloid-mistag audit).
#
# Why this exists: the TJ Media anisong PDF's `보컬로이드, 우타이테, 니코동 등`
# section (pages 84-95) is trusted verbatim by `parse_pdf()` — but the section
# actually mixes real Vocaloid producers with non-Vocaloid bands that have
# anime / Nicodō tie-in tracks. The 7 acts below were confirmed by the
# 2026-05-03 audit as PDF-section mistags. When the parser would tag one of
# their tracks `vocaloid`, downgrade the tag to `anime` instead — these acts
# are anime-tied, not Vocaloid producers.
#
# Pattern parallels `koreanArtistDropList.ts`: hand-curated, source-of-truth
# in one place. Python is the only consumer of this list (it never escapes
# the PDF ingest path), so no JSON sidecar is needed.
#
# Membership uses `_artist_components_for_drop_check()` so collab forms hit
# too (e.g. `HoneyWorks(Feat.GUMI)` → component `HoneyWorks` matches even
# when the featured act is a real Vocaloid). This is intentional per spec:
# every PDF-section HoneyWorks row is a human-vocal mistag; legitimate
# HoneyWorks×Vocaloid records reach the corpus via the blog adapter (which
# this filter does NOT touch — blog-path mistags are a separate vector).
#
# IMPLICIT COUPLING: `CHiCOwithHoneyWorks` denylist matching depends on
# `_DROP_SPLIT_RE` containing `\s+meets\s+` so the corpus surface form
# `CHiCO with HoneyWorks meets 中川翔子` decomposes to a `HoneyWorks`
# component that hits this set. Removing the `meets` token from the splitter
# silently breaks the denylist; do not unhook one without the other.
_PDF_VOCALOID_DENYLIST_RAW: tuple[str, ...] = (
    'Gackt',
    'GARNiDELiA',
    'LIP×LIP',
    '三月のパンタシア',
    'Team.ねこかん[猫]',
    'HoneyWorks',
    'CHiCOwithHoneyWorks',
)

# Normalized at module-load time so the hot path is a single set membership
# test per parsed PDF row. Matches `_normalize_for_match` so PDF surface
# forms (`CHiCOwithHoneyWorks`) and corpus surface forms (`CHiCO with
# HoneyWorks`) collapse to the same key.
_PDF_VOCALOID_DENYLIST: frozenset[str] = frozenset(
    _normalize_for_match(name) for name in _PDF_VOCALOID_DENYLIST_RAW
)


def is_artist_in_pdf_vocaloid_denylist(artist: str) -> bool:
    """Return True if any component of `artist` is in the PDF vocaloid denylist.

    Used by `main()` to downgrade `section='vocaloid'` to `section='anime'`
    BEFORE the section value is written into `categories`, so the resulting
    record has `['anime']` and is unaffected by `applyCategoryExclusivity`'s
    `vocaloid > anime` priority.
    """
    if not _PDF_VOCALOID_DENYLIST:  # defensive — empty set means filter off
        return False
    for component in _artist_components_for_drop_check(artist):
        key = _normalize_for_match(component)
        if key and key in _PDF_VOCALOID_DENYLIST:
            return True
    return False


def _apply_category_exclusivity(cats: list[str]) -> list[str]:
    """Apply the v2 category mutual-exclusivity rule: at most one of
    {jpop, vocaloid, anime} per record. Priority: vocaloid > anime > jpop.

    Mirrors `applyCategoryExclusivity` in `packages/schema/src/index.ts` and
    `packages/crawler/src/merge.ts` so this script's output matches what the
    JS pipeline would produce. Returns a new sorted list (does not mutate).

    Examples:
      ['jpop']                       -> ['jpop']      (unchanged)
      ['jpop', 'anime']              -> ['anime']
      ['jpop', 'vocaloid']           -> ['vocaloid']
      ['anime', 'vocaloid']          -> ['vocaloid']  (vocaloid wins)
      ['jpop', 'anime', 'vocaloid']  -> ['vocaloid']
    """
    s = set(cats)
    if 'vocaloid' in s:
        s.discard('anime')
        s.discard('jpop')
    elif 'anime' in s:
        s.discard('jpop')
    return sorted(s)


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

    matched = 0
    already_tagged = 0  # corpus rows that already had the section's tag
    dropped_kpop = 0  # PDF rows skipped because the artist matched the drop list
    vocaloid_downgraded = 0  # rows downgraded from vocaloid->anime by the PDF denylist
    section_counts: dict[str, int] = {'anime': 0, 'vocaloid': 0}
    new_records: list[dict] = []
    title_fallbacks: list[str] = []  # codes where title_primary fell back to artist

    for r in unique:
        code = r['tj']
        section = r.get('section', 'anime')
        if section not in section_counts:
            print(
                f'WARN: unknown section {section!r} for tj={code} — defaulting to anime',
                file=sys.stderr,
            )
            section = 'anime'
        # PDF vocaloid-section denylist (Fix 1, 2026-05-04): the PDF's
        # `보컬로이드,` section header is trusted by parse_pdf(), but the
        # section actually mixes Vocaloid producers with non-Vocaloid bands
        # that have anime/Nicodō tie-in tracks. Downgrade the 7 known
        # mistagged acts to `anime` BEFORE the section value lands in
        # `categories`, so applyCategoryExclusivity's vocaloid>anime priority
        # can't silently re-elevate the tag during a later merge.
        #
        # Track the downgrade flag separately because the matched-existing-row
        # path also needs it: a corpus row that already carries `vocaloid`
        # (from a prior ingest's merge into a tj-* record) must have that
        # stale tag REPLACED with `anime`, not unioned — the union path goes
        # through applyCategoryExclusivity which would re-elevate vocaloid.
        downgrade_triggered = (
            section == 'vocaloid'
            and is_artist_in_pdf_vocaloid_denylist(r['artist'])
        )
        if downgrade_triggered:
            section = 'anime'
            vocaloid_downgraded += 1
        section_counts[section] = section_counts.get(section, 0) + 1
        # Drop-list filter: Korean acts that leak through both the TS adapter's
        # filter chain AND the PDF ingest must be refused at this gate too.
        # Skips both the patch-existing path AND the new-record-insert path so
        # a tjpdf-* never gets created for a known Korean act, AND a corpus
        # row matching such an artist doesn't get re-tagged anime/vocaloid.
        if is_artist_in_drop_list(r['artist'], drop_keys):
            dropped_kpop += 1
            continue
        if code in tj_to_idx:
            rec = corpus[tj_to_idx[code]]
            cats = list(rec.get('categories', []))
            # If we downgraded, strip any pre-existing `vocaloid` tag the row
            # carried in from a prior merge. Without this scrub, the union +
            # applyCategoryExclusivity step below sees `['vocaloid', 'anime']`
            # and the vocaloid>anime priority re-elevates the tag — leaving
            # stale-vocaloid records in the corpus. The downgrade is
            # authoritative for these 7 acts: every PDF-section row of theirs
            # is a non-Vocaloid track, so the prior-merge vocaloid tag was
            # itself sourced from a now-corrected tjpdf-* sibling.
            if downgrade_triggered and 'vocaloid' in cats:
                cats = [c for c in cats if c != 'vocaloid']
            if section in cats:
                already_tagged += 1
            else:
                cats.append(section)
            # Apply v2 mutual-exclusivity rule (priority vocaloid > anime > jpop):
            # records tagged 'vocaloid' lose 'anime' and 'jpop'; records tagged
            # 'anime' lose 'jpop'. See `_apply_category_exclusivity()`.
            rec['categories'] = _apply_category_exclusivity(cats)
            matched += 1
        else:
            # New record. Need non-empty title_primary; fall back to artist if title missing.
            # Track this fallback as a caveat for the report.
            if not r['title']:
                title_fallbacks.append(code)
            title = r['title'] or r['artist']
            artist = r['artist']
            # Preserve the original crawled_at for codes already in the corpus
            # (byte-idempotency: unchanged inputs produce an identical file).
            # Fall back to a fresh timestamp only for genuinely new tj codes.
            crawled_at_for_record = tj_to_old_crawled_at.get(code) or _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')
            new_record = {
                'id': f'tjpdf-{code}',
                'source_url': SOURCE_URL,
                'title_primary': title,
                # title_ko: now populated when the column-aligned translit match
                # produces a chunk for the title column. Polish-pass change —
                # previously we threw it out (set to None) because of mechanical
                # transliteration concerns, but column-aligned chunks are real
                # Korean transliterations from the official PDF and provide
                # meaningful search coverage for the JP→KR side.
                'title_ko': r['title_ko'],
                'artist_primary': artist,
                'artist_ko': r['artist_ko'],
                'karaoke_numbers': {
                    'tj': code,
                    'ky': None,
                    'joysound': None,
                },
                'categories': [section],
                'crawled_at': crawled_at_for_record,
            }
            new_records.append(new_record)

    corpus.extend(new_records)

    # Write back. Match the existing file's encoding/format: UTF-8, no BOM, no
    # ensure_ascii, indent=2 to match the existing pretty-printed file.
    # Atomic publish: write to a sibling .tmp first, then os.replace() onto the
    # final path. Mirrors the TS pipeline's `songs.json.tmp` + rename in
    # `.github/workflows/crawl.yml` so a crash mid-write can never leave a
    # truncated/corrupt songs.json on disk.
    tmp_path = SONGS_JSON.with_suffix(SONGS_JSON.suffix + '.tmp')
    tmp_path.write_text(
        json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    os.replace(tmp_path, SONGS_JSON)

    # Report.
    log_path = REPO_ROOT / '.omc' / 'anisong_ingest_report.txt'
    with open(log_path, 'w', encoding='utf-8') as f:
        f.write(f'Total PDF anchor lines parsed: {len(parsed)}\n')
        f.write(f'Unique TJ codes after dedupe: {len(unique)}\n')
        f.write(f'Validation: artist_spill={artist_spill} title_spill={title_spill} '
                f'title_eq_artist={title_eq_artist} ({title_eq_artist_ratio:.1%})\n')
        f.write(f'Pre-pass dropped existing tjpdf-* rows: {dropped_old_tjpdf}\n')
        f.write(f'Section breakdown (parsed records by category):\n')
        for sect_name in sorted(section_counts.keys()):
            f.write(f'    {sect_name}: {section_counts[sect_name]}\n')
        f.write(f'  Matched existing corpus rows (section tag added or kept): {matched}\n')
        f.write(f'    of which already had the section tag: {already_tagged}\n')
        f.write(f'  New records inserted: {len(new_records)}\n')
        f.write(f'    of which had to fall back title_primary->artist: {len(title_fallbacks)}\n')
        f.write(f'  Dropped (artist matched Korean-artist drop list): {dropped_kpop}\n')
        f.write(f'  Drop-list keys loaded: {len(drop_keys)}\n')
        f.write(f'  Vocaloid->anime downgrades (PDF vocaloid-section denylist): {vocaloid_downgraded}\n')
        f.write(f'Caveats / skipped: {len(caveats)}\n')
        for c in caveats:
            f.write(f'  - {c}\n')
        f.write('\n--- new records sample (first 20) ---\n')
        for nr in new_records[:20]:
            f.write(f'  {nr["karaoke_numbers"]["tj"]}  {nr["title_primary"]!r:40s}  {nr["artist_primary"]!r}\n')

    print(
        f'parsed={len(parsed)} unique={len(unique)} '
        f'dropped_old_tjpdf={dropped_old_tjpdf} matched={matched} '
        f'new={len(new_records)} dropped_kpop={dropped_kpop} '
        f'voc_downgraded={vocaloid_downgraded} '
        f'skipped={len(caveats)}'
    )
    print(f'report: {log_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
