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
_SIDECAR_PATH = _REPO_ROOT / 'packages' / 'crawler' / 'src' / 'clustering-rules.json'
_TS_SOURCE_PATH = _REPO_ROOT / 'packages' / 'crawler' / 'src' / 'clustering.ts'


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
