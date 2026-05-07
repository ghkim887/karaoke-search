"""Regression tests for `scripts/drop_cpop_leaks.py`.

Stdlib-only (`unittest`, no extra deps). Mirrors `test_drop_kpop_leaks.py`.
Covers:
  - artist-list path (records with `artist_primary` matching the drop set)
  - ID-list path (catalog-anomaly IDs whose artist field is malformed)
  - idempotency (clean corpus → no rewrite, no mtime change)
  - missing sidecar → exit code 2

Run:
    python -m unittest scripts/test_drop_cpop_leaks.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPT_PATH = Path(__file__).resolve().parent / 'drop_cpop_leaks.py'
_spec = importlib.util.spec_from_file_location('drop_cpop_leaks', _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(script)


def _write_synthetic_sidecar(path: Path) -> None:
    """Write a minimal sidecar JSON with a small fixed key set.

    Pre-normalized keys (lowercase, NFKC, whitespace-stripped) — same
    transform the TS exporter and the Python loader apply.
    """
    sidecar = {
        'version': 1,
        'keys': ['beyond', 'f4', 's.h.e', 'twins'],
    }
    path.write_text(
        json.dumps(sidecar, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


def _make_synthetic_corpus(include_cpop: bool, include_anomaly: bool) -> list[dict]:
    """5-record synthetic corpus.

    Always includes 2 Japanese records that must survive. Optionally includes:
      - 2 Chinese-artist records (artist_primary in drop list) when `include_cpop`
      - 1 catalog-anomaly record (id=tj-72638, artist='-') when `include_anomaly`
    """
    base = [
        {
            'id': 'blog-1',
            'source_url': 'https://example.com/1',
            'title_primary': '夜に駆ける',
            'title_ko': None,
            'artist_primary': 'YOASOBI',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '68425', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        },
        {
            'id': 'blog-2',
            'source_url': 'https://example.com/2',
            'title_primary': '紅蓮華',
            'title_ko': None,
            'artist_primary': 'LiSA',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '68500', 'ky': None, 'joysound': None},
            'categories': ['anime'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        },
    ]
    if include_cpop:
        base.append({
            'id': 'tj-70170',
            'source_url': 'https://example.com/3',
            'title_primary': '大地',
            'title_ko': None,
            'artist_primary': 'BEYOND',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '70170', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        })
        base.append({
            'id': 'tj-80011',
            'source_url': 'https://example.com/4',
            'title_primary': '流星雨',
            'title_ko': None,
            'artist_primary': 'F4',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '80011', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        })
    if include_anomaly:
        base.append({
            'id': 'tj-72638',
            'source_url': 'https://example.com/5',
            'title_primary': '明天你是否依然爱我',
            'title_ko': None,
            'artist_primary': '-',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '72638', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        })
    return base


class TestDropCpopLeaksArtistPath(unittest.TestCase):
    """Artist-list path: records whose `artist_primary` matches the drop set."""

    def test_first_run_drops_chinese_artists(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_cpop=True, include_anomaly=False)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            self.assertEqual(len(corpus), 4)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0)

            after = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(after), 2,
                f'first run should drop 2 Chinese-artist records, got {len(after)}')
            ids = sorted(r['id'] for r in after)
            self.assertEqual(ids, ['blog-1', 'blog-2'],
                f'BEYOND + F4 should be dropped, surviving ids: {ids}')

    def test_japanese_artists_survive(self) -> None:
        """The two Japanese records must always survive on a clean run too."""
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_cpop=False, include_anomaly=False)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0)

            after = json.loads(songs_path.read_text(encoding='utf-8'))
            ids = sorted(r['id'] for r in after)
            self.assertEqual(ids, ['blog-1', 'blog-2'],
                'Japanese acts (YOASOBI, LiSA) must NOT be dropped')


class TestDropCpopLeaksIdPath(unittest.TestCase):
    """ID-list path: catalog-anomaly IDs (`tj-72638` artist=`-`)."""

    def test_anomaly_id_dropped_even_without_artist_match(self) -> None:
        """The anomaly record's artist is `-` which is NOT in the drop set —
        only the ID-based path can catch it.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            # Only the anomaly record + the two JP records — NO artist-list hits.
            corpus = _make_synthetic_corpus(include_cpop=False, include_anomaly=True)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            self.assertEqual(len(corpus), 3)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0)

            after = json.loads(songs_path.read_text(encoding='utf-8'))
            ids = sorted(r['id'] for r in after)
            self.assertEqual(ids, ['blog-1', 'blog-2'],
                f'tj-72638 (artist=-) must be dropped via ID path, surviving ids: {ids}')

    def test_anomaly_id_in_catalog_anomaly_set(self) -> None:
        """Sanity: tj-72638 is the documented anomaly ID."""
        self.assertIn('tj-72638', script._CATALOG_ANOMALY_IDS)


class TestDropCpopLeaksCombined(unittest.TestCase):
    """Both paths together — full-corpus mutation."""

    def test_artist_and_id_paths_together(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_cpop=True, include_anomaly=True)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            self.assertEqual(len(corpus), 5)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0)

            after = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(after), 2,
                f'first run should drop 3 records (2 cpop + 1 anomaly), got {len(after)}')
            ids = sorted(r['id'] for r in after)
            self.assertEqual(ids, ['blog-1', 'blog-2'])


class TestDropCpopLeaksIdempotent(unittest.TestCase):
    """Idempotency: a clean corpus must NOT be rewritten on subsequent runs."""

    def test_second_run_is_noop(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_cpop=False, include_anomaly=False)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            mtime_before = songs_path.stat().st_mtime_ns
            content_before = songs_path.read_bytes()
            time.sleep(0.05)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0)

            mtime_after = songs_path.stat().st_mtime_ns
            content_after = songs_path.read_bytes()

            self.assertEqual(content_before, content_after,
                'no-op should not change file content')
            self.assertEqual(mtime_before, mtime_after,
                f'no-op should NOT rewrite the file (mtime change indicates spurious write): '
                f'before={mtime_before} after={mtime_after}')

    def test_round_trip_two_runs(self) -> None:
        """Dirty corpus → first run drops → second run is byte-identical no-op."""
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_cpop=True, include_anomaly=True)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                self.assertEqual(script.main(), 0)
            self.assertEqual(len(json.loads(songs_path.read_text(encoding='utf-8'))), 2)

            mtime_after_first = songs_path.stat().st_mtime_ns
            content_after_first = songs_path.read_bytes()
            time.sleep(0.05)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                self.assertEqual(script.main(), 0)

            content_after_second = songs_path.read_bytes()
            mtime_after_second = songs_path.stat().st_mtime_ns

            self.assertEqual(content_after_first, content_after_second,
                'second run must produce byte-identical output')
            self.assertEqual(mtime_after_first, mtime_after_second,
                'second run must not rewrite the file')


class TestDropCpopLeaksMissingSidecar(unittest.TestCase):
    """Missing sidecar → exit 2 (mirrors drop_kpop_leaks.py behavior)."""

    def test_missing_sidecar_returns_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            missing = Path(tmpdir) / 'absent.json'  # never created

            stderr_buf = io.StringIO()
            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', missing),
                patch('sys.stderr', stderr_buf),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 2)
            self.assertIn('drop-list sidecar', stderr_buf.getvalue())


if __name__ == '__main__':
    unittest.main()
