"""Regression tests for `scripts/drop_kpop_leaks.py` (Fix 5, 2026-05-01).

Stdlib-only (`unittest`, no extra deps). Covers idempotency: the cleanup
script must produce a no-op on a corpus that's already clean — same
record count, no rewrite of the on-disk file (no mtime change).

Run:
    python -m unittest scripts/test_drop_kpop_leaks.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPT_PATH = Path(__file__).resolve().parent / 'drop_kpop_leaks.py'
_spec = importlib.util.spec_from_file_location('drop_kpop_leaks', _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(script)


def _write_synthetic_sidecar(path: Path) -> None:
    """Write a minimal sidecar JSON with a small fixed key set."""
    sidecar = {
        'version': 1,
        'generatedAt': '2026-05-01T00:00:00Z',
        # Pre-normalized keys (lowercase, NFKC, whitespace-stripped) — same
        # transform the TS exporter and the Python loader apply.
        'keys': ['bts', '방탄소년단', 'tvxq', '東方神起'],
    }
    path.write_text(
        json.dumps(sidecar, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


def _make_synthetic_corpus(include_kpop: bool) -> list[dict]:
    """3-record synthetic corpus.

    When `include_kpop` is True, includes 1 record that should be dropped
    (artist == `방탄소년단`). The other 2 records always survive.
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
    if include_kpop:
        base.append({
            'id': 'tj-99999',
            'source_url': 'https://example.com/3',
            'title_primary': 'Dynamite',
            'title_ko': None,
            'artist_primary': '방탄소년단',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '99999', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        })
    return base


class TestDropKpopLeaksIdempotent(unittest.TestCase):
    """Idempotency: the cleanup script must produce a no-op on a clean corpus."""

    def test_first_run_drops_kpop_record(self) -> None:
        """First run on a corpus containing 1 KPOP record drops it."""
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_kpop=True)
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
            self.assertEqual(exit_code, 0, 'first run should succeed')

            after = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(after), 2,
                f'first run should drop 1 KPOP record, got {len(after)}')
            ids = sorted(r['id'] for r in after)
            self.assertEqual(ids, ['blog-1', 'blog-2'],
                f'BTS record should be dropped, surviving ids: {ids}')

    def test_second_run_is_noop(self) -> None:
        """Second run on the cleaned output must be a no-op:
        same record count, no file rewrite (mtime unchanged).
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            # Corpus already clean (no KPOP record).
            corpus = _make_synthetic_corpus(include_kpop=False)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            mtime_before = songs_path.stat().st_mtime_ns
            content_before = songs_path.read_bytes()
            # Sleep just enough that mtime would change if the file got
            # rewritten — most filesystems have ms resolution. A no-op
            # MUST NOT touch the file at all.
            time.sleep(0.05)

            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code = script.main()
            self.assertEqual(exit_code, 0, 'no-op run should succeed')

            mtime_after = songs_path.stat().st_mtime_ns
            content_after = songs_path.read_bytes()

            self.assertEqual(len(json.loads(content_after)), 2,
                'no-op should not change record count')
            self.assertEqual(content_before, content_after,
                'no-op should not change file content')
            self.assertEqual(mtime_before, mtime_after,
                f'no-op should NOT rewrite the file (mtime change indicates spurious write): '
                f'before={mtime_before} after={mtime_after}')

    def test_round_trip_two_runs(self) -> None:
        """Full round-trip: dirty corpus -> first run drops KPOP -> second
        run is no-op (file unchanged, same record count). This is the
        canonical "the cleanup is idempotent" assertion.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_kpop=True)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            # First run: drops the BTS record.
            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code_1 = script.main()
            self.assertEqual(exit_code_1, 0)
            self.assertEqual(len(json.loads(songs_path.read_text(encoding='utf-8'))), 2,
                'first run should leave 2 records')

            mtime_after_first = songs_path.stat().st_mtime_ns
            content_after_first = songs_path.read_bytes()
            time.sleep(0.05)

            # Second run on the cleaned output — must be no-op.
            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
            ):
                exit_code_2 = script.main()
            self.assertEqual(exit_code_2, 0)

            content_after_second = songs_path.read_bytes()
            mtime_after_second = songs_path.stat().st_mtime_ns

            self.assertEqual(content_after_first, content_after_second,
                'second run must produce byte-identical output')
            self.assertEqual(mtime_after_first, mtime_after_second,
                'second run must not rewrite the file (atomic-write should '
                'short-circuit on no-change)')


class TestDropKpopLeaksDryRun(unittest.TestCase):
    """--dry-run: reports what would be dropped without modifying the corpus."""

    def test_dry_run_does_not_modify_corpus(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_kpop=True)
            original_bytes = (
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n'
            ).encode('utf-8')
            songs_path.write_bytes(original_bytes)

            mtime_before = songs_path.stat().st_mtime_ns
            time.sleep(0.05)

            stderr_buf = io.StringIO()
            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
                patch('sys.stderr', stderr_buf),
            ):
                exit_code = script.main(['--dry-run'])
            self.assertEqual(exit_code, 0)

            # Corpus must be byte-stable — no rewrite.
            self.assertEqual(songs_path.read_bytes(), original_bytes,
                'dry-run must not modify the corpus file')
            self.assertEqual(songs_path.stat().st_mtime_ns, mtime_before,
                'dry-run must not touch the file (mtime unchanged)')

    def test_dry_run_reports_would_drop_count(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            sidecar_path = Path(tmpdir) / 'drop-list.json'
            _write_synthetic_sidecar(sidecar_path)

            corpus = _make_synthetic_corpus(include_kpop=True)
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            with (
                patch.object(script, 'SONGS_JSON', songs_path),
                patch.object(script, 'DROP_LIST_SIDECAR', sidecar_path),
                patch('sys.stdout', stdout_buf),
                patch('sys.stderr', stderr_buf),
            ):
                exit_code = script.main(['--dry-run'])
            self.assertEqual(exit_code, 0)
            self.assertIn('would drop', stdout_buf.getvalue(),
                'dry-run stdout should mention "would drop"')
            self.assertIn('dry-run, no changes written', stderr_buf.getvalue(),
                'dry-run should print sentinel to stderr')


class TestDropKpopLeaksMissingSidecar(unittest.TestCase):
    """When the sidecar is absent, drop_kpop_leaks.py must error out (exit 2).

    Unlike the PDF ingest (which gracefully degrades), this script's whole job
    is the drop-list filter — running without a sidecar would be a silent
    no-op that wastes a write cycle. The script returns exit code 2 to make
    the error visible to CI/maintainers.
    """

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
