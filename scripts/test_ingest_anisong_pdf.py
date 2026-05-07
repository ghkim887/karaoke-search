"""Regression tests for `scripts/ingest_anisong_pdf.py`.

Stdlib-only (`unittest`, no extra deps). Covers the three helpers most prone to
silent regression: category exclusivity, anchor extraction (false-positive
floor + rightmost-pick), and Hangul→non-Hangul transition splitting.

Also includes fixture-based end-to-end tests for `parse_pdf()` against synthetic
PDF-text snippets (TestParsePdfFixtures) and an idempotency round-trip test
(TestIngestIdempotent).

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


class TestParsePdfFixtures(unittest.TestCase):
    """Fixture-based end-to-end tests for `parse_pdf()`.

    Synthetic snippets are Python strings that mimic the column-aligned output
    produced by `pdftotext -table`. Each test is self-contained with no shared
    state.

    `parse_pdf()` returns (records, caveats) where each record dict contains:
      'tj', 'title', 'artist', 'title_ko', 'artist_ko', 'source_line', 'section'

    The 'section' field is the category string ('anime' or 'vocaloid') that
    main() later writes into `categories`.
    """

    def test_parse_pdf_anime_row(self) -> None:
        """A single anime section header followed by one anime data row.

        Expected: exactly one record with section=='anime', the correct TJ
        number, title_primary candidate (title field), and artist_primary
        candidate (artist field).

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
        self.assertEqual(rec['section'], 'anime')
        self.assertEqual(rec['tj'], '68001')
        self.assertIn('紅蓮の弓矢', rec['title'], f"title should contain the JP title, got {rec['title']!r}")
        self.assertIn('Linked Horizon', rec['artist'], f"artist should contain artist name, got {rec['artist']!r}")

    def test_parse_pdf_vocaloid_section_transition(self) -> None:
        """Anime header → 1 anime row → 보컬로이드, divider → 1 vocaloid row.

        Expected: 2 records. First has section=='anime', second has
        section=='vocaloid'. This exercises the _SECTION_DIVIDERS state-machine
        transition: the divider line is recognised BEFORE the anchor on the same
        line, so the divider row itself belongs to the new section.
        """
        # The vocaloid divider line from the real PDF (line 8280):
        #   보컬로이드,       1925                                    28000  冨田悠斗(とみー/T-POCKET)
        # Note: 1925 is below _MIN_TJ_CODE (5000) and is ignored; 28000 is the
        # real TJ code on the same line, so the divider row DOES emit a record.
        lines = [
            '진격의 거인         紅蓮の弓矢                   68001  Linked Horizon\n',
            '                   홍련의 궁시                          링크드 호라이즌\n',
            '\n',
            '보컬로이드,         千本桜                       28500  黒うさP\n',
            '                   센본자쿠라                           쿠로우사P\n',
        ]
        records, caveats = ingest.parse_pdf(lines)
        self.assertEqual(len(records), 2, f'expected 2 records, got {len(records)}: {records}')
        self.assertEqual(records[0]['section'], 'anime',
                         f"first record should be anime, got {records[0]['section']!r}")
        self.assertEqual(records[1]['section'], 'vocaloid',
                         f"second record should be vocaloid, got {records[1]['section']!r}")
        # Also verify the TJ codes are correct.
        self.assertEqual(records[0]['tj'], '68001')
        self.assertEqual(records[1]['tj'], '28500')

    def test_parse_pdf_unknown_section_defaults_to_anime(self) -> None:
        """Unknown section name defaults to 'anime' with a stderr warning.

        `parse_pdf()` itself only tracks section via `_SECTION_DIVIDERS`; it
        cannot produce an unknown section string from its own parsing. The
        warning for unknown sections lives in `main()`, which processes the
        parsed output. We verify both sides:

        1. `detect_section_divider()` returns None for an unknown keyword, so
           `parse_pdf()` stays at the default 'anime' section — confirming the
           parse layer never produces an unknown section string.

        2. The `main()` warning path: we construct a parsed record dict with
           section='tokusatsu' (unknown) and exercise the warning branch by
           patching ingest module paths and calling main() with a minimal
           synthetic corpus. The warning must appear on stderr and the record
           must be written with categories=['anime'].
        """
        # Part 1: detect_section_divider with an unknown keyword returns None.
        unknown_line = '토쿠사츠,    千本桜                       28500  黒うさP'
        result = ingest.detect_section_divider(unknown_line)
        self.assertIsNone(result,
            'detect_section_divider should return None for unknown keyword')

        # Part 2: parse_pdf never produces an unknown section — all lines that
        # don't match a known divider keep the current_section (defaults to anime).
        lines = [
            '토쿠사츠,    千本桜                       28500  黒うさP\n',
        ]
        records, _caveats = ingest.parse_pdf(lines)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['section'], 'anime',
            f"unknown-keyword line should keep section='anime', got {records[0]['section']!r}")

        # Part 3: exercise the main() warning branch by patching SONGS_JSON and
        # PDF_TEXT to point at synthetic temp files. We inject a record with an
        # unknown section via a synthetic PDF text file, then confirm the stderr
        # warning is emitted and the resulting record gets categories=['anime'].
        #
        # The only way to get an unknown section into main()'s loop is to inject
        # it into the `unique` list that parse_pdf() produces. Since parse_pdf()
        # can't produce an unknown section (Part 2 above), we patch parse_pdf
        # itself to return a synthetic record with section='tokusatsu'.
        synthetic_song = {
            'id': 'blog-99999',
            'source_url': 'https://example.com',
            'title_primary': '千本桜',
            'title_ko': '센본자쿠라',
            'artist_primary': '黒うさP',
            'artist_ko': '쿠로우사P',
            'karaoke_numbers': {'tj': '28500', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        }
        fake_parse_result = ([{
            'tj': '99901',
            'title': '千本桜',
            'artist': '黒うさP',
            'title_ko': None,
            'artist_ko': None,
            'source_line': 0,
            'section': 'tokusatsu',  # unknown section
        }], [])

        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            # Minimal PDF text (content doesn't matter — parse_pdf is patched).
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([synthetic_song], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )

            stderr_buf = io.StringIO()
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
                patch('sys.stderr', stderr_buf),
            ):
                exit_code = ingest.main()

            self.assertEqual(exit_code, 0, 'main() should succeed')
            stderr_output = stderr_buf.getvalue()
            self.assertIn('tokusatsu', stderr_output,
                f'expected stderr warning mentioning unknown section, got: {stderr_output!r}')

            # The new record with the unknown section must default to anime.
            result_corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            new_recs = [r for r in result_corpus if r.get('id', '').startswith('tjpdf-')]
            self.assertEqual(len(new_recs), 1, f'expected 1 new tjpdf- record, got {new_recs}')
            self.assertEqual(new_recs[0]['categories'], ['anime'],
                f"unknown section should default to anime, got {new_recs[0]['categories']!r}")


class TestIngestIdempotent(unittest.TestCase):
    """Round-trip idempotency: running the ingest twice on the same synthetic
    corpus + PDF text produces a byte-identical output on the second run.

    Uses tempfile.TemporaryDirectory so no real files are mutated. Patches
    the module-level SONGS_JSON and PDF_TEXT constants so main() operates on
    the temp files rather than the real repo paths.

    Synthetic corpus has 3 records:
      - 1 TJ-numbered record (TJ 68001) — will get its category updated.
      - 1 record without a TJ number — untouched by the ingest.
      - 1 existing tjpdf-* record — will be dropped and re-inserted.
    """

    # Minimal synthetic PDF text with two anime records (TJ 68001 and TJ 28500)
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
                'categories': ['jpop'],
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
                'categories': ['jpop'],
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
                'categories': ['anime'],
                'crawled_at': '2026-03-01T00:00:00+00:00',
            },
        ]

    def test_apply_categories_to_existing_records_idempotent(self) -> None:
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

            # Sanity-check the first run's output: the blog-68001 record should
            # have been updated to categories=['anime'] (anime wins over jpop).
            corpus = json.loads(output_1.decode('utf-8'))
            blog_rec = next((r for r in corpus if r['id'] == 'blog-68001'), None)
            self.assertIsNotNone(blog_rec, 'blog-68001 should still be present')
            self.assertEqual(blog_rec['categories'], ['anime'],  # type: ignore[index]
                f"blog-68001 categories should be ['anime'], got {blog_rec['categories']!r}")  # type: ignore[index]


class TestDropListFilter(unittest.TestCase):
    """Drop-list filter (post-Phase-2 Gap 3): a parsed PDF row whose artist
    matches the Korean-artist drop set must NOT be inserted as a new record
    OR be used to patch an existing record's categories.

    Exercises `is_artist_in_drop_list` directly + the main()-level integration
    against a synthetic drop-list sidecar.
    """

    def test_normalize_for_match_matches_ts_rule(self) -> None:
        # Whitespace-strip, case-fold, NFKC. Mirrors the TS source's rule.
        self.assertEqual(ingest._normalize_for_match('  BTS  '), 'bts')
        self.assertEqual(ingest._normalize_for_match('Le Sserafim'), 'lesserafim')
        # Full-width Latin should NFKC-collapse to ASCII.
        self.assertEqual(ingest._normalize_for_match('ＴＶＸＱ'), 'tvxq')

    def test_artist_components_for_drop_check_splits_collabs(self) -> None:
        # Bare single artist: round-trips.
        self.assertEqual(
            ingest._artist_components_for_drop_check('YOASOBI'),
            ['YOASOBI'],
        )
        # Feat parenthetical: emits whole + lead + featured.
        comps = ingest._artist_components_for_drop_check('imase(Feat.IU)')
        self.assertIn('imase', comps)
        self.assertIn('IU', comps)
        # `of` INSIDE a feat parenthetical: produces head + tail tokens
        # (Fix 1, 2026-05-01 — `of` sub-split is scoped to feat/prod parens).
        comps = ingest._artist_components_for_drop_check('MAX(Feat.SUGA of BTS)')
        self.assertIn('SUGA', comps,
            f'feat-paren `of` sub-split should yield SUGA, got {comps}')
        self.assertIn('BTS', comps,
            f'feat-paren `of` sub-split should yield BTS, got {comps}')

    def test_artist_components_for_drop_check_does_not_split_bare_of(self) -> None:
        # Fix 1 (2026-05-01): bare ` of ` outside feat/prod parens must NOT
        # split. Cross-language parity with the TS `splitArtistCollab` rule —
        # `Bump of Chicken` (real Japanese rock band) and similar names must
        # round-trip unchanged so they don't get falsely flagged as collabs.
        comps = ingest._artist_components_for_drop_check('Bump of Chicken')
        # Only the whole string should appear.
        self.assertEqual(comps, ['Bump of Chicken'],
            f'bare `of` must not sub-split, got {comps}')
        # Bare `SUGA of BTS` (no feat/prod paren) similarly does not split —
        # the parser-side drop-list catches the whole string via the
        # `SUGA of BTS` variant key directly.
        comps = ingest._artist_components_for_drop_check('SUGA of BTS')
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
        a tjpdf-* record when the sidecar contains the act's keys, AND must
        not patch an existing corpus row's categories.

        We patch parse_pdf to return one drop-list-matching row + one normal
        row (28500 / 黒うさP). Expected post-run state:
          - tjpdf-26709 NOT inserted (drop-list match)
          - tjpdf-28500 inserted (normal vocaloid row)
          - dropped_kpop counter == 1
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
                    'section': 'anime',
                },
                {
                    'tj': '28500',
                    'title': '千本桜',
                    'artist': '黒うさP',
                    'title_ko': '센본자쿠라',
                    'artist_ko': '쿠로우사P',
                    'source_line': 1,
                    'section': 'vocaloid',
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
                    'section': 'anime',
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


class TestPdfVocaloidDenylist(unittest.TestCase):
    """PDF vocaloid-section denylist (Fix 1, 2026-05-04 — TODO 1 from the
    2026-05-03 vocaloid-mistag audit).

    The PDF's `보컬로이드,` section mixes real Vocaloid producers with non-
    Vocaloid bands that have anime/Nicodō tie-in tracks. The 7-entry denylist
    downgrades known-mistagged acts from `vocaloid` to `anime` at ingest time.
    Mirrors the membership semantics of `is_artist_in_drop_list` (any
    component of the artist string can match).
    """

    def test_helper_matches_lead_artist(self) -> None:
        # Bare denylisted lead → match.
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('HoneyWorks'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('Gackt'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('GARNiDELiA'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('LIP×LIP'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('三月のパンタシア'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_denylist('Team.ねこかん[猫]'))

    def test_helper_matches_collab_lead(self) -> None:
        # `(Feat.X)` parenthetical: lead component still matches even though
        # the featured act is a real Vocaloid (per spec — every PDF-section
        # HoneyWorks row is a human-vocal mistag; legitimate HoneyWorks×
        # Vocaloid records reach the corpus via the blog adapter).
        self.assertTrue(
            ingest.is_artist_in_pdf_vocaloid_denylist('HoneyWorks(Feat.GUMI)')
        )
        self.assertTrue(
            ingest.is_artist_in_pdf_vocaloid_denylist('HoneyWorks(Feat.初音ミク)')
        )

    def test_helper_matches_with_collab_form(self) -> None:
        # `CHiCO with HoneyWorks` and `CHiCOwithHoneyWorks` collapse to the
        # same normalized key after whitespace strip — both must match.
        self.assertTrue(
            ingest.is_artist_in_pdf_vocaloid_denylist('CHiCOwithHoneyWorks')
        )
        self.assertTrue(
            ingest.is_artist_in_pdf_vocaloid_denylist('CHiCO with HoneyWorks')
        )

    def test_helper_matches_meets_collab_form(self) -> None:
        # Regression guard for MAJOR finding (code-review pass, 2026-05-04):
        # `_DROP_SPLIT_RE` previously lacked `\s+meets\s+`, so the corpus
        # record `tj-68335` ('CHiCO with HoneyWorks meets 中川翔子') produced
        # components ['CHiCO with HoneyWorks meets 中川翔子', 'CHiCO',
        # 'HoneyWorks meets 中川翔子'] — none of which matched 'HoneyWorks'.
        # The fix adds `\s+meets\s+` to `_DROP_SPLIT_RE` so 'HoneyWorks'
        # surfaces as a standalone component and triggers the denylist.
        self.assertTrue(
            ingest.is_artist_in_pdf_vocaloid_denylist(
                'CHiCO with HoneyWorks meets 中川翔子'
            )
        )

    def test_helper_misses_legitimate_vocaloid_producer(self) -> None:
        # Real Vocaloid producers must NOT match. Sanity sample.
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_denylist('黒うさP'))
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_denylist('ryo(supercell)'))
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_denylist('ナノウ'))
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_denylist('冨田悠斗'))
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_denylist('YOASOBI'))

    def test_main_downgrades_denylisted_vocaloid_row(self) -> None:
        """End-to-end: a parsed PDF row with section='vocaloid' AND a
        denylisted artist must be inserted as a tjpdf-* record with
        categories=['anime'], not ['vocaloid'].

        Co-tested: a non-denylisted vocaloid row in the same batch keeps its
        vocaloid tag — regression guard.
        """
        fake_parse_result = (
            [
                {
                    'tj': '28898',
                    'title': 'Gokuraku Jodo',
                    'artist': 'GARNiDELiA',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'vocaloid',  # PDF said vocaloid…
                },
                {
                    'tj': '28500',
                    'title': '千本桜',
                    'artist': '黒うさP',
                    'title_ko': '센본자쿠라',
                    'artist_ko': '쿠로우사P',
                    'source_line': 1,
                    'section': 'vocaloid',  # …but this one is a real Vocaloid producer.
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            by_id = {r['id']: r for r in corpus}

            self.assertIn('tjpdf-28898', by_id)
            self.assertEqual(
                by_id['tjpdf-28898']['categories'],
                ['anime'],
                f"GARNiDELiA should downgrade to anime, got {by_id['tjpdf-28898']['categories']!r}",
            )

            self.assertIn('tjpdf-28500', by_id)
            self.assertEqual(
                by_id['tjpdf-28500']['categories'],
                ['vocaloid'],
                f"黒うさP should stay vocaloid, got {by_id['tjpdf-28500']['categories']!r}",
            )


class TestPdfVocaloidSkipList(unittest.TestCase):
    """PDF vocaloid-section skip-list (2026-05-07).

    Mainstream artists the PDF erroneously placed in its vocaloid section whose
    tracks are NOT anime tie-ins. Skip-list rows skip section-tagging entirely —
    the corpus record's existing categories are preserved unchanged.

    Processed BEFORE the denylist: skip-list match suppresses both vocaloid AND
    anime tagging; denylist match (non-skip) downgrades vocaloid→anime.
    """

    def test_helper_matches_skip_list_artists(self) -> None:
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_skip_list('米津玄師'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_skip_list('ずっと真夜中でいいのに。'))
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_skip_list('Aimer'))

    def test_helper_matches_co_vocalist_form(self) -> None:
        # Blog adapter emits `米津玄師(+菅田将暉)` for co-vocalist tracks.
        # The `(+X)` parenthetical is not split by _DROP_SPLIT_RE, so the helper
        # must strip it before the key lookup to get `米津玄師` as the lead.
        self.assertTrue(ingest.is_artist_in_pdf_vocaloid_skip_list('米津玄師(+菅田将暉)'))

    def test_helper_misses_denylist_artist(self) -> None:
        # HoneyWorks is on the denylist, NOT the skip-list.
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_skip_list('HoneyWorks'))

    def test_helper_misses_yonezu_vocaloid_alias(self) -> None:
        # ハチ is Yonezu's Vocaloid alias — a different artist_primary string.
        # The skip-list matches `米津玄師` only, not `ハチ`.
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_skip_list('ハチ'))

    def test_helper_misses_unrelated_artist(self) -> None:
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_skip_list('YOASOBI'))
        self.assertFalse(ingest.is_artist_in_pdf_vocaloid_skip_list('黒うさP'))

    def test_main_skips_section_tag_for_skip_list_artist(self) -> None:
        """End-to-end: a parsed PDF row with section='vocaloid' AND a skip-list
        artist must NOT modify the existing corpus record's categories, AND must
        NOT insert a new tjpdf-* record.

        Fixture: one existing corpus record (tj 98001) for 米津玄師 with
        categories=['jpop']. One vocaloid-section PDF row for the same code.
        After ingest, the record must still have categories=['jpop'].

        Co-tested: a normal vocaloid row in the same batch (黒うさP / tj 28500)
        still gets its vocaloid tag — skip-list is not a blanket suppressor.
        """
        existing_song = {
            'id': 'tj-98001',
            'source_url': 'https://www.tjmedia.com/legacy/api/newSongOfMonth',
            'title_primary': 'Lemon',
            'title_ko': None,
            'artist_primary': '米津玄師',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '98001', 'ky': None, 'joysound': None},
            'categories': ['jpop'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        }
        fake_parse_result = (
            [
                {
                    'tj': '98001',
                    'title': 'Lemon',
                    'artist': '米津玄師',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'vocaloid',  # PDF said vocaloid — but skip-list match
                },
                {
                    'tj': '28500',
                    'title': '千本桜',
                    'artist': '黒うさP',
                    'title_ko': '센본자쿠라',
                    'artist_ko': '쿠로우사P',
                    'source_line': 1,
                    'section': 'vocaloid',  # normal vocaloid row — must stay vocaloid
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([existing_song], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            by_id = {r['id']: r for r in corpus}

            # 米津玄師 record must be unchanged — still jpop, no vocaloid added.
            self.assertIn('tj-98001', by_id)
            self.assertEqual(
                by_id['tj-98001']['categories'],
                ['jpop'],
                f"米津玄師 should keep jpop, got {by_id['tj-98001']['categories']!r}",
            )

            # No new tjpdf-98001 record should have been created (skip continues).
            self.assertNotIn('tjpdf-98001', by_id,
                'skip-list match must not insert a new tjpdf-* record')

            # Normal vocaloid row must still be inserted with vocaloid tag.
            self.assertIn('tjpdf-28500', by_id)
            self.assertEqual(
                by_id['tjpdf-28500']['categories'],
                ['vocaloid'],
                f"黒うさP should stay vocaloid, got {by_id['tjpdf-28500']['categories']!r}",
            )

    def test_main_scrubs_stale_vocaloid_on_skip_list_artist(self) -> None:
        """Stale-vocaloid scrub: an existing corpus row carrying `vocaloid` from
        a prior ingest that ran BEFORE the skip-list existed must have that tag
        removed when the current ingest's PDF row triggers the skip-list.

        Without the scrub, re-running the ingest after a prior bad run would
        leave the stale vocaloid tag in place forever (the `continue` alone only
        prevents NEW section tags — it can't retroactively clean prior runs).
        """
        existing_song_stale = {
            'id': 'tj-98001',
            'source_url': 'https://www.tjmedia.com/legacy/api/newSongOfMonth',
            'title_primary': 'Lemon',
            'title_ko': None,
            'artist_primary': '米津玄師',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '98001', 'ky': None, 'joysound': None},
            'categories': ['vocaloid'],  # stale tag from a prior bad ingest run
            'crawled_at': '2026-01-01T00:00:00+00:00',
        }
        fake_parse_result = (
            [
                {
                    'tj': '98001',
                    'title': 'Lemon',
                    'artist': '米津玄師',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'vocaloid',
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([existing_song_stale], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)

            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            by_id = {r['id']: r for r in corpus}

            self.assertIn('tj-98001', by_id)
            cats = by_id['tj-98001']['categories']
            self.assertNotIn(
                'vocaloid', cats,
                f"stale vocaloid must be scrubbed for skip-list artist, got {cats!r}",
            )
            # After scrubbing vocaloid the record must have a valid non-empty category.
            self.assertTrue(len(cats) > 0, f"categories must not be empty after scrub, got {cats!r}")


class TestDropSplitReContents(unittest.TestCase):
    """Parity-protection tests for `_DROP_SPLIT_RE` character contents."""

    def test_drop_split_re_contains_full_width_pipe_for_ts_parity(self):
        """U+FF5C parity with TS SPLIT_RE — protects against future regex tidying."""
        self.assertIn('｜', ingest._DROP_SPLIT_RE.pattern)

    def test_main_downgrades_collab_lead_match(self) -> None:
        """A `HoneyWorks(Feat.GUMI)` row in section='vocaloid' must downgrade
        to `anime` — the lead component matches the denylist, so the tag
        flips even though the featured act `GUMI` is a real Vocaloid.

        This documents the spec: every PDF-section HoneyWorks row is treated
        as a human-vocal anime track. Legitimate HoneyWorks×Vocaloid records
        reach the corpus via the blog adapter (which this filter never
        touches).
        """
        fake_parse_result = (
            [
                {
                    'tj': '28275',
                    'title': '可愛くなりたい',
                    'artist': 'HoneyWorks(Feat.GUMI)',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'vocaloid',
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(corpus), 1)
            self.assertEqual(
                corpus[0]['categories'],
                ['anime'],
                f"HoneyWorks(Feat.GUMI) should downgrade to anime, got {corpus[0]['categories']!r}",
            )

    def test_main_scrubs_stale_vocaloid_on_existing_row(self) -> None:
        """An existing corpus row (e.g. tj-27967) carrying a stale `vocaloid`
        tag from a prior ingest's tjpdf-* merge MUST have that tag scrubbed
        when the current ingest's PDF row triggers the denylist downgrade.

        Without the scrub, the union + applyCategoryExclusivity path sees
        `['vocaloid', 'anime']` and the vocaloid>anime priority re-elevates
        the tag — leaving the row mistagged forever. The scrub is what makes
        Fix 1 actually retag the merger-propagated tj-* rows the audit called
        out.
        """
        existing_song = {
            'id': 'tj-27967',
            'source_url': 'https://www.tjmedia.com/legacy/api/newSongOfMonth',
            'title_primary': '可愛くなりたい',
            'title_ko': None,
            'artist_primary': 'HoneyWorks(Feat.GUMI)',
            'artist_ko': None,
            'karaoke_numbers': {'tj': '27967', 'ky': None, 'joysound': None},
            'categories': ['vocaloid'],  # stale tag from prior merge
            'crawled_at': '2026-01-01T00:00:00+00:00',
        }
        fake_parse_result = (
            [
                {
                    'tj': '27967',
                    'title': '可愛くなりたい',
                    'artist': 'HoneyWorks(Feat.GUMI)',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'vocaloid',  # PDF still says vocaloid…
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([existing_song], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            tj_rec = next((r for r in corpus if r['id'] == 'tj-27967'), None)
            self.assertIsNotNone(tj_rec, 'tj-27967 must still be present')
            assert tj_rec is not None
            self.assertEqual(
                tj_rec['categories'],
                ['anime'],
                f'stale vocaloid must be scrubbed when downgrade triggers, '
                f"got {tj_rec['categories']!r}",
            )

    def test_main_does_not_scrub_vocaloid_on_non_denylisted_row(self) -> None:
        """Regression guard: a non-denylisted vocaloid row's existing
        `vocaloid` tag must NOT be scrubbed. Only the denylist match triggers
        the scrub.
        """
        existing_song = {
            'id': 'tj-28500',
            'source_url': 'https://www.tjmedia.com/legacy/api/newSongOfMonth',
            'title_primary': '千本桜',
            'title_ko': '센본자쿠라',
            'artist_primary': '黒うさP',
            'artist_ko': '쿠로우사P',
            'karaoke_numbers': {'tj': '28500', 'ky': None, 'joysound': None},
            'categories': ['vocaloid'],
            'crawled_at': '2026-01-01T00:00:00+00:00',
        }
        fake_parse_result = (
            [
                {
                    'tj': '28500',
                    'title': '千本桜',
                    'artist': '黒うさP',
                    'title_ko': '센본자쿠라',
                    'artist_ko': '쿠로우사P',
                    'source_line': 0,
                    'section': 'vocaloid',
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([existing_song], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            tj_rec = next((r for r in corpus if r['id'] == 'tj-28500'), None)
            self.assertIsNotNone(tj_rec)
            assert tj_rec is not None
            self.assertEqual(
                tj_rec['categories'],
                ['vocaloid'],
                f"non-denylisted vocaloid must stay vocaloid, got {tj_rec['categories']!r}",
            )

    def test_main_does_not_downgrade_anime_section_denylist_match(self) -> None:
        """The denylist only fires inside `section='vocaloid'`. A denylisted
        artist parsed from the anime section keeps `categories=['anime']`
        unchanged — defensive guard so we don't accidentally recategorize
        legitimately anime-tagged records.
        """
        fake_parse_result = (
            [
                {
                    'tj': '68044',
                    'title': 'まいふぇいばりっと',
                    'artist': 'LIP×LIP',
                    'title_ko': None,
                    'artist_ko': None,
                    'source_line': 0,
                    'section': 'anime',  # already anime — denylist must be a no-op
                },
            ],
            [],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            songs_path = Path(tmpdir) / 'songs.json'
            pdf_path = Path(tmpdir) / 'anisong.txt'
            pdf_path.write_text('dummy\n', encoding='utf-8')
            songs_path.write_text(
                json.dumps([], ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            with (
                patch.object(ingest, 'PDF_TEXT', pdf_path),
                patch.object(ingest, 'SONGS_JSON', songs_path),
                patch.object(ingest, 'parse_pdf', return_value=fake_parse_result),
            ):
                exit_code = ingest.main()
            self.assertEqual(exit_code, 0)
            corpus = json.loads(songs_path.read_text(encoding='utf-8'))
            self.assertEqual(len(corpus), 1)
            self.assertEqual(
                corpus[0]['categories'],
                ['anime'],
                f"LIP×LIP from anime section should stay anime (no-op), got {corpus[0]['categories']!r}",
            )


class TestIsoUtcNow(unittest.TestCase):
    """Verify _iso_utc_now() output is byte-compatible with JS toISOString()."""

    def test_ends_with_z(self) -> None:
        result = ingest._iso_utc_now()
        self.assertTrue(result.endswith('Z'), f"Expected Z suffix, got {result!r}")

    def test_length_is_24(self) -> None:
        result = ingest._iso_utc_now()
        self.assertEqual(len(result), 24, f"Expected length 24, got {len(result)} for {result!r}")

    def test_parses_as_datetime(self) -> None:
        import datetime as _dt
        result = ingest._iso_utc_now()
        # Strip Z and parse — fromisoformat accepts ISO-8601 without timezone suffix
        parsed = _dt.datetime.fromisoformat(result[:-1])
        self.assertIsNotNone(parsed)

    def test_has_millisecond_precision(self) -> None:
        # Format: YYYY-MM-DDTHH:MM:SS.mmmZ — the last 4 chars before Z are .mmm
        result = ingest._iso_utc_now()
        ms_part = result[-4:-1]
        self.assertEqual(len(ms_part), 3, f"Expected 3-digit ms, got {ms_part!r} from {result!r}")
        self.assertTrue(ms_part.isdigit(), f"ms part not digits: {ms_part!r}")

    def test_lex_compare_compatible_with_js_format(self) -> None:
        # A timestamp well in the past must sort before a far-future JS-format reference.
        result = ingest._iso_utc_now()
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
