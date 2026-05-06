"""Tests for scripts/normalize_tj_title_ko.py — Stage 1 of title_ko backfill."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from normalize_tj_title_ko import extract_media_context_paren, main, process_record


class TestExtractMediaContextParen(unittest.TestCase):
    def test_returns_paren_when_korean_with_OST_keyword(self):
        result = extract_media_context_paren('(슬레이어즈 TRY OST)')
        self.assertEqual(result, '(슬레이어즈 TRY OST)')

    def test_returns_paren_with_OP_keyword(self):
        result = extract_media_context_paren('아이가 미에나이 (진격의 거인 OP)')
        self.assertEqual(result, '(진격의 거인 OP)')

    def test_returns_paren_with_korean_only_keyword_극장판(self):
        result = extract_media_context_paren('카게마치 (극장판 코난)')
        self.assertEqual(result, '(극장판 코난)')

    def test_returns_None_when_no_paren(self):
        self.assertIsNone(extract_media_context_paren('아이가 미에나이'))

    def test_returns_None_when_paren_has_no_korean(self):
        self.assertIsNone(extract_media_context_paren('foo (TV anime OP)'))

    def test_returns_None_when_paren_korean_but_no_media_keyword(self):
        self.assertIsNone(extract_media_context_paren('foo (단순한 부제목)'))

    def test_concatenates_multiple_matching_parens(self):
        result = extract_media_context_paren('foo (코난 OP) (극장판 OST)')
        self.assertEqual(result, '(코난 OP) (극장판 OST)')

    def test_handles_empty_string(self):
        self.assertIsNone(extract_media_context_paren(''))

    def test_handles_none(self):
        self.assertIsNone(extract_media_context_paren(None))


class TestProcessRecord(unittest.TestCase):
    def test_tj_record_with_phonetic_title_ko_nullified(self):
        rec = {
            'id': 'tj-100',
            'title_primary': '愛が見えない',
            'title_ko': '아이가 미에나이',
        }
        out = process_record(rec)
        self.assertIsNone(out['title_ko'])
        self.assertNotIn('media_context_ko', out)

    def test_tj_record_with_media_context_salvaged(self):
        rec = {
            'id': 'tj-200',
            'title_primary': 'Somewhere(スレイヤーズ TRY OST)',
            'title_ko': '(슬레이어즈 TRY OST)',
        }
        out = process_record(rec)
        self.assertIsNone(out['title_ko'])
        self.assertEqual(out['media_context_ko'], '(슬레이어즈 TRY OST)')

    def test_tjpdf_record_treated_like_tj(self):
        rec = {
            'id': 'tjpdf-300',
            'title_primary': 'X',
            'title_ko': '엑스',
        }
        out = process_record(rec)
        self.assertIsNone(out['title_ko'])

    def test_tj_record_strips_existing_source_and_confidence(self):
        rec = {
            'id': 'tj-400',
            'title_primary': 'X',
            'title_ko': '엑스',
            'title_ko_source': 'legacy-stale',
            'title_ko_confidence': 'high',
        }
        out = process_record(rec)
        self.assertNotIn('title_ko_source', out)
        self.assertNotIn('title_ko_confidence', out)

    def test_blog_record_with_title_ko_tagged_blog(self):
        rec = {
            'id': 'blog-1-0',
            'title_primary': '逆光オーケストラ',
            'title_ko': '역광의 오케스트라',
        }
        out = process_record(rec)
        self.assertEqual(out['title_ko'], '역광의 오케스트라')
        self.assertEqual(out['title_ko_source'], 'blog')

    def test_blog_record_with_null_title_ko_not_tagged(self):
        rec = {
            'id': 'blog-2-0',
            'title_primary': 'X',
            'title_ko': None,
        }
        out = process_record(rec)
        self.assertNotIn('title_ko_source', out)

    def test_tj_record_with_null_title_ko_unchanged(self):
        rec = {
            'id': 'tj-500',
            'title_primary': 'X',
            'title_ko': None,
        }
        out = process_record(rec)
        self.assertIsNone(out['title_ko'])
        self.assertNotIn('media_context_ko', out)

    def test_returns_a_copy_does_not_mutate_input(self):
        rec = {
            'id': 'tj-600',
            'title_primary': 'X',
            'title_ko': '엑스',
        }
        out = process_record(rec)
        self.assertEqual(rec['title_ko'], '엑스')  # original untouched
        self.assertIsNone(out['title_ko'])

    def test_tj_record_with_llm_translated_source_preserved(self):
        rec = {
            'id': 'tj-700',
            'title_primary': '愛が見えない',
            'title_ko': '사랑이 보이지 않아',
            'title_ko_source': 'llm-translated',
            'title_ko_confidence': 'high',
        }
        out = process_record(rec)
        self.assertEqual(out['title_ko'], '사랑이 보이지 않아')
        self.assertEqual(out['title_ko_source'], 'llm-translated')
        self.assertEqual(out['title_ko_confidence'], 'high')
        self.assertNotIn('media_context_ko', out)  # not added because we short-circuit


class TestMainAtomicWrite(unittest.TestCase):
    def test_main_rewrites_corpus_atomically(self):
        records = [
            {
                'id': 'tj-1',
                'source_url': 'https://x.test/1',
                'title_primary': '愛が見えない',
                'title_ko': '아이가 미에나이',
                'artist_primary': 'A',
                'artist_ko': None,
                'karaoke_numbers': {'tj': '1', 'ky': None, 'joysound': None},
                'categories': ['jpop'],
                'crawled_at': '2026-05-06T00:00:00.000Z',
            },
            {
                'id': 'blog-1-0',
                'source_url': 'https://x.test/2',
                'title_primary': '逆光オーケストラ',
                'title_ko': '역광의 오케스트라',
                'artist_primary': 'B',
                'artist_ko': None,
                'karaoke_numbers': {'tj': None, 'ky': None, 'joysound': None},
                'categories': ['jpop'],
                'crawled_at': '2026-05-06T00:00:00.000Z',
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / 'songs.json'
            corpus.write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')
            stats = main(str(corpus))
            out = json.loads(corpus.read_text(encoding='utf-8'))

        # TJ record nullified.
        self.assertIsNone(out[0]['title_ko'])
        # Blog record tagged.
        self.assertEqual(out[1]['title_ko_source'], 'blog')
        # Stats reported.
        self.assertEqual(stats['stripped'], 1)
        self.assertEqual(stats['tagged'], 1)
        self.assertEqual(stats['salvaged'], 0)

    def test_main_is_idempotent(self):
        records = [
            {
                'id': 'tj-1',
                'source_url': 'https://x.test/1',
                'title_primary': 'X',
                'title_ko': '엑스',
                'artist_primary': 'A',
                'artist_ko': None,
                'karaoke_numbers': {'tj': '1', 'ky': None, 'joysound': None},
                'categories': ['jpop'],
                'crawled_at': '2026-05-06T00:00:00.000Z',
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / 'songs.json'
            corpus.write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')
            main(str(corpus))
            first = corpus.read_bytes()
            main(str(corpus))
            second = corpus.read_bytes()
            self.assertEqual(first, second, 'corpus byte-changed on second run')


if __name__ == '__main__':
    unittest.main()
