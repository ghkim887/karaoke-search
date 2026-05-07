"""Unit tests for `scripts/lib/artist_split.py`.

Stdlib-only (`unittest`, no extra deps). Covers `normalize_for_match`,
`artist_components_for_drop_check`, `load_drop_keys`, `is_artist_in_drop_list`,
and the graceful-degradation paths (sidecar missing for the splitter loader).

Run:
    python -m unittest scripts/test_lib_artist_split.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Make scripts/ importable so `from lib.artist_split import ...` works.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.artist_split import (
    DROP_SPLIT_RE,
    FEAT_INNER_OF_RE,
    FEAT_PAREN_FINDALL_RE,
    artist_components_for_drop_check,
    is_artist_in_drop_list,
    load_drop_keys,
    normalize_for_match,
)


class TestNormalizeForMatch(unittest.TestCase):
    """normalize_for_match() must mirror the TS `normalizeForMatch` rule:
    strip all whitespace, lowercase, NFKC.
    """

    def test_strips_whitespace_and_lowercases(self) -> None:
        self.assertEqual(normalize_for_match('  BTS  '), 'bts')
        self.assertEqual(normalize_for_match('Le Sserafim'), 'lesserafim')

    def test_nfkc_collapses_fullwidth_latin(self) -> None:
        self.assertEqual(normalize_for_match('ＴＶＸＱ'), 'tvxq')

    def test_empty_string(self) -> None:
        self.assertEqual(normalize_for_match(''), '')

    def test_japanese_unchanged_case(self) -> None:
        # Japanese kana/kanji are case-neutral; normalize_for_match preserves them
        # except for NFKC decomposition.
        result = normalize_for_match('  YOASOBI  ')
        self.assertEqual(result, 'yoasobi')


class TestArtistComponentsForDropCheck(unittest.TestCase):
    """artist_components_for_drop_check() splits on configured delimiters and
    sub-splits feat/prod paren inner content on `of`.
    """

    def test_bare_artist_roundtrips(self) -> None:
        self.assertEqual(artist_components_for_drop_check('YOASOBI'), ['YOASOBI'])

    def test_feat_paren_emits_lead_and_featured(self) -> None:
        comps = artist_components_for_drop_check('imase(Feat.IU)')
        self.assertIn('imase', comps)
        self.assertIn('IU', comps)

    def test_feat_paren_of_sub_splits_inside_paren(self) -> None:
        comps = artist_components_for_drop_check('MAX(Feat.SUGA of BTS)')
        self.assertIn('SUGA', comps)
        self.assertIn('BTS', comps)

    def test_bare_of_does_not_split(self) -> None:
        # Fix 1 parity: bare ` of ` outside feat/prod paren must NOT split.
        comps = artist_components_for_drop_check('Bump of Chicken')
        self.assertEqual(comps, ['Bump of Chicken'])

    def test_bare_suga_of_bts_does_not_split(self) -> None:
        comps = artist_components_for_drop_check('SUGA of BTS')
        self.assertEqual(comps, ['SUGA of BTS'])

    def test_meets_delimiter_splits(self) -> None:
        # `meets` must be in the splitter so HoneyWorks surfaces as a component.
        comps = artist_components_for_drop_check('CHiCO with HoneyWorks meets 中川翔子')
        self.assertIn('HoneyWorks', comps)

    def test_empty_string_returns_empty(self) -> None:
        self.assertEqual(artist_components_for_drop_check(''), [])

    def test_deduplication(self) -> None:
        # If the same component appears multiple times from different split paths,
        # it must appear only once.
        comps = artist_components_for_drop_check('A & A')
        self.assertEqual(comps.count('A'), 1)

    def test_full_width_pipe_splits(self) -> None:
        # U+FF5C parity with TS SPLIT_RE — the splitter must contain ｜.
        self.assertIn('｜', DROP_SPLIT_RE.pattern)
        comps = artist_components_for_drop_check('ArtistA｜ArtistB')
        self.assertIn('ArtistA', comps)
        self.assertIn('ArtistB', comps)


class TestLoadDropKeys(unittest.TestCase):
    """load_drop_keys() reads a sidecar JSON and returns a set of normalized keys."""

    def _write_sidecar(self, path: Path, keys: list[str]) -> None:
        sidecar = {'version': 1, 'generatedAt': '2026-01-01T00:00:00Z', 'keys': keys}
        path.write_text(json.dumps(sidecar, ensure_ascii=False), encoding='utf-8')

    def test_loads_keys_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            p = Path(tmpdir) / 'sidecar.json'
            self._write_sidecar(p, ['BTS', '방탄소년단', 'TVXQ'])
            keys = load_drop_keys(p)
            self.assertIn('bts', keys)
            self.assertIn('방탄소년단', keys)
            self.assertIn('tvxq', keys)

    def test_missing_sidecar_returns_empty_set_with_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            missing = Path(tmpdir) / 'absent.json'
            stderr_buf = io.StringIO()
            with patch('sys.stderr', stderr_buf):
                keys = load_drop_keys(missing)
            self.assertEqual(keys, set())
            self.assertIn('drop-list sidecar not found', stderr_buf.getvalue())

    def test_malformed_json_returns_empty_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            p = Path(tmpdir) / 'bad.json'
            p.write_text('{not valid json', encoding='utf-8')
            stderr_buf = io.StringIO()
            with patch('sys.stderr', stderr_buf):
                keys = load_drop_keys(p)
            self.assertEqual(keys, set())

    def test_missing_keys_array_returns_empty_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            p = Path(tmpdir) / 'no-keys.json'
            p.write_text(json.dumps({'version': 1}), encoding='utf-8')
            stderr_buf = io.StringIO()
            with patch('sys.stderr', stderr_buf):
                keys = load_drop_keys(p)
            self.assertEqual(keys, set())


class TestIsArtistInDropList(unittest.TestCase):
    """is_artist_in_drop_list() checks all components of an artist string."""

    _KEYS = {'tvxq', 'bts', '동방신기', 'iu'}

    def test_direct_match(self) -> None:
        self.assertTrue(is_artist_in_drop_list('TVXQ', self._KEYS))

    def test_feat_component_match(self) -> None:
        self.assertTrue(is_artist_in_drop_list('imase(Feat.IU)', self._KEYS))

    def test_deep_feat_of_match(self) -> None:
        self.assertTrue(is_artist_in_drop_list('LiSA(Feat.SUGA of BTS)', self._KEYS))

    def test_no_match(self) -> None:
        self.assertFalse(is_artist_in_drop_list('YOASOBI', self._KEYS))
        self.assertFalse(is_artist_in_drop_list('Linked Horizon', self._KEYS))

    def test_empty_drop_keys_always_false(self) -> None:
        self.assertFalse(is_artist_in_drop_list('TVXQ', set()))
        self.assertFalse(is_artist_in_drop_list('imase(Feat.IU)', set()))

    def test_empty_artist_false(self) -> None:
        self.assertFalse(is_artist_in_drop_list('', self._KEYS))


class TestDropSplitReContents(unittest.TestCase):
    """Parity-protection: DROP_SPLIT_RE must contain TS parity markers."""

    def test_contains_full_width_pipe(self) -> None:
        # U+FF5C parity with TS SPLIT_RE — protects against future regex tidying.
        self.assertIn('｜', DROP_SPLIT_RE.pattern)

    def test_contains_meets(self) -> None:
        # `meets` must be present so CHiCO with HoneyWorks meets X decomposes.
        self.assertIn('meets', DROP_SPLIT_RE.pattern)


if __name__ == '__main__':
    unittest.main()
