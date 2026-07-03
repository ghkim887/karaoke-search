"""Parity test: clustering-rules sidecar matches TS SPLIT_RE_SOURCE byte-for-byte.

Verifies that the JSON sidecar written by `scripts/export-clustering-rules.mjs`
reflects the current content of `SPLIT_RE_SOURCE` in
`packages/crawler/src/clustering.ts`. This is the mechanical sync gate:

  1. A developer edits SPLIT_RE_SOURCE in clustering.ts.
  2. Rebuilds the crawler (`pnpm --filter @karaoke/crawler build`).
  3. export-clustering-rules.mjs regenerates the sidecar.
  4. The sidecar shows up as a dirty file in `git status`, prompting the
     developer to stage and commit it alongside the TS change.
  5. CI's `git diff --exit-code` gate catches any drift at the sidecar level.
  6. THIS test catches drift at the source level: if someone edits clustering.ts
     without rebuilding, the sidecar vs. TS source will diverge.

Two methods of reading the canonical value are compared:
  a) The sidecar JSON (what Python actually uses at runtime).
  b) The TS source file (read via regex extraction from the raw text).

Run:
    python -m unittest scripts/test_splitter_parity.py
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = Path(__file__).resolve().parent
_SIDECAR_PATH = _REPO_ROOT / 'packages' / 'crawler' / 'src' / 'clustering-rules.json'
_TS_SOURCE_PATH = _REPO_ROOT / 'packages' / 'crawler' / 'src' / 'clustering.ts'

# Make scripts/ importable so `from lib.artist_split import ...` works.
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


def _read_sidecar_pattern() -> str:
    """Read splitterPattern from the committed clustering-rules.json sidecar."""
    if not _SIDECAR_PATH.exists():
        raise FileNotFoundError(
            f'clustering-rules sidecar not found: {_SIDECAR_PATH}\n'
            'Run: corepack pnpm --filter @karaoke/crawler build'
        )
    data = json.loads(_SIDECAR_PATH.read_text(encoding='utf-8'))
    pattern = data.get('splitterPattern')
    if not isinstance(pattern, str):
        raise ValueError(f'splitterPattern missing or not a string in {_SIDECAR_PATH}')
    return pattern


def _read_ts_source_pattern() -> str:
    """Extract SPLIT_RE_SOURCE value from clustering.ts via regex.

    Looks for the assignment:
        export const SPLIT_RE_SOURCE = String.raw`<pattern>`;
    and returns the raw template-literal content between the backticks.
    """
    ts_text = _TS_SOURCE_PATH.read_text(encoding='utf-8')
    # Match: export const SPLIT_RE_SOURCE = String.raw`...`;
    m = re.search(
        r'export\s+const\s+SPLIT_RE_SOURCE\s*=\s*String\.raw`([^`]+)`',
        ts_text,
    )
    if not m:
        raise ValueError(
            f'Could not find SPLIT_RE_SOURCE assignment in {_TS_SOURCE_PATH}.\n'
            'Expected: export const SPLIT_RE_SOURCE = String.raw`...`;'
        )
    return m.group(1)


def _read_ts_source_flags() -> str:
    """Extract SPLIT_RE_FLAGS value from clustering.ts via regex.

    Looks for: export const SPLIT_RE_FLAGS = '<flags>';
    and returns the quoted flags string.
    """
    ts_text = _TS_SOURCE_PATH.read_text(encoding='utf-8')
    m = re.search(
        r"export\s+const\s+SPLIT_RE_FLAGS\s*=\s*['\"]([^'\"]*)['\"]",
        ts_text,
    )
    if not m:
        raise ValueError(
            f'Could not find SPLIT_RE_FLAGS assignment in {_TS_SOURCE_PATH}.\n'
            "Expected: export const SPLIT_RE_FLAGS = 'i';"
        )
    return m.group(1)


class TestSplitterParity(unittest.TestCase):
    """Assert the sidecar splitterPattern matches the TS source byte-for-byte."""

    def test_sidecar_matches_ts_source(self) -> None:
        """splitterPattern in clustering-rules.json must equal SPLIT_RE_SOURCE in clustering.ts."""
        sidecar_pattern = _read_sidecar_pattern()
        ts_pattern = _read_ts_source_pattern()
        self.assertEqual(
            sidecar_pattern,
            ts_pattern,
            msg=(
                'clustering-rules.json splitterPattern diverged from clustering.ts SPLIT_RE_SOURCE.\n'
                f'  sidecar : {sidecar_pattern!r}\n'
                f'  TS src  : {ts_pattern!r}\n'
                'Fix: run `corepack pnpm --filter @karaoke/crawler build` then commit the updated sidecar.'
            ),
        )

    def test_sidecar_contains_meets(self) -> None:
        """Regression guard: splitterPattern must contain \\s+meets\\s+ (added 2026-05-04)."""
        sidecar_pattern = _read_sidecar_pattern()
        self.assertIn(
            r'\s+meets\s+',
            sidecar_pattern,
            msg=(
                'splitterPattern must contain \\s+meets\\s+ for CHiCO/HoneyWorks meets collab forms.\n'
                'Do not remove this delimiter without updating the parity test.'
            ),
        )

    def test_sidecar_contains_full_width_pipe(self) -> None:
        """Regression guard: splitterPattern must contain U+FF5C (｜) for blog alias forms."""
        sidecar_pattern = _read_sidecar_pattern()
        self.assertIn(
            '｜',
            sidecar_pattern,
            msg=(
                'splitterPattern must contain U+FF5C (｜) for blog pipe-form collab splitting.\n'
                'Do not remove this delimiter without updating the parity test.'
            ),
        )

    def test_sidecar_flags_match_ts_source(self) -> None:
        """splitterFlags in the sidecar must equal SPLIT_RE_FLAGS in clustering.ts.

        The delimiter STRING alone is not the whole splitter contract: the flags
        (`i` = IGNORECASE) decide whether `FEAT.` / `WITH` / `MEETS` split like
        their lower-case forms. A flags-only edit in clustering.ts must not slip
        past the sidecar gate.
        """
        data = json.loads(_SIDECAR_PATH.read_text(encoding='utf-8'))
        sidecar_flags = data.get('splitterFlags')
        ts_flags = _read_ts_source_flags()
        self.assertEqual(
            sidecar_flags,
            ts_flags,
            msg=(
                'clustering-rules.json splitterFlags diverged from clustering.ts '
                'SPLIT_RE_FLAGS.\n'
                f'  sidecar : {sidecar_flags!r}\n'
                f'  TS src  : {ts_flags!r}\n'
                'Fix: run `corepack pnpm --filter @karaoke/crawler build` then commit the sidecar.'
            ),
        )

    def test_python_fallback_matches_ts_source(self) -> None:
        """`_SPLIT_RE_SOURCE_FALLBACK` in artist_split.py must equal TS SPLIT_RE_SOURCE.

        The fallback is the last-resort copy used only when the sidecar is
        missing/malformed (partial-build state). It is unprotected by the
        `git diff --exit-code` sidecar gate, so it can silently drift from the TS
        source. This assertion is the only thing keeping the degraded path honest.
        """
        from lib.artist_split import _SPLIT_RE_SOURCE_FALLBACK

        ts_pattern = _read_ts_source_pattern()
        self.assertEqual(
            _SPLIT_RE_SOURCE_FALLBACK,
            ts_pattern,
            msg=(
                'lib/artist_split.py _SPLIT_RE_SOURCE_FALLBACK diverged from '
                'clustering.ts SPLIT_RE_SOURCE.\n'
                f'  fallback : {_SPLIT_RE_SOURCE_FALLBACK!r}\n'
                f'  TS src   : {ts_pattern!r}\n'
                'Update the hardcoded fallback in artist_split.py to match clustering.ts.'
            ),
        )

    def test_python_splitter_uses_ignorecase(self) -> None:
        """The compiled Python splitter must carry IGNORECASE when TS flags include `i`.

        artist_split.py hardcodes `re.IGNORECASE`; TS carries it via
        SPLIT_RE_FLAGS='i'. If TS ever drops the `i` flag, this test flags the
        drift (Python would still be matching case-insensitively).
        """
        from lib.artist_split import DROP_SPLIT_RE

        ts_flags = _read_ts_source_flags()
        self.assertEqual(
            'i' in ts_flags,
            bool(DROP_SPLIT_RE.flags & re.IGNORECASE),
            msg=(
                'IGNORECASE parity broke: TS SPLIT_RE_FLAGS='
                f'{ts_flags!r} but Python DROP_SPLIT_RE IGNORECASE='
                f'{bool(DROP_SPLIT_RE.flags & re.IGNORECASE)}.'
            ),
        )

    def test_sidecar_version(self) -> None:
        """Sidecar must have version: 1."""
        data = json.loads(_SIDECAR_PATH.read_text(encoding='utf-8'))
        self.assertEqual(data.get('version'), 1)

    def test_sidecar_has_splitter_flags(self) -> None:
        """Sidecar must have a splitterFlags field."""
        data = json.loads(_SIDECAR_PATH.read_text(encoding='utf-8'))
        self.assertIn('splitterFlags', data)
        self.assertIsInstance(data['splitterFlags'], str)


if __name__ == '__main__':
    unittest.main()
