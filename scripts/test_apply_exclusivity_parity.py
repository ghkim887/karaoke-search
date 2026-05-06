"""Cross-language oracle parity test for `applyCategoryExclusivity`.

The category mutual-exclusivity rule (priority: vocaloid > anime > jpop) is
implemented twice:

  - TS source-of-truth: `packages/schema/src/index.ts` exporting
    `applyCategoryExclusivity(Set<Category>): void` (mutates in place).
  - Python hand-port: `scripts/ingest-anisong-pdf.py` defining
    `_apply_category_exclusivity(list[str]) -> list[str]` (returns sorted list).

If either implementation drifts, downstream corpora diverge between the
JS crawler/merger pipeline and the Python PDF ingest. This test enumerates
all 2**3 = 8 input subsets of {jpop, vocaloid, anime} and asserts the two
implementations produce identical sorted-list outputs for every subset.

The Python implementation lives in a hyphenated filename
(`ingest-anisong-pdf.py`) which is not a valid Python module identifier,
so we load it via `runpy.run_path()` rather than `import`.

Run:
    python -m unittest scripts/test_apply_exclusivity_parity.py
Pre-build, the test class skips with a clear message rather than failing.
"""

from __future__ import annotations

import json
import runpy
import subprocess
import sys
import unittest
from itertools import combinations
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TS_DIST = REPO_ROOT / 'packages' / 'schema' / 'dist' / 'index.js'
PY_SCRIPT = REPO_ROOT / 'scripts' / 'ingest-anisong-pdf.py'

CATEGORIES = ('jpop', 'vocaloid', 'anime')


def _all_subsets() -> list[list[str]]:
    """All 2**3 = 8 subsets of CATEGORIES, including the empty set."""
    out: list[list[str]] = []
    for k in range(len(CATEGORIES) + 1):
        for combo in combinations(CATEGORIES, k):
            out.append(list(combo))
    return out


def _ts_apply(subset: list[str]) -> list[str]:
    """Spawn `node -e` to invoke the TS implementation, return sorted list."""
    # Forward-slash path is portable on Windows for require() calls.
    ts_path = TS_DIST.as_posix()
    inline = (
        "const { applyCategoryExclusivity } = require('" + ts_path + "');"
        "const inSet = new Set(JSON.parse(process.argv[1]));"
        "applyCategoryExclusivity(inSet);"
        "process.stdout.write(JSON.stringify([...inSet].sort()));"
    )
    proc = subprocess.run(
        ['node', '-e', inline, json.dumps(subset)],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(REPO_ROOT),
    )
    return json.loads(proc.stdout)


class ApplyCategoryExclusivityParityTest(unittest.TestCase):
    """Oracle parity: 8 subsets of {jpop, vocaloid, anime}.

    Generates one test method per subset (via setUpClass + dynamic addition
    below) so individual failures are reported separately and debuggable.
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not TS_DIST.is_file():
            raise unittest.SkipTest(
                'Run `corepack pnpm -r build` first to populate '
                f'{TS_DIST.relative_to(REPO_ROOT).as_posix()}'
            )
        if not PY_SCRIPT.is_file():
            raise unittest.SkipTest(f'Missing Python source: {PY_SCRIPT}')
        # Load the hyphenated Python file via runpy and pull out the helper.
        ns = runpy.run_path(str(PY_SCRIPT), run_name='__parity_oracle__')
        fn = ns.get('_apply_category_exclusivity')
        if fn is None:
            raise unittest.SkipTest(
                '_apply_category_exclusivity not found in '
                f'{PY_SCRIPT.relative_to(REPO_ROOT).as_posix()}'
            )
        cls._py_apply = staticmethod(fn)  # type: ignore[attr-defined]

    def _check(self, subset: list[str]) -> None:
        py_out = sorted(self._py_apply(list(subset)))  # type: ignore[attr-defined]
        ts_out = _ts_apply(list(subset))
        self.assertEqual(
            py_out,
            ts_out,
            msg=(
                f'Parity drift on input {subset!r}: '
                f'python={py_out!r} ts={ts_out!r}'
            ),
        )


def _slug(subset: list[str]) -> str:
    return '_'.join(subset) if subset else 'empty'


# Generate one test method per subset for per-case failure granularity.
for _subset in _all_subsets():
    _name = f'test_parity_{_slug(_subset)}'

    def _make(s: list[str]):
        def _impl(self: ApplyCategoryExclusivityParityTest) -> None:
            self._check(s)
        _impl.__name__ = _name
        return _impl

    setattr(ApplyCategoryExclusivityParityTest, _name, _make(_subset))


if __name__ == '__main__':
    sys.exit(unittest.main())
