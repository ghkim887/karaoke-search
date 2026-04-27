"""One-shot enrichment: ingest TJ Media official anime songbook PDF into songs.json.

Behavior:
  1. Parses /tmp/anisong_utf8.txt (pdftotext -layout output) and extracts (tj_code, title, artist).
  2. For TJ codes already in apps/web/public/data/songs.json, adds 'anime' to categories.
  3. For new TJ codes, inserts a new SongRecord with id 'tjpdf-{code}'.

NOT a recurring crawler — schema-equivalent to a side-channel monthly enrichment.
Run from repo root: `python scripts/ingest-anisong-pdf.py`
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_TEXT = REPO_ROOT / '.omc' / 'anisong_utf8.txt'
SONGS_JSON = REPO_ROOT / 'apps' / 'web' / 'public' / 'data' / 'songs.json'
SOURCE_URL = 'https://www.tjmedia.com/support/poster?cate_cd=P06'

# Anchor: a 4-or-5 digit number not adjacent to other digits or a decimal point.
# (Most codes are 5 digits; ~33 legacy codes are 4 digits like 6479, 6899, 6943.)
# Note: lookbehind also excludes '.' to defend against decimal-like patterns.
_TJ_ANCHOR = re.compile(r'(?<![\d.])(\d{4,5})(?!\d)')

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
    """Pure Hangul: has Hangul, no kana, no Han. Used for Korean translit detection."""
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


def is_anime_section_header(line: str) -> bool:
    """A column-0 (no leading whitespace) non-empty line is the anime-name
    column starting a new section. Used to clear the sticky-title queue
    only at section boundaries. We exclude lines that look like our own
    boilerplate already filtered upstream."""
    if not line:
        return False
    if line[0] in (' ', '\t'):
        return False
    s = line.strip()
    if not s:
        return False
    # The anime-name column lines we see are pure-Korean (e.g. "보컬로이드,"
    # or "마법선생 네기마"), or at minimum NOT starting with kana/Latin in
    # the rare mixed case. A simple "starts at column 0 and non-empty" is
    # a sufficient proxy for "new section" given the layout.
    return True


def parse_pdf(text_lines: list[str]) -> tuple[list[dict], list[str]]:
    """Walk lines, emit one record per anchor found.

    Title / artist parsing strategy:
      - Anchor line splits on the TJ code: prefix=title-area, suffix=artist-area.
      - Title prefix is stripped of leading whitespace AND a leading anime-name
        column. We split the prefix into whitespace-runs and take the rightmost
        non-Hangul-only chunk; if empty, we fall back to a sticky-title queue
        populated from preceding non-anchor lines that look like title-only rows.
      - Suffix may continue on the next line(s) when the artist wraps. We
        concatenate continuation lines that have no anchor and a meaningful
        indent (~>=25 chars).
      - Korean transliteration of artist is the next non-empty Hangul-only line
        after the anchor (best-effort).
    """
    records: list[dict] = []
    caveats: list[str] = []

    n = len(text_lines)
    i = 0
    # Sticky-title queue (FILO): non-anchor lines that look like title-only
    # rows (no anchor, has kana/han or Latin, indent >= 10). Cleared only when
    # we hit a section boundary (column-0 anime-name line). Anchors that find
    # no title on their own line pop the most recent entry from the queue.
    sticky_titles: list[str] = []

    while i < n:
        line = text_lines[i].rstrip('\n')

        if is_boilerplate(line):
            i += 1
            continue

        anchor = extract_anchor(line)
        if anchor is None:
            stripped = line.strip()
            if stripped:
                lead = len(line) - len(line.lstrip())
                if lead == 0:
                    # Column-0 line = new anime section. Clear sticky queue.
                    sticky_titles.clear()
                # Title-only candidate: indented (title column starts ~14+),
                # NOT pure Hangul (those are Korean translits), and not too long.
                # Latin-only "NO GIRL NO CRY" or kana "ツナグ、ソラモヨウ" both qualify.
                if lead >= 10 and len(stripped) < 80 and not (has_hangul(stripped) and not has_kana_or_han(stripped)):
                    sticky_titles.append(stripped)
            i += 1
            continue

        code, code_start, code_end = anchor
        prefix = line[:code_start]
        suffix = line[code_end:]

        # Strip optional ' ★ ' marker and surrounding whitespace at the end of prefix.
        prefix_clean = re.sub(r'\s*★\s*$', ' ', prefix).rstrip()

        # Decide title from prefix:
        # Split into >=2-space runs (column boundaries). Take the LAST non-Hangul-only
        # chunk as title (so anime-name column gets dropped if it's pure Korean).
        title = ''
        chunks = re.split(r'\s{2,}', prefix_clean.strip())
        chunks = [c.strip() for c in chunks if c.strip()]
        # Filter: drop chunks that are pure Hangul (anime-name column).
        title_chunks = [c for c in chunks if not (has_hangul(c) and not has_kana_or_han(c))]
        if title_chunks:
            title = title_chunks[-1]
            # Title was on the anchor line itself; do NOT touch the queue.
            # Following anchors may still want carried-over titles.
        elif sticky_titles:
            # Empty title on the anchor line — pop the most recent sticky title (FILO).
            title = sticky_titles.pop()
        else:
            title = ''

        # Decide artist: the suffix, possibly wrapping to the next line.
        artist = suffix.strip()
        j = i + 1
        wraps = 0
        # Threshold tuned to PDF: artist continuations sit roughly in the artist
        # column (>=25 chars of indent — see L92 'lent Siren' lead=31).
        WRAP_THRESHOLD = 25
        while j < n and wraps < 2:
            nxt = text_lines[j].rstrip('\n')
            if not nxt.strip():
                break
            if extract_anchor(nxt) is not None:
                break
            if is_boilerplate(nxt):
                break
            lead = len(nxt) - len(nxt.lstrip())
            if lead < WRAP_THRESHOLD:
                break
            piece = nxt.strip()
            # Stop if it's pure Hangul (Korean translit, not artist tail).
            if has_hangul(piece) and not has_kana_or_han(piece):
                break
            artist += piece
            j += 1
            wraps += 1

        # Best-effort Korean transliteration: scan the next ~6 lines for
        # pure-Hangul lines (no kana/han, no anchor). Indent windows are
        # dropped because the PDF wraps them widely. The FIRST pure-Hangul
        # line is the title translit, the SECOND is the artist translit
        # (left-to-right reading order; title appears first).
        hangul_lines: list[str] = []
        for k in range(i + 1, min(i + 7, n)):
            cand = text_lines[k].rstrip('\n')
            stripped_cand = cand.strip()
            if not stripped_cand:
                continue
            if extract_anchor(cand) is not None:
                break
            if is_boilerplate(cand):
                break
            if is_pure_hangul_line(stripped_cand):
                hangul_lines.append(stripped_cand)

        title_ko: str | None = None
        artist_ko: str | None = None
        if len(hangul_lines) >= 2:
            title_ko = hangul_lines[0]
            artist_ko = hangul_lines[1]
        elif len(hangul_lines) == 1:
            # Single Hangul line — assign to the field "more likely missing".
            # Heuristic: the field with the SHORTER primary string is more
            # likely to be a stub that needs translit. Default to artist_ko
            # (artist names are more often non-Latin and need translit).
            single = hangul_lines[0]
            if title and artist and len(title) < len(artist):
                title_ko = single
            else:
                artist_ko = single

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

        # Advance past the lines we consumed for artist-wrap so they don't get
        # re-classified as sticky titles for the next anchor.
        i = max(i + 1, j)

    return records, caveats


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

    with open(SONGS_JSON, encoding='utf-8') as f:
        corpus = json.load(f)

    # Build TJ -> record-index map for the corpus.
    tj_to_idx: dict[str, int] = {}
    for idx, rec in enumerate(corpus):
        tj = rec.get('karaoke_numbers', {}).get('tj')
        if tj:
            tj_to_idx[tj] = idx

    matched = 0
    already_anime = 0
    new_records: list[dict] = []
    title_fallbacks: list[str] = []  # codes where title_primary fell back to artist
    crawled_at = _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{_dt.datetime.now(_dt.timezone.utc).microsecond // 1000:03d}Z'

    for r in unique:
        code = r['tj']
        if code in tj_to_idx:
            rec = corpus[tj_to_idx[code]]
            cats = list(rec.get('categories', []))
            if 'anime' in cats:
                already_anime += 1
            else:
                cats.append('anime')
            # Deterministic sort.
            cats = sorted(set(cats))
            rec['categories'] = cats
            matched += 1
        else:
            # New record. Need non-empty title_primary; fall back to artist if title missing.
            # Track this fallback as a caveat for the report.
            if not r['title']:
                title_fallbacks.append(code)
            title = r['title'] or r['artist']
            artist = r['artist']
            new_record = {
                'id': f'tjpdf-{code}',
                'source_url': SOURCE_URL,
                'title_primary': title,
                # title_ko skipped — PDF gives mechanical transliterations, not useful for search
                'title_ko': None,
                'artist_primary': artist,
                'artist_ko': r['artist_ko'],
                'release_year': None,
                'karaoke_numbers': {
                    'tj': code,
                    'ky': None,
                    'joysound': None,
                },
                'categories': ['anime'],
                'crawled_at': crawled_at,
            }
            new_records.append(new_record)

    corpus.extend(new_records)

    # Write back. Match the existing file's encoding/format: UTF-8, no BOM, no
    # ensure_ascii, indent=2 to match the existing pretty-printed file.
    # Probe the existing file for indent style.
    SONGS_JSON.write_text(
        json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )

    # Report.
    log_path = REPO_ROOT / '.omc' / 'anisong_ingest_report.txt'
    with open(log_path, 'w', encoding='utf-8') as f:
        f.write(f'Total PDF anchor lines parsed: {len(parsed)}\n')
        f.write(f'Unique TJ codes after dedupe: {len(unique)}\n')
        f.write(f'  Matched existing corpus rows (anime tag added or kept): {matched}\n')
        f.write(f'    of which already had anime: {already_anime}\n')
        f.write(f'  New records inserted: {len(new_records)}\n')
        f.write(f'    of which had to fall back title_primary->artist: {len(title_fallbacks)}\n')
        f.write(f'Caveats / skipped: {len(caveats)}\n')
        for c in caveats:
            f.write(f'  - {c}\n')
        f.write('\n--- new records sample (first 20) ---\n')
        for nr in new_records[:20]:
            f.write(f'  {nr["karaoke_numbers"]["tj"]}  {nr["title_primary"]!r:40s}  {nr["artist_primary"]!r}\n')

    print(f'parsed={len(parsed)} unique={len(unique)} matched={matched} new={len(new_records)} skipped={len(caveats)}')
    print(f'report: {log_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
