"""Unit tests for `scripts/lib/corpus_io.py`.

Stdlib-only (`unittest`, no extra deps). Covers `ensure_utf8_stdio`,
`atomic_write_corpus`, and `iso_utc_now`.

Run:
    python -m unittest scripts/test_lib_corpus_io.py
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Make scripts/ importable so `from lib.corpus_io import ...` works.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.corpus_io import atomic_write_corpus, ensure_utf8_stdio, iso_utc_now


class TestEnsureUtf8Stdio(unittest.TestCase):
    """ensure_utf8_stdio() is idempotent and does not raise."""

    def test_does_not_raise(self) -> None:
        # Calling twice must be idempotent — no exception.
        ensure_utf8_stdio()
        ensure_utf8_stdio()

    def test_stdout_encoding_is_utf8(self) -> None:
        ensure_utf8_stdio()
        # After reconfigure, encoding should be utf-8 (case-insensitive).
        if hasattr(sys.stdout, 'encoding') and sys.stdout.encoding:
            self.assertIn(sys.stdout.encoding.lower().replace('-', ''), ('utf8',))

    def test_stderr_encoding_is_utf8(self) -> None:
        ensure_utf8_stdio()
        if hasattr(sys.stderr, 'encoding') and sys.stderr.encoding:
            self.assertIn(sys.stderr.encoding.lower().replace('-', ''), ('utf8',))


class TestAtomicWriteCorpus(unittest.TestCase):
    """atomic_write_corpus() writes records atomically with the correct format."""

    def _make_records(self) -> list[dict]:
        return [
            {
                'id': 'blog-1',
                'title_primary': '夜に駆ける',
                'artist_primary': 'YOASOBI',
                'categories': ['jpop'],
            },
            {
                'id': 'tj-2',
                'title_primary': '紅蓮華',
                'artist_primary': 'LiSA',
                'categories': ['anime'],
            },
        ]

    def test_writes_valid_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'songs.json'
            records = self._make_records()
            atomic_write_corpus(path, records)
            loaded = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(len(loaded), 2)
            self.assertEqual(loaded[0]['id'], 'blog-1')
            self.assertEqual(loaded[1]['id'], 'tj-2')

    def test_uses_indent_2_and_trailing_newline(self) -> None:
        """Format must be indent=2 + trailing newline for byte-idempotency with
        the rest of the pipeline (e.g. ingest-anisong-pdf.py, the TS crawler).
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'songs.json'
            atomic_write_corpus(path, self._make_records())
            raw = path.read_text(encoding='utf-8')
            # Trailing newline.
            self.assertTrue(raw.endswith('\n'), 'file must end with a newline')
            # indent=2: lines should start with exactly two spaces for top-level
            # dict keys.
            lines = raw.splitlines()
            indented = [l for l in lines if l.startswith('  ') and not l.startswith('    ')]
            self.assertTrue(len(indented) > 0, 'expected indent-2 lines')

    def test_no_ensure_ascii(self) -> None:
        """Non-ASCII characters (Hangul, kana) must not be escaped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'songs.json'
            records = [{'id': 'x', 'title': '夜に駆ける'}]
            atomic_write_corpus(path, records)
            raw = path.read_text(encoding='utf-8')
            self.assertIn('夜に駆ける', raw, 'non-ASCII must not be escaped')
            self.assertNotIn('\\u', raw)

    def test_no_tmp_file_left_behind(self) -> None:
        """The .tmp file must be renamed away — not left on disk."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'songs.json'
            atomic_write_corpus(path, self._make_records())
            tmp = path.with_suffix(path.suffix + '.tmp')
            self.assertFalse(tmp.exists(), f'.tmp file should not remain: {tmp}')

    def test_round_trip_byte_idempotent(self) -> None:
        """Writing the same records twice produces byte-identical output."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'songs.json'
            records = self._make_records()
            atomic_write_corpus(path, records)
            first = path.read_bytes()
            atomic_write_corpus(path, records)
            second = path.read_bytes()
            self.assertEqual(first, second, 'two writes of the same data must be byte-identical')

    def test_graceful_degradation_missing_parent(self) -> None:
        """Writing to a non-existent directory raises OSError (not silent fail)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'nonexistent_dir' / 'songs.json'
            with self.assertRaises(OSError):
                atomic_write_corpus(path, self._make_records())


class TestIsoUtcNow(unittest.TestCase):
    """iso_utc_now() must produce a JS-toISOString()-compatible timestamp."""

    def test_ends_with_z(self) -> None:
        self.assertTrue(iso_utc_now().endswith('Z'))

    def test_length_is_24(self) -> None:
        result = iso_utc_now()
        self.assertEqual(len(result), 24, f'expected length 24, got {len(result)} for {result!r}')

    def test_has_millisecond_precision(self) -> None:
        result = iso_utc_now()
        ms_part = result[-4:-1]
        self.assertEqual(len(ms_part), 3)
        self.assertTrue(ms_part.isdigit(), f'ms part not digits: {ms_part!r}')

    def test_parses_as_utc_datetime(self) -> None:
        result = iso_utc_now()
        parsed = _dt.datetime.fromisoformat(result[:-1])
        self.assertIsNotNone(parsed)

    def test_lex_order_compatible_with_js(self) -> None:
        result = iso_utc_now()
        self.assertLess(result, '2099-12-31T23:59:59.999Z')
        self.assertGreater(result, '2000-01-01T00:00:00.000Z')

    def test_graceful_degradation_sidecar_missing(self) -> None:
        """Graceful-degradation path: iso_utc_now() does not depend on any
        sidecar — it must always succeed regardless of repo state.
        """
        # Simply call it twice; no sidecar involved.
        t1 = iso_utc_now()
        t2 = iso_utc_now()
        self.assertTrue(t1.endswith('Z'))
        self.assertTrue(t2.endswith('Z'))


if __name__ == '__main__':
    unittest.main()
