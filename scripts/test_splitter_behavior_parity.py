"""Behavior parity: TS `splitArtistCollab` vs Python `artist_components_for_drop_check`.

The mechanical sync gate (`test_splitter_parity.py`) only proves the delimiter
STRING is in sync. It cannot catch a drift in the surrounding decomposition
logic — the feat/prod paren extraction, the scoped ` of ` sub-split, the
IGNORECASE matching, or the ASCII-vs-full-width pipe distinction. Those live in
hand-written TS (`packages/crawler/src/clustering.ts`) and a hand-written Python
mirror (`scripts/lib/artist_split.py`); a change to either that leaves the
delimiter string untouched would silently diverge the KPOP/Cpop drop filter.

This suite closes that gap with a shared JSON fixture
(`fixtures/splitter_parity_cases.json`) run through BOTH implementations:
  - TS side: `scripts/splitter_parity_harness.mjs` imports the canonical
    `splitArtistCollab` / `normalizeForMatch` from the built crawler dist (the
    SAME code `drop-artist-leaks.mjs` and the crawl-time parser run).
  - Python side: `artist_components_for_drop_check` from `lib.artist_split`.

Comparison contract (why we compare key SETS, not surface lists)
----------------------------------------------------------------
The two functions have deliberately different public contracts:
  * TS `splitArtistCollab` dedupes components by `normalizeForMatch` and returns
    SURFACE forms in first-seen order (with an out[0]===whole invariant).
  * Python `artist_components_for_drop_check` dedupes by `str.strip()` surface
    and returns stripped surface forms in first-seen order.
So their raw ordered lists legitimately differ (e.g. Python keeps both `imase`
and `IMASE`; TS collapses them). But BOTH are only ever consumed one way: every
component is passed through the normalizer and tested for drop-set membership
(`isArtistDropped` in drop-artist-leaks.mjs; `is_artist_in_drop_list` in
artist_split.py). The observable behavior of the drop filter is therefore the
SET of normalized keys each function yields — nothing else. That set is exactly
what we compare, and it is invariant to the two functions' differing dedup keys
and orderings. We compute each side's keys with its OWN normalizer (TS
`normalizeForMatch` in the harness, Python `normalize_for_match` here) so the
end-to-end drop predicate is what's under test, not just the splitter.

Prerequisite / CI ordering
---------------------------
Requires `packages/crawler/dist/clustering.js` (built by
`corepack pnpm --filter @karaoke/crawler build`) and `node` on PATH. A missing
dist or missing node is a HARD FAILURE with an actionable message — never a
silent skip. In `.github/workflows/ci.yml` the `pnpm build` step runs before the
`python -m unittest discover` step, so the dist is always present when this runs.

Run:
    python -m unittest scripts/test_splitter_behavior_parity.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

# Make scripts/ importable so `from lib.artist_split import ...` works.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib.artist_split import (  # noqa: E402  (path setup must precede import)
    artist_components_for_drop_check,
    normalize_for_match,
)

_FIXTURE_PATH = _SCRIPTS_DIR / 'fixtures' / 'splitter_parity_cases.json'
_HARNESS_PATH = _SCRIPTS_DIR / 'splitter_parity_harness.mjs'
_CLUSTERING_DIST = (
    _SCRIPTS_DIR.parent / 'packages' / 'crawler' / 'dist' / 'clustering.js'
)


def _python_keys(artist: str) -> set[str]:
    """Drop-check key set the Python side yields for `artist`.

    Mirrors `is_artist_in_drop_list`: every component is normalized, empties
    dropped, collapsed to a set. This IS the information the drop filter acts on.
    """
    keys: set[str] = set()
    for component in artist_components_for_drop_check(artist):
        key = normalize_for_match(component)
        if key:
            keys.add(key)
    return keys


def _run_ts_harness(node: str) -> list[dict]:
    """Run the Node harness over the shared fixture; return its `results` list.

    Hard-fails (not skips) when the dist is missing or the harness errors — so
    drift can never hide behind a quietly skipped test. `node` is the resolved
    interpreter path (setUpClass proves it exists before calling here).
    """
    proc = subprocess.run(
        [node, str(_HARNESS_PATH), str(_FIXTURE_PATH)],
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    if proc.returncode != 0:
        raise RuntimeError(
            'splitter parity harness (node) failed '
            f'(exit {proc.returncode}).\n'
            f'stderr:\n{proc.stderr}\n'
            'If the dist is missing, run '
            '`corepack pnpm --filter @karaoke/crawler build` first.'
        )
    payload = json.loads(proc.stdout)
    return payload['results']


class TestSplitterBehaviorParity(unittest.TestCase):
    """Assert TS and Python yield the same drop-check key set for every case."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._fixture = json.loads(_FIXTURE_PATH.read_text(encoding='utf-8'))
        cls._cases = cls._fixture['cases']
        # Node discovery is a hard failure with an actionable message. We check
        # it here (once) rather than inside _run_ts_harness so the message is
        # explicit instead of surfacing as a raw FileNotFoundError.
        node = shutil.which('node')
        if node is None:
            raise AssertionError(
                'node not found on PATH — required to run the TS splitter '
                'parity harness. Install Node (CI provides it via '
                'actions/setup) and retry.'
            )
        cls._ts_results = _run_ts_harness(node)

    def test_harness_is_index_aligned_with_fixture(self) -> None:
        """The harness must return one result per fixture case, in order."""
        self.assertEqual(
            len(self._ts_results),
            len(self._cases),
            'harness result count diverged from fixture case count',
        )
        for entry, result in zip(self._cases, self._ts_results):
            self.assertEqual(
                result['input'],
                entry['input'],
                'harness results are not index-aligned with the fixture',
            )

    def test_key_sets_match_for_every_case(self) -> None:
        """Per-case: normalized drop-check key sets must be identical.

        This is the parity assertion. A failure means a TS edit (or a Python
        mirror edit) changed the decomposition of some artist string on only
        one side — i.e. the drop filter would now behave differently depending
        on which language ran it.
        """
        for entry, result in zip(self._cases, self._ts_results):
            artist = entry['input']
            note = entry.get('note', '')
            with self.subTest(input=artist, note=note):
                ts_keys = set(result['keys'])
                py_keys = _python_keys(artist)
                self.assertEqual(
                    py_keys,
                    ts_keys,
                    msg=(
                        f'drop-check key-set drift for {artist!r} ({note}).\n'
                        f'  Python only : {sorted(py_keys - ts_keys)}\n'
                        f'  TS only     : {sorted(ts_keys - py_keys)}\n'
                        'A splitter change landed on only one side. Re-sync '
                        'clustering.ts <-> lib/artist_split.py (do NOT just '
                        'edit the fixture).'
                    ),
                )

    # --- Headline domain-invariant guards --------------------------------
    # These assert the ACTUAL expected key set (not merely "both sides agree"),
    # so the crown-jewel invariants from docs/PROJECT-KNOWLEDGE.md can't drift
    # by both sides regressing together.

    def _both_keys(self, artist: str) -> tuple[set[str], set[str]]:
        result = next(r for r in self._ts_results if r['input'] == artist)
        return _python_keys(artist), set(result['keys'])

    def test_bare_of_never_splits(self) -> None:
        """`Bump of Chicken` must round-trip whole on both sides (no ` of ` split)."""
        py_keys, ts_keys = self._both_keys('Bump of Chicken')
        self.assertEqual(py_keys, {'bumpofchicken'})
        self.assertEqual(ts_keys, {'bumpofchicken'})

    def test_ascii_pipe_never_splits(self) -> None:
        """ASCII `|` is not a delimiter — `Qverktett:||` stays whole on both sides."""
        py_keys, ts_keys = self._both_keys('Qverktett:||')
        self.assertEqual(py_keys, {'qverktett:||'})
        self.assertEqual(ts_keys, {'qverktett:||'})

    def test_full_width_pipe_splits(self) -> None:
        """Full-width `｜` (U+FF5C) splits; component keys survive on both sides."""
        py_keys, ts_keys = self._both_keys('X｜Y')
        self.assertEqual(py_keys, ts_keys)
        self.assertIn('x', py_keys)
        self.assertIn('y', py_keys)

    def test_feat_of_member_split_inside_paren(self) -> None:
        """`MAX(Feat.Huh Yunjin of LE SSERAFIM)` yields both member and group."""
        py_keys, ts_keys = self._both_keys('MAX(Feat.Huh Yunjin of LE SSERAFIM)')
        self.assertEqual(py_keys, ts_keys)
        self.assertIn('huhyunjin', py_keys)
        self.assertIn('lesserafim', py_keys)


if __name__ == '__main__':
    unittest.main()
