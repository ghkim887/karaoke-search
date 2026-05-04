"""Regression tests for `scripts/retag-blog-vocaloid-mistags.py`.

Stdlib-only (`unittest`, no extra deps). Mirrors the shape of
`scripts/test_ingest_anisong_pdf.py`. Covers the override-map helper, the
per-record retag mutator, and a full end-to-end byte-idempotence round-trip
on a synthetic 3-record corpus.

Run:
    python -m unittest scripts/test_retag_blog_vocaloid_mistags.py
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPT_PATH = Path(__file__).resolve().parent / 'retag-blog-vocaloid-mistags.py'
_spec = importlib.util.spec_from_file_location('retag_blog_vocaloid_mistags', _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
retag = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(retag)


class TestGetPostOverride(unittest.TestCase):
    """`get_post_override(id)` returns 'jpop' for the three audited posts and
    None for everything else.
    """

    def test_blog_101_returns_jpop(self) -> None:
        self.assertEqual(retag.get_post_override('blog-101-0'), 'jpop')
        self.assertEqual(retag.get_post_override('blog-101-27'), 'jpop')

    def test_blog_105_returns_jpop(self) -> None:
        self.assertEqual(retag.get_post_override('blog-105-0'), 'jpop')
        self.assertEqual(retag.get_post_override('blog-105-30'), 'jpop')

    def test_blog_112_returns_jpop(self) -> None:
        self.assertEqual(retag.get_post_override('blog-112-0'), 'jpop')
        self.assertEqual(retag.get_post_override('blog-112-48'), 'jpop')

    def test_blog_428_returns_none(self) -> None:
        # The genuine ハチ Vocaloid catalog — must NOT be overridden.
        self.assertIsNone(retag.get_post_override('blog-428-0'))
        self.assertIsNone(retag.get_post_override('blog-428-26'))

    def test_other_blog_post_returns_none(self) -> None:
        self.assertIsNone(retag.get_post_override('blog-449-0'))
        self.assertIsNone(retag.get_post_override('blog-215-12'))
        self.assertIsNone(retag.get_post_override('blog-1-0'))

    def test_other_adapters_return_none(self) -> None:
        # tj-direct, anisong-pdf, namu records must never match.
        self.assertIsNone(retag.get_post_override('tj-101'))
        self.assertIsNone(retag.get_post_override('tjpdf-101'))
        self.assertIsNone(retag.get_post_override('namu-101-0'))

    def test_malformed_ids_return_none(self) -> None:
        self.assertIsNone(retag.get_post_override(''))
        self.assertIsNone(retag.get_post_override('blog-101'))  # no row index
        self.assertIsNone(retag.get_post_override('blog-101-'))  # empty row
        self.assertIsNone(retag.get_post_override('blog-1011-0'))  # post-id 1011, not 101
        self.assertIsNone(retag.get_post_override('blog-101-abc'))  # non-numeric row

    def test_non_string_returns_none(self) -> None:
        # Defensive — corpus records have string ids, but a mangled JSON file
        # might not.
        self.assertIsNone(retag.get_post_override(None))  # type: ignore[arg-type]
        self.assertIsNone(retag.get_post_override(42))  # type: ignore[arg-type]


class TestRetagRecord(unittest.TestCase):
    """`retag_record(rec)` mutates `categories` in place and returns True only
    when the record was actually changed.
    """

    def test_overridden_vocaloid_record_is_retagged(self) -> None:
        rec = {'id': 'blog-101-0', 'categories': ['vocaloid']}
        self.assertTrue(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['jpop'])

    def test_already_jpop_overridden_record_is_noop(self) -> None:
        # Idempotence guarantee — second run sees no change.
        rec = {'id': 'blog-101-0', 'categories': ['jpop']}
        self.assertFalse(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['jpop'])

    def test_non_overridden_record_is_noop(self) -> None:
        # blog-428 (ハチ Vocaloid catalog) — must be untouched.
        rec = {'id': 'blog-428-0', 'categories': ['vocaloid']}
        self.assertFalse(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['vocaloid'])

    def test_other_adapter_record_is_noop(self) -> None:
        rec = {'id': 'tj-101', 'categories': ['vocaloid']}
        self.assertFalse(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['vocaloid'])

    def test_overridden_anime_record_is_left_alone(self) -> None:
        # PDF-derived anime tags on the same blog posts (e.g. Aimer's anime
        # tie-in tracks) encode a real signal — DO NOT clobber them. The
        # override only displaces the `vocaloid` mistag.
        rec = {'id': 'blog-112-9', 'categories': ['anime']}
        self.assertFalse(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['anime'])

    def test_overridden_jpop_record_is_noop(self) -> None:
        # blog-101/105/112 records that are ALREADY `jpop` (the bulk of the
        # post catalog) are also a no-op — the override only fires on records
        # currently tagged `vocaloid`.
        rec = {'id': 'blog-101-0', 'categories': ['jpop']}
        self.assertFalse(retag.retag_record(rec))
        self.assertEqual(rec['categories'], ['jpop'])


class TestEndToEndIdempotent(unittest.TestCase):
    """Round-trip a synthetic 3-record corpus through `main()` twice and
    assert (a) the first run retags the affected record, (b) the second run
    is a no-op (no rewrite, no mtime change).
    """

    def _build_corpus(self) -> list[dict]:
        # 3 synthetic records covering the full discrimination matrix:
        #   - blog-101-0 (mistagged vocaloid)   -> retagged to jpop
        #   - blog-428-0 (genuine ハチ vocaloid) -> untouched
        #   - tj-12345  (tj-direct, vocaloid)   -> untouched (different adapter)
        return [
            {
                'id': 'blog-101-0',
                'source_url': 'https://j-pop-playlist.tistory.com/101',
                'title_primary': 'Lemon',
                'title_ko': '레몬',
                'artist_primary': '米津玄師',
                'artist_ko': '요네즈 켄시',
                'karaoke_numbers': {'tj': '12345', 'ky': None, 'joysound': None},
                'categories': ['vocaloid'],
                'crawled_at': '2026-04-01T00:00:00Z',
            },
            {
                'id': 'blog-428-0',
                'source_url': 'https://j-pop-playlist.tistory.com/428',
                'title_primary': 'マトリョシカ',
                'title_ko': None,
                'artist_primary': 'ハチ(Feat.初音ミク,GUMI)',
                'artist_ko': None,
                'karaoke_numbers': {'tj': '67890', 'ky': None, 'joysound': None},
                'categories': ['vocaloid'],
                'crawled_at': '2026-04-01T00:00:00Z',
            },
            {
                'id': 'tj-99999',
                'source_url': 'https://www.tjmedia.com/',
                'title_primary': 'fake',
                'title_ko': None,
                'artist_primary': 'fake',
                'artist_ko': None,
                'karaoke_numbers': {'tj': '99999', 'ky': None, 'joysound': None},
                'categories': ['vocaloid'],
                'crawled_at': '2026-04-01T00:00:00Z',
            },
        ]

    def test_round_trip_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            corpus_path = Path(tmp) / 'songs.json'
            corpus_path.write_text(
                json.dumps(self._build_corpus(), ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with patch.object(retag, 'SONGS_JSON', corpus_path):
                # ---- First run: should retag exactly 1 record. ----
                rc = retag.main()
                self.assertEqual(rc, 0)
                with open(corpus_path, encoding='utf-8') as f:
                    after_first = json.load(f)
                self.assertEqual(after_first[0]['id'], 'blog-101-0')
                self.assertEqual(after_first[0]['categories'], ['jpop'])
                # Other two records untouched.
                self.assertEqual(after_first[1]['id'], 'blog-428-0')
                self.assertEqual(after_first[1]['categories'], ['vocaloid'])
                self.assertEqual(after_first[2]['id'], 'tj-99999')
                self.assertEqual(after_first[2]['categories'], ['vocaloid'])

                # Snapshot bytes + mtime for idempotence check.
                bytes_after_first = corpus_path.read_bytes()
                mtime_after_first = corpus_path.stat().st_mtime_ns

                # ---- Second run: must be a no-op (no rewrite). ----
                rc = retag.main()
                self.assertEqual(rc, 0)
                # Bytes must be byte-for-byte identical.
                self.assertEqual(corpus_path.read_bytes(), bytes_after_first)
                # mtime must be unchanged (atomic-write was skipped).
                self.assertEqual(corpus_path.stat().st_mtime_ns, mtime_after_first)


if __name__ == '__main__':
    unittest.main()
