import { readFileSync } from 'node:fs';

/**
 * A single SEARCH-ONLY hint: an alternate string (e.g. a JOYSOUND `songNameRuby`
 * reading or a derived romanization) that should improve recall for a song
 * WITHOUT being part of the canonical {@link SongRecord}. Hints feed only the
 * `search_hints` / `search_tokens` tables and never crawler/admit/drop logic.
 */
export interface SearchHintInput {
  /** Canonical song id the hint applies to. Unknown ids are ignored. */
  songId: string;
  /** Whether the hint is an alternate title or artist string. */
  field: 'title' | 'artist';
  /** The alternate text (kana reading, romanization, etc.). */
  text: string;
  /** Provenance tag, e.g. `joysound_songNameRuby`, `derived_kana_romaji`. */
  source: string;
  /** Defaults to `medium` when omitted. */
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Parse a SEARCH-ONLY hint sidecar file into normalized {@link SearchHintInput}
 * rows. Accepts either a JSON array, a single JSON object, or JSONL (one JSON
 * value per line). Each row may be:
 *
 *   - a generic flat hint — `{ song_id|songId, field, text, source, confidence? }`,
 *   - a grouped hint — `{ song_id|songId, hints: [{ field, text, source, ... }] }`,
 *   - a JOYSOUND detail/decision-log row carrying `detail.songNameRuby` (mapped
 *     to a `title` hint for `joysound-${detail.naviGroupId || naviGroupId}`).
 *
 * Rows that are malformed (missing song id, unknown `field`, empty `text` or
 * `source`, non-`admit` decision logs) are skipped — a sidecar is advisory and
 * must never fail a build. Song-id existence is checked later, at import.
 */
export function parseSearchHintFile(path: string): SearchHintInput[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) {
    return [];
  }
  const hints: SearchHintInput[] = [];
  for (const row of parseHintRows(raw)) {
    collectHintsFromRow(row, hints);
  }
  return hints;
}

function parseHintRows(raw: string): unknown[] {
  // Whole-file JSON first (a JSON array, or a single pretty-printed object).
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to JSONL: one JSON value per non-empty line. Malformed lines are
    // skipped rather than aborting the whole file.
    const rows: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        rows.push(JSON.parse(trimmed) as unknown);
      } catch {
        // Skip unparseable line.
      }
    }
    return rows;
  }
}

function collectHintsFromRow(row: unknown, out: SearchHintInput[]): void {
  if (!isPlainObject(row)) {
    return;
  }

  // Grouped form: { songId, hints: [...] }.
  if (Array.isArray(row.hints)) {
    const songId = readHintSongId(row);
    if (songId === null) {
      return;
    }
    for (const hint of row.hints) {
      pushFlatHint(out, songId, hint);
    }
    return;
  }

  // JOYSOUND detail / decision-log form.
  if (isPlainObject(row.detail) || ('naviGroupId' in row && 'selSongNo' in row)) {
    collectJoysoundDetailHint(row, out);
    return;
  }

  // Generic flat form.
  const songId = readHintSongId(row);
  if (songId === null) {
    return;
  }
  pushFlatHint(out, songId, row);
}

function pushFlatHint(out: SearchHintInput[], songId: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    return;
  }
  const field = normalizeHintFieldName(raw.field);
  if (field === null) {
    return;
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text.length === 0) {
    return;
  }
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (source.length === 0) {
    return;
  }
  const hint: SearchHintInput = { songId, field, text, source };
  if (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low') {
    hint.confidence = raw.confidence;
  }
  out.push(hint);
}

/**
 * Map a JOYSOUND detail/decision-log row to a title ruby hint. Only `admit`
 * rows (or rows with no explicit `decision`) with a non-empty `songNameRuby`
 * are emitted; the canonical song id is `joysound-${detail.naviGroupId ||
 * naviGroupId}`, matching the JOYSOUND normalizer.
 */
function collectJoysoundDetailHint(row: Record<string, unknown>, out: SearchHintInput[]): void {
  if ('decision' in row && row.decision !== 'admit') {
    return;
  }
  const detail = isPlainObject(row.detail) ? row.detail : {};
  const naviGroupId =
    readTrimmedString(detail.naviGroupId) ?? readTrimmedString(row.naviGroupId) ?? '';
  if (naviGroupId.length === 0) {
    return;
  }
  const ruby = readTrimmedString(detail.songNameRuby) ?? '';
  if (ruby.length === 0) {
    return;
  }
  out.push({
    songId: `joysound-${naviGroupId}`,
    field: 'title',
    text: ruby,
    source: 'joysound_songNameRuby',
    confidence: 'high',
  });
}

function readHintSongId(row: Record<string, unknown>): string | null {
  return readTrimmedString(row.song_id) ?? readTrimmedString(row.songId);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHintFieldName(value: unknown): 'title' | 'artist' | null {
  return value === 'title' || value === 'artist' ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
