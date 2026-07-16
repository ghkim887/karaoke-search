import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A curated title-recovery entry for a truncated KY row. `title` and `artist`
 * are the FULL (non-truncated) strings; `source` records provenance
 * (`anisong-book-42` or a `manual-*` tag).
 */
export interface KyTitleRecoveryEntry {
  title: string;
  artist: string;
  source: string;
}

/**
 * Curated KY title-recovery map, keyed by canonical KY number.
 *
 * Why (D2 revision, owner decision 2026-07-16): the live KY index and its
 * `category=1` detail page apply the SAME fixed-width truncation, so the old
 * per-row detail fetch recovered a full title in only 0.37% of attempts
 * (run2: 1/270) — the fetch is removed. Truncated index rows are instead
 * recovered from this COMMITTED map, built by
 * `scripts/build-ky-title-recovery.mjs` from the KYSing anisong book (full-title
 * listing) plus hand-confirmed manual entries.
 *
 * The map data file (`curated-title-recovery.json`) is read once at runtime
 * from the source tree — it is a committed data artifact (like
 * `tj-search-cache.json` / `tjpdf-catalog.jsonl`), NOT bundled into `dist`, so
 * the path resolves back into `src` from both the compiled and the test run.
 */
const RECOVERY_JSON_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../src/adapters/ky-kysing/curated-title-recovery.json',
);

let cachedMap: Record<string, KyTitleRecoveryEntry> | null = null;

function loadMap(): Record<string, KyTitleRecoveryEntry> {
  if (cachedMap === null) {
    cachedMap = JSON.parse(readFileSync(RECOVERY_JSON_PATH, 'utf8')) as Record<
      string,
      KyTitleRecoveryEntry
    >;
  }
  return cachedMap;
}

/**
 * Look up a truncated row's KY number in the curated recovery map. Returns the
 * full-title entry, or `null` when the number is not covered (the crawler then
 * drops the row as `truncation-unrecovered`).
 */
export function lookupKyTitleRecovery(ky: string): KyTitleRecoveryEntry | null {
  return loadMap()[ky] ?? null;
}
