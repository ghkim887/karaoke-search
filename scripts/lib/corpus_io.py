"""Shared corpus I/O helpers for the karaoke data pipeline.

Extracted from `scripts/ingest-anisong-pdf.py` so that all pipeline scripts
share identical write formatting (indent=2, trailing newline, UTF-8, no BOM)
and UTF-8 stdio initialisation without the importlib hack.

Public API (no leading underscore — these are intentionally exported):
  ensure_utf8_stdio()       — force stdout/stderr to UTF-8 (idempotent)
  atomic_write_corpus()     — write records list to path atomically
  iso_utc_now()             — ISO-8601 UTC timestamp, JS toISOString()-compatible
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import sys
from pathlib import Path


def ensure_utf8_stdio() -> None:
    """Force stdout/stderr to UTF-8 so emoji/Hangul/kana log output doesn't
    trip cp949 on Windows.

    Safe on POSIX (already UTF-8). Idempotent.
    """
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')


def atomic_write_corpus(path: Path, records: list) -> None:
    """Atomic-write `records` to `path` as pretty-printed UTF-8 JSON.

    Writes to `<path>.tmp` then `os.replace()` swaps it onto `path`. Mirrors
    the TS pipeline's `songs.json.tmp` + rename pattern in
    `.github/workflows/crawl.yml` so a crash mid-write can never leave a
    truncated/corrupt songs.json on disk. Load-bearing on Windows where
    `os.replace()` is the only cross-filesystem atomic rename guaranteed.

    Format: `ensure_ascii=False`, `indent=2`, trailing newline — matches the
    existing on-disk shape so re-running on an unchanged corpus is byte-
    idempotent.
    """
    tmp_path = path.with_suffix(path.suffix + '.tmp')
    tmp_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    os.replace(tmp_path, path)


def iso_utc_now() -> str:
    """ISO-8601 UTC with millisecond precision and Z suffix.

    Byte-identical to JS `new Date().toISOString()` so cross-source
    lexicographic compare in merge.ts:393 is safe.
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
