"""Regression tests for `scripts/ingest_anisong_pdf.py` (coverage-only).

Stdlib-only (`unittest`, no extra deps). Covers the helpers most prone to
silent regression: anchor extraction (false-positive floor + rightmost-pick)
and Hangul→non-Hangul transition splitting.

Also includes fixture-based end-to-end tests for `parse_pdf()` against synthetic
PDF-text snippets (TestParsePdfFixtures) and an idempotency round-trip test
(TestIngestIdempotent).

The category/section dimension was removed from the schema, so the ingest is
now coverage-only: it inserts brand-new `tjpdf-{code}` records for PDF codes
absent from the corpus and skips codes that already exist. New records carry no
`categories` field.

Run:
    python -m unittest scripts/test_ingest_anisong_pdf.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPT_PATH = Path(__file__).resolve().parent / 'ingest_anisong_pdf.py'
_spec = importlib.util.spec_from_file_location('ingest_anisong_pdf', _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
ingest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ingest)


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


class TestParsePdfFixtures(unittest.TestCase):
    """Fixture-based end-to-end tests for `parse_pdf()`.

    Synthetic snippets are Python strings that mimic the column-aligned output
    produced by `pdftotext -table`. Each test is self-contained with no shared
    state.

    `parse_pdf()` returns (records, caveats) where each record dict contains:
      'tj', 'title', 'artist', 'title_ko', 'artist_ko', 'source_line'

    The parser no longer tracks PDF section dividers (the category dimension
    was removed from the schema), so records carry no 'section' field.
    """

    def test_parse_pdf_anime_row(self) -> None:
        """A single data row parses into one record with the correct TJ
        number, title candidate (title field), and artist candidate
        (artist field).

        The snippet mimics pdftotext -table column layout:
          col 0-19:   anime-name (Hangul)
          col 20-55:  Japanese title
          col 56-62:  TJ code
          col 63+:    artist
        """
        # Real-world column widths observed in scripts/data/anisong_utf8.txt:
        # anime-name ~col 0, title ~col 18-20, TJ code ~col 52-58, artist ~col 59+
        lines = [
            '일본 애니메이션 곡                                 0~9, 영문                    1\n',
            '\n',
            '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon\n',
            '                   홍련의 궁시                          링크드 호라이즌\n',
        ]
        records, caveats = ingest.parse_pdf(lines)
        self.assertEqual(len(records), 1, f'expected 1 record, got {len(records)}: {records}')
        rec = records[0]
        self.assertNotIn('section', rec, 'parse_pdf must no longer emit a section field')
        self.assertEqual(rec['tj'], '68001')
        self.assertIn('紅蓮の弓矢', rec['title'], f"title should contain the JP title, got {rec['title']!r}")
        self.assertIn('Linked Horizon', rec['artist'], f"artist should contain artist name, got {rec['artist']!r}")

    def test_parse_pdf_multiple_rows(self) -> None:
        """Two data rows (one separated by the former vocaloid divider line)
        parse into two records. The leftmost-column token (formerly a section
        divider) is now treated as just another anime-name cell — both rows
        emit normally with no section semantics.

        Note: 1925 is below _MIN_TJ_CODE (5000) and is ignored; 28000 / 28500
        are the real TJ codes.
        """
        lines = [
            '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon\n',
            '                   홍련의 궁시                          링크드 호라이즌\n',
            '\n',
            '보컬로이드,         千本桜                       28500  黒うさP\n',
            '                   센본자쿠라                           쿠로우사P\n',
        ]
        records, caveats = ingest.parse_pdf(lines)
        self.assertEqual(len(records), 2, f'expected 2 records, got {len(records)}: {records}')
        for rec in records:
            self.assertNotIn('section', rec)
        self.assertEqual(records[0]['tj'], '68001')
        self.assertEqual(records[1]['tj'], '28500')


class TestIngestIdempotent(unittest.TestCase):
    """Round-trip idempotency: running the ingest twice on the same synthetic
    corpus + PDF text produces a byte-identical output on the second run.

    Uses tempfile.TemporaryDirectory so no real files are mutated. Patches
    the module-level SONGS_JSON and PDF_TEXT constants so main() operates on
    the temp files rather than the real repo paths.

    Synthetic corpus has 3 records:
      - 1 TJ-numbered record (TJ 68001) — already present, so the matching PDF
        row is skipped (coverage-only).
      - 1 record without a TJ number — untouched by the ingest.
      - 1 existing tjpdf-* record (TJ 28500) — dropped by the pre-pass; the PDF
        also carries 28500, but the corpus already has a non-tjpdf row for it?
        No — 28500 only exists as the tjpdf-* row, which is dropped, so the PDF
        row re-inserts it.
    """

    # Minimal synthetic PDF text with two data rows (TJ 68001 and TJ 28500)
    # using realistic pdftotext -table column spacing.
    _SYNTHETIC_PDF = (
        '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon\n'
        '                   홍련의 궁시                          링크드 호라이즌\n'
        '\n'
        '마법소녀          千本桜                       28500  黒うさP\n'
        '                  센본자쿠라                           쿠로우사P\n'
    )

    def _make_corpus(self) -> list[dict]:
        return [
            {
                'id': 'blog-68001',
                'source_url': 'https://example.com/1',
                'title_primary': '紅蓮の弓矢',
                'title_ko': '홍련의 궁시',
                'artist_primary': 'Linked Horizon',
                'artist_ko': '링크드 호라이즌',
                'karaoke_numbers': {'tj': '68001', 'ky': None, 'joysound': None},
                'crawled_at': '2026-01-01T00:00:00+00:00',
            },
            {
                'id': 'blog-no-tj',
                'source_url': 'https://example.com/2',
                'title_primary': 'Some Song',
                'title_ko': None,
                'artist_primary': 'Some Artist',
                'artist_ko': None,
                'karaoke_numbers': {'tj': None, 'ky': None, 'joysound': None},
                'crawled_at': '2026-01-01T00:00:00+00:00',
            },
            {
                'id': 'tjpdf-28500',
                'source_url': 'https://www.tjmedia.com/support/poster?cate_cd=P06',
                'title_primary': '千本桜',
                'title_ko': '센본자쿠라',
                'artist_primary': '黒うさP',
                'artist_ko': '쿠로우사P',
                'karaoke_numbers': {'tj': '28500', 'ky': None, 'joysound': None},
                'crawled_at': '2026-03-01T00:00:00+00:00',
            },
        ]

    def test_coverage_only_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'

            pdf_path.write_text(self._SYNTHETIC_PDF, encoding='utf-8')
            songs_path.write_text(
                json.dumps(self._make_corpus(), ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            # First run.
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
            ):
                exit_code_1 = ingest.main()
            self.assertEqual(exit_code_1, 0, 'first run should succeed')
            output_1 = songs_path.read_bytes()

            # Second run on the output of the first run.
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
            ):
                exit_code_2 = ingest.main()
            self.assertEqual(exit_code_2, 0, 'second run should succeed')
            output_2 = songs_path.read_bytes()

            self.assertEqual(
                output_1, output_2,
                'second ingest run must produce byte-identical output (idempotency)'
            )

            corpus = json.loads(output_1.decode('utf-8'))
            by_id = {r['id']: r for r in corpus}

            # The blog-68001 record (already present) must be untouched — no
            # categories key added, all original fields intact.
            blog_rec = by_id.get('blog-68001')
            self.assertIsNotNone(blog_rec, 'blog-68001 should still be present')
            assert blog_rec is not None
            self.assertNotIn('categories', blog_rec,
                'coverage-only ingest must not add a categories field')
            self.assertEqual(blog_rec['title_primary'], '紅蓮の弓矢')

            # The tjpdf-28500 record was dropped by the pre-pass and re-inserted
            # from the PDF row (28500 has no non-tjpdf corpus row).
            tjpdf_rec = by_id.get('tjpdf-28500')
            self.assertIsNotNone(tjpdf_rec, 'tjpdf-28500 should be re-inserted')
            assert tjpdf_rec is not None
            self.assertNotIn('categories', tjpdf_rec,
                'new tjpdf-* record must not carry a categories field')

    def test_new_record_has_no_categories_field(self) -> None:
        """A brand-new PDF code (absent from the corpus) is inserted as a
        tjpdf-* record WITHOUT a categories field — the category dimension was
        removed from the schema.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text(self._SYNTHETIC_PDF, encoding='utf-8')
            # Empty corpus — both PDF codes are brand-new.
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(corpus), 2, f'expected 2 new records, got {len(corpus)}')
            for rec in corpus:
                self.assertTrue(rec['id'].startswith('tjpdf-'))
                self.assertNotIn('categories', rec,
                    f"new record {rec['id']} must not carry categories, got {rec.keys()}")
                # Canonical shape minus categories.
                self.assertIn('karaoke_numbers', rec)
                self.assertIn('crawled_at', rec)
                self.assertIn('title_primary', rec)
                self.assertIn('artist_primary', rec)

    def test_existing_code_skipped_not_duplicated(self) -> None:
        """A PDF code that already exists in the corpus (non-tjpdf row) is
        skipped — no duplicate tjpdf-* record is created.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text(self._SYNTHETIC_PDF, encoding='utf-8')
            # Corpus has only blog-68001 (TJ 68001). 28500 is brand-new.
            songs_path.write_text(
                json.dumps([self._make_corpus()[0]], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            ids = sorted(r['id'] for r in corpus)
            # 68001 stays as blog-68001 (skipped, no tjpdf-68001 created).
            self.assertIn('blog-68001', ids)
            self.assertNotIn('tjpdf-68001', ids,
                'existing code must not produce a duplicate tjpdf-* record')
            # 28500 is brand-new → inserted.
            self.assertIn('tjpdf-28500', ids)

    def test_tjpdf_record_artist_aliases_preserved_across_runs(self) -> None:
        """Regression: the pre-pass drops every tjpdf-* row and the new-record
        insert path re-creates them from PDF data; without explicit carry-forward
        of artist_aliases the alias list was silently stripped every run (data
        loss + byte-instability). This test seeds a tjpdf-28500 row with
        artist_aliases, runs the ingest, and asserts the aliases survive in the
        canonical key position (after artist_ko, before karaoke_numbers).
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text(self._SYNTHETIC_PDF, encoding='utf-8')
            corpus = self._make_corpus()
            # Seed the tjpdf-28500 row (matches the synthetic PDF's TJ code) with
            # an alias list at the canonical position.
            tjpdf_rec = next(r for r in corpus if r['id'] == 'tjpdf-28500')
            # Rebuild dict in canonical key order with artist_aliases injected
            # between artist_ko and karaoke_numbers.
            canonical = {}
            for k in ('id', 'source_url', 'title_primary', 'title_ko',
                      'artist_primary', 'artist_ko'):
                canonical[k] = tjpdf_rec[k]
            canonical['artist_aliases'] = ['黒うさ', '黒うさＰ']
            for k in ('karaoke_numbers', 'crawled_at'):
                canonical[k] = tjpdf_rec[k]
            corpus[corpus.index(tjpdf_rec)] = canonical
            songs_path.write_text(
                json.dumps(corpus, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            after = json.loads(songs_path.read_text(encoding='utf-8'))
            re_inserted = next((r for r in after if r['id'] == 'tjpdf-28500'), None)
            self.assertIsNotNone(re_inserted)
            assert re_inserted is not None  # for type narrowing
            self.assertEqual(
                re_inserted.get('artist_aliases'), ['黒うさ', '黒うさＰ'],
                'artist_aliases must survive the drop-and-recreate cycle',
            )
            # Canonical position: artist_aliases sits between artist_ko and
            # karaoke_numbers (matches the merger output and the alias-resolver
            # emission pattern). Insertion-order serialization makes this
            # observable on the dict's key list.
            keys = list(re_inserted.keys())
            self.assertEqual(
                keys.index('artist_aliases'), keys.index('artist_ko') + 1,
                f'artist_aliases must immediately follow artist_ko, got keys={keys!r}',
            )
            self.assertLess(
                keys.index('artist_aliases'), keys.index('karaoke_numbers'),
                f'artist_aliases must precede karaoke_numbers, got keys={keys!r}',
            )


class TestDropListFilter(unittest.TestCase):
    """Drop-list filter (post-Phase-2 Gap 3): a parsed PDF row whose artist
    matches the Korean-artist drop set must NOT be inserted as a new record.

    Exercises `is_artist_in_drop_list` directly + the main()-level integration
    against a synthetic drop-list sidecar.
    """

    def test_normalize_for_match_matches_ts_rule(self) -> None:
        # Whitespace-strip, case-fold, NFKC. Mirrors the TS source's rule.
        self.assertEqual(ingest.normalize_for_match('  BTS  '), 'bts')
        self.assertEqual(ingest.normalize_for_match('Le Sserafim'), 'lesserafim')
        # Full-width Latin should NFKC-collapse to ASCII.
        self.assertEqual(ingest.normalize_for_match('ＴＶＸＱ'), 'tvxq')

    def test_artist_components_for_drop_check_splits_collabs(self) -> None:
        # Bare single artist: round-trips.
        self.assertEqual(
            ingest.artist_components_for_drop_check('YOASOBI'),
            ['YOASOBI'],
        )
        # Feat parenthetical: emits whole + lead + featured.
        comps = ingest.artist_components_for_drop_check('imase(Feat.IU)')
        self.assertIn('imase', comps)
        self.assertIn('IU', comps)
        # `of` INSIDE a feat parenthetical: produces head + tail tokens
        # (Fix 1, 2026-05-01 — `of` sub-split is scoped to feat/prod parens).
        comps = ingest.artist_components_for_drop_check('MAX(Feat.SUGA of BTS)')
        self.assertIn('SUGA', comps,
            f'feat-paren `of` sub-split should yield SUGA, got {comps}')
        self.assertIn('BTS', comps,
            f'feat-paren `of` sub-split should yield BTS, got {comps}')

    def test_artist_components_for_drop_check_does_not_split_bare_of(self) -> None:
        # Fix 1 (2026-05-01): bare ` of ` outside feat/prod parens must NOT
        # split. Cross-language parity with the TS `splitArtistCollab` rule —
        # `Bump of Chicken` (real Japanese rock band) and similar names must
        # round-trip unchanged so they don't get falsely flagged as collabs.
        comps = ingest.artist_components_for_drop_check('Bump of Chicken')
        # Only the whole string should appear.
        self.assertEqual(comps, ['Bump of Chicken'],
            f'bare `of` must not sub-split, got {comps}')
        # Bare `SUGA of BTS` (no feat/prod paren) similarly does not split —
        # the parser-side drop-list catches the whole string via the
        # `SUGA of BTS` variant key directly.
        comps = ingest.artist_components_for_drop_check('SUGA of BTS')
        self.assertEqual(comps, ['SUGA of BTS'],
            f'bare `SUGA of BTS` must not sub-split, got {comps}')

    def test_is_artist_in_drop_list_positive_negative(self) -> None:
        drop_keys = {'tvxq', 'bts', '東方神起', '방탄소년단', 'iu'}
        self.assertTrue(ingest.is_artist_in_drop_list('TVXQ', drop_keys))
        self.assertTrue(ingest.is_artist_in_drop_list('東方神起', drop_keys))
        self.assertTrue(ingest.is_artist_in_drop_list('imase(Feat.IU)', drop_keys))
        self.assertTrue(ingest.is_artist_in_drop_list('LiSA(Feat.SUGA of BTS)', drop_keys))
        self.assertFalse(ingest.is_artist_in_drop_list('YOASOBI', drop_keys))
        self.assertFalse(ingest.is_artist_in_drop_list('Linked Horizon', drop_keys))

    def test_empty_drop_keys_disables_filter(self) -> None:
        # Graceful-degradation case: missing sidecar => empty set => no-op.
        self.assertFalse(ingest.is_artist_in_drop_list('TVXQ', set()))
        self.assertFalse(ingest.is_artist_in_drop_list('imase(Feat.IU)', set()))

    def test_main_skips_kpop_row_with_sidecar_present(self) -> None:
        """End-to-end: a parsed PDF row for 東方神起 / TVXQ must not produce
        a tjpdf-* record when the sidecar contains the act's keys.

        We patch parse_pdf to return one drop-list-matching row + one normal
        row (28500 / 黒うさP). Expected post-run state:
          - tjpdf-26709 NOT inserted (drop-list match)
          - tjpdf-28500 inserted (normal row)
        """
        synthetic_sidecar = {
            'version': 1,
            'generatedAt': '2026-05-01T00:00:00Z',
            'keys': ['tvxq', '동방신기', '東方神起'],
        }
        fake_parse_result = (
            [
                {
                    'tj': '26709',
                    'title': 'STEP BY STEP',
                    'artist': '東方神起',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                },
                {
                    'tj': '28500',
                    'title': '千本桜',
                    'artist': '黒うさP',
                    'title_ko': '센본자쿠라',
                    'artist_ko': '쿠로우사P',
                    'source_line': 1,
                },
            ],
            [],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            sidecar_path = Path(tmpdir) / 'drop-list.json'

            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            sidecar_path.write_text(
                json.dumps(synthetic_sidecar, ensure_ascii=False, indent=2),
                encoding='utf-8',
            )

            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'DROP_LIST_SIDECAR', sidecar_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            ids = sorted(r['id'] for r in corpus)
            # 東方神起 row must be absent; 黒うさP row must be present.
            self.assertIn('tjpdf-28500', ids)
            self.assertNotIn('tjpdf-26709', ids,
                f'東方神起 row should be drop-list-filtered, got {ids}')

    def test_main_warns_when_sidecar_missing(self) -> None:
        """When the sidecar is absent, main() must log a warning to stderr and
        proceed without the filter (graceful degradation).
        """
        fake_parse_result = (
            [
                {
                    'tj': '26709',
                    'title': 'STEP BY STEP',
                    'artist': '東方神起',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            missing_sidecar = Path(tmpdir) / 'absent.json'  # never created

            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            stderr_buf = io.StringIO()
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'DROP_LIST_SIDECAR', missing_sidecar),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
                patch('sys.stderr', stderr_buf),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            self.assertIn('drop-list sidecar not found', stderr_buf.getvalue())

            # Without the filter, the 東方神起 row should still be inserted.
            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            ids = [r['id'] for r in corpus]
            self.assertIn('tjpdf-26709', ids)


class TestDropSplitReContents(unittest.TestCase):
    """Parity-protection tests for `DROP_SPLIT_RE` character contents."""

    def test_drop_split_re_contains_full_width_pipe_for_ts_parity(self):
        """U+FF5C parity with TS SPLIT_RE — protects against future regex tidying."""
        self.assertIn('｜', ingest.DROP_SPLIT_RE.pattern)


class TestIsoUtcNow(unittest.TestCase):
    """Verify iso_utc_now() output is byte-compatible with JS toISOString()."""

    def test_ends_with_z(self) -> None:
        result = ingest.iso_utc_now()
        self.assertTrue(result.endswith('Z'), f"Expected Z suffix, got {result!r}")

    def test_length_is_24(self) -> None:
        result = ingest.iso_utc_now()
        self.assertEqual(len(result), 24, f"Expected length 24, got {len(result)} for {result!r}")

    def test_parses_as_datetime(self) -> None:
        import datetime as _dt
        result = ingest.iso_utc_now()
        # Strip Z and parse — fromisoformat accepts ISO-8601 without timezone suffix
        parsed = _dt.datetime.fromisoformat(result[:-1])
        self.assertIsNotNone(parsed)

    def test_has_millisecond_precision(self) -> None:
        # Format: YYYY-MM-DDTHH:MM:SS.mmmZ — the last 4 chars before Z are .mmm
        result = ingest.iso_utc_now()
        ms_part = result[-4:-1]
        self.assertEqual(len(ms_part), 3, f"Expected 3-digit ms, got {ms_part!r} from {result!r}")
        self.assertTrue(ms_part.isdigit(), f"ms part not digits: {ms_part!r}")

    def test_lex_compare_compatible_with_js_format(self) -> None:
        # A timestamp well in the past must sort before a far-future JS-format reference.
        result = ingest.iso_utc_now()
        future_ref = '2099-12-31T23:59:59.999Z'
        self.assertLess(result, future_ref, f"{result!r} should sort before {future_ref!r}")
        # A far-past reference must sort before our result.
        past_ref = '2000-01-01T00:00:00.000Z'
        self.assertGreater(result, past_ref, f"{result!r} should sort after {past_ref!r}")


class TestExtractTitleFromPrefix(unittest.TestCase):
    """Unit tests for `_extract_title_from_prefix`."""

    def test_basic_jp_title(self) -> None:
        # Normal case: pure JP chunk after a Hangul anime-name chunk.
        # Column gap >= 4 spaces separates them.
        title, sort_idx = ingest._extract_title_from_prefix('진격의 거인         紅蓮の弓矢')
        self.assertEqual(title, '紅蓮の弓矢')
        self.assertIsNone(sort_idx)

    def test_no_sort_index_always_none(self) -> None:
        # The PDF does not encode a sort index; second return value is always None.
        _, sort_idx = ingest._extract_title_from_prefix('마법소녀          千本桜')
        self.assertIsNone(sort_idx)

    def test_pure_jp_no_anime_column(self) -> None:
        # No anime-name prefix at all — just the title.
        title, _ = ingest._extract_title_from_prefix('夜に駆ける')
        self.assertEqual(title, '夜に駆ける')

    def test_latin_title(self) -> None:
        title, _ = ingest._extract_title_from_prefix('앤씨아         UNION')
        self.assertEqual(title, 'UNION')

    def test_hangul_fused_with_jp_split_at_transition(self) -> None:
        # Residual #1b: column gap < 4 spaces, anime-name and title fuse.
        # '그리드맨 유니버스 UNION' — Hangul prefix, then Latin title.
        title, _ = ingest._extract_title_from_prefix('그리드맨 유니버스 UNION')
        self.assertEqual(title, 'UNION')

    def test_hangul_fused_with_kana_split_at_transition(self) -> None:
        # Deeper residual #1b: fused chunk contains Hangul + JP kana.
        # The function should split and return the non-Hangul tail.
        title, _ = ingest._extract_title_from_prefix('돌아가는 펭귄드럼  少年よ我に帰れ')
        self.assertEqual(title, '少年よ我に帰れ')

    def test_empty_prefix(self) -> None:
        title, sort_idx = ingest._extract_title_from_prefix('')
        self.assertEqual(title, '')
        self.assertIsNone(sort_idx)

    def test_whitespace_only_prefix(self) -> None:
        title, _ = ingest._extract_title_from_prefix('   ')
        self.assertEqual(title, '')

    def test_pure_hangul_prefix_no_transition(self) -> None:
        # Pure Hangul, no kana/han, no ASCII alpha → no transition possible.
        # Result is empty because there's no non-Hangul chunk.
        title, _ = ingest._extract_title_from_prefix('그리드맨 유니버스')
        self.assertEqual(title, '')

    def test_multiple_chunks_takes_last(self) -> None:
        # Three chunks separated by >=4 spaces: last non-Hangul wins.
        title, _ = ingest._extract_title_from_prefix('아니메명    中間タイトル    最終タイトル')
        self.assertEqual(title, '最終タイトル')


class TestCollectArtistWraps(unittest.TestCase):
    """Unit tests for `_collect_artist_wraps`."""

    def _lines(self, *raw: str) -> list[str]:
        """Wrap each string in a list entry with a newline."""
        return [s + '\n' for s in raw]

    def test_single_line_no_wrap(self) -> None:
        # Anchor at index 0; next line is a new anchor — no wraps collected.
        lines = self._lines(
            '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon',
            '마법소녀          千本桜                       28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, None)
        self.assertEqual(pieces, [])
        self.assertEqual(j, 1)

    def test_single_wrap_line(self) -> None:
        # A wrap row with deep indent (no anchor, non-Hangul content).
        # artist_col_on_anchor=None triggers legacy indent threshold.
        lines = self._lines(
            '진격의 거인         紅蓮の弓矢                   68001  Fear, and Loathing',
            '                                                       in Las Vegas',
            '마법소녀          千本桜                       28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, None)
        self.assertEqual(pieces, ['in Las Vegas'])
        self.assertEqual(j, 2)

    def test_blank_line_gap_tolerated(self) -> None:
        # One blank line between anchor and wrap row is allowed (tjpdf-27708).
        lines = self._lines(
            '진격의 거인         紅蓮の弓矢                   68001  Fear, and Loathing',
            '',
            '                                                       in Las Vegas',
            '마법소녀          千本桜                       28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, None)
        self.assertEqual(pieces, ['in Las Vegas'])
        self.assertEqual(j, 3)

    def test_two_blank_lines_stops(self) -> None:
        # Second blank line: loop breaks, no wraps.
        lines = self._lines(
            '진격의 거인         紅蓮の弓矢                   68001  Artist',
            '',
            '',
            '                                                       continuation',
            '마법소녀          千本桜                       28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, None)
        self.assertEqual(pieces, [])
        self.assertEqual(j, 1)

    def test_artist_col_anchor_aware_picks_right_chunk(self) -> None:
        # Wrap row has two chunks: Hangul at col 0, JP at col 55.
        # artist_col_on_anchor=55 → picks the JP chunk.
        wrap_row = ' ' * 55 + '竹達彩奈'
        lines = self._lines(
            '오버런!                     タイトル                   28238  CV.',
            wrap_row,
            '마법소녀          千本桜                       28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, 55)
        self.assertEqual(pieces, ['竹達彩奈'])
        self.assertEqual(j, 2)

    def test_artist_col_anchor_aware_rejects_distant_chunk(self) -> None:
        # Wrap row has only a chunk at col 0, but artist_col is 55 → too far → no wrap.
        wrap_row = 'アニメ名続き'
        lines = self._lines(
            'タイトル                   28238  Artist',
            wrap_row,
            '次のタイトル               28500  黒うさP',
        )
        pieces, j = ingest._collect_artist_wraps(lines, 0, 55)
        self.assertEqual(pieces, [])
        self.assertEqual(j, 1)


class TestCollectTranslitLines(unittest.TestCase):
    """Unit tests for `_collect_translit_lines`."""

    def _lines(self, *raw: str) -> list[str]:
        return [s + '\n' for s in raw]

    def test_single_translit_line(self) -> None:
        lines = self._lines(
            '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon',
            '                   홍련의 궁시                          링크드 호라이즌',
            '마법소녀          千本桜                       28500  黒うさP',
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(len(result), 1)
        self.assertIn('홍련의 궁시', result[0])

    def test_two_translit_lines(self) -> None:
        # title_ko on line 1, artist_ko on line 2 (e.g. tjpdf-68560 / tjpdf-28458).
        lines = self._lines(
            '타이틀행         タイトル                   68560  アーティスト',
            '                 타이틀코',
            '                                                  아티스트코',
            '다음행           次の曲                      28458  別アーティスト',
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(len(result), 2)

    def test_absent_translit_returns_empty(self) -> None:
        lines = self._lines(
            'タイトル                   68001  Artist',
            '次のタイトル               28500  黒うさP',
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(result, [])

    def test_blank_lines_skipped(self) -> None:
        # A blank line between anchor and translit is ignored.
        lines = self._lines(
            '타이틀         タイトル                   68001  Artist',
            '',
            '               한국어 제목                        아티스트',
            '다음           次の曲                      28500  黒うさP',
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(len(result), 1)
        self.assertIn('한국어 제목', result[0])

    def test_non_translit_interim_skipped_before_first(self) -> None:
        # A JP title-wrap row (non-Hangul) before the translit is skipped
        # when no translit has been found yet (e.g. tjpdf-28260).
        lines = self._lines(
            '타이틀         良いメロン                   28260  アーティスト',
            '               ~',          # non-translit JP wrap row
            '               한국어 제목                        아티스트',
            '다음           次の曲                      28500  黒うさP',
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(len(result), 1)
        self.assertIn('한국어 제목', result[0])

    def test_stops_at_next_anchor(self) -> None:
        lines = self._lines(
            'タイトル                   68001  Artist',
            '다음タイトル               28500  黒うさP',  # anchor on next line
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(result, [])

    def test_window_limit_six_lines(self) -> None:
        # Translit at position i+7 (out of window) is not collected.
        lines = (
            ['タイトル                   68001  Artist\n']
            + ['               途中行\n'] * 6      # 6 non-translit, non-anchor lines
            + ['               한국어\n']           # at i+7, out of window
        )
        result = ingest._collect_translit_lines(lines, 0, len(lines))
        self.assertEqual(result, [])


if __name__ == '__main__':
    unittest.main()
