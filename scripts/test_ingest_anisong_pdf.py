"""Regression tests for `scripts/ingest-anisong-pdf.py`.

Stdlib-only (`unittest`, no extra deps). Covers the three helpers most prone to
silent regression: category exclusivity, anchor extraction (false-positive
floor + rightmost-pick), and Hangul→non-Hangul transition splitting.

The script's filename contains a hyphen, so it is loaded via `importlib`
rather than a normal `import` statement.

Run:
    python -m unittest scripts/test_ingest_anisong_pdf.py
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_SCRIPT_PATH = Path(__file__).resolve().parent / 'ingest-anisong-pdf.py'
_spec = importlib.util.spec_from_file_location('ingest_anisong_pdf', _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
ingest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ingest)


class TestApplyCategoryExclusivity(unittest.TestCase):
    """Mirrors the TS test in `packages/schema/src/index.test.ts`.

    Priority: vocaloid > anime > jpop. After the rule is applied, every
    record has at most one of {jpop, vocaloid, anime}. All 7 non-empty
    input combinations are covered.
    """

    def test_jpop_alone_unchanged(self) -> None:
        self.assertEqual(ingest._apply_category_exclusivity(['jpop']), ['jpop'])

    def test_anime_alone_unchanged(self) -> None:
        self.assertEqual(ingest._apply_category_exclusivity(['anime']), ['anime'])

    def test_vocaloid_alone_unchanged(self) -> None:
        self.assertEqual(ingest._apply_category_exclusivity(['vocaloid']), ['vocaloid'])

    def test_jpop_anime_collapses_to_anime(self) -> None:
        self.assertEqual(ingest._apply_category_exclusivity(['jpop', 'anime']), ['anime'])

    def test_jpop_vocaloid_collapses_to_vocaloid(self) -> None:
        self.assertEqual(
            ingest._apply_category_exclusivity(['jpop', 'vocaloid']), ['vocaloid']
        )

    def test_anime_vocaloid_collapses_to_vocaloid(self) -> None:
        self.assertEqual(
            ingest._apply_category_exclusivity(['anime', 'vocaloid']), ['vocaloid']
        )

    def test_all_three_collapse_to_vocaloid(self) -> None:
        self.assertEqual(
            ingest._apply_category_exclusivity(['jpop', 'anime', 'vocaloid']),
            ['vocaloid'],
        )


class TestExtractAnchor(unittest.TestCase):
    """`extract_anchor` returns (code, start, end) or None.

    Only digits >= _MIN_TJ_CODE (5000) qualify. When multiple anchors exist
    on a line, the RIGHTMOST is returned because the PDF's column layout
    places the real TJ code immediately before the artist string.
    """

    def test_single_anchor_returns_code(self) -> None:
        result = ingest.extract_anchor('夜に駆ける  68425  YOASOBI')
        self.assertIsNotNone(result)
        assert result is not None  # for type-narrowing
        code, _start, _end = result
        self.assertEqual(code, '68425')

    def test_below_floor_returns_none(self) -> None:
        # 1925 is the famous "year-as-number" false positive — under the
        # 5000 floor and must be rejected.
        result = ingest.extract_anchor('보컬로이드,    1925   28000  冨田悠斗')
        # Note: 28000 is above the floor, so this line DOES yield an anchor
        # (the rightmost qualifying number). For the strict "all numbers
        # below floor" case, use a synthetic line.
        self.assertIsNotNone(result)
        assert result is not None
        code, _start, _end = result
        self.assertEqual(code, '28000')

        # Strict "all below floor" case.
        result = ingest.extract_anchor('1000% 2000% intro  1925')
        self.assertIsNone(result)

    def test_multiple_anchors_returns_rightmost(self) -> None:
        # When two real codes appear on one line, the rightmost wins —
        # that's the artist-adjacent TJ code per parser intent.
        result = ingest.extract_anchor('Some Title  68425  Other  88888  Artist')
        self.assertIsNotNone(result)
        assert result is not None
        code, _start, _end = result
        self.assertEqual(code, '88888')


class TestSplitHangulTransition(unittest.TestCase):
    """`_split_hangul_transition` splits at the first Hangul→non-Hangul
    boundary. Used to recover titles when the column gap collapses to <4
    spaces and the anime-name (Hangul) fuses into the title chunk.
    """

    def test_hangul_then_latin(self) -> None:
        hangul, rest = ingest._split_hangul_transition('그리드맨 유니버스 UNION')
        self.assertEqual(hangul, '그리드맨 유니버스')
        self.assertEqual(rest, 'UNION')

    def test_pure_hangul_returns_input_then_empty(self) -> None:
        hangul, rest = ingest._split_hangul_transition('그리드맨 유니버스')
        self.assertEqual(hangul, '그리드맨 유니버스')
        self.assertEqual(rest, '')

    def test_pure_latin_returns_empty_then_input(self) -> None:
        hangul, rest = ingest._split_hangul_transition('UNION')
        self.assertEqual(hangul, '')
        self.assertEqual(rest, 'UNION')


if __name__ == '__main__':
    unittest.main()
