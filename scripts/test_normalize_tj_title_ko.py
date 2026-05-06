"""Tests for scripts/normalize_tj_title_ko.py — Stage 1 of title_ko backfill."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from normalize_tj_title_ko import extract_media_context_paren


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


if __name__ == '__main__':
    unittest.main()
