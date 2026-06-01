import type { JoysoundDetail } from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Coerce a JSON value to a required non-empty string. Empty / `$undefined` /
 * non-string-non-finite values return null and force the caller to fail.
 */
function coerceRequired(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v === '' || v === '$undefined') return null;
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Coerce a JSON value to an optional non-empty string. Returns null for
 * missing / null / empty / `$undefined` values.
 */
function coerceOptional(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v === '' || v === '$undefined') return null;
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Pull `[*].name` from an array-typed field. Non-array / malformed entries
 * are silently skipped so a single bad row doesn't poison the whole detail.
 */
function flattenNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (!isPlainObject(item)) continue;
    const name = coerceOptional(item.name);
    if (name !== null) out.push(name);
  }
  return out;
}

/**
 * Pull `[*].selectionServicePublishDate` from `aplList`. Same forgiving
 * semantics as `flattenNames`.
 */
function flattenAplDates(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (!isPlainObject(item)) continue;
    const date = coerceOptional(item.selectionServicePublishDate);
    if (date !== null) out.push(date);
  }
  return out;
}

/**
 * Parse a JOYSOUND `fetchContentsDetail` response into a structured
 * `JoysoundDetail`. Accepts either the song object directly or one common
 * envelope shape (`{ data: ... }` / `{ detail: ... }` / `{ result: ... }`).
 *
 * - Required fields `naviGroupId`, `selSongNo`, `songName` must be present
 *   and stringable; missing any throws.
 * - `artistInfo` is flattened into `artistName` / `artistId` (top-level
 *   `artistName` / `artistId` are honored as fallbacks).
 * - Optional string fields default to null; list-shaped fields default to
 *   empty arrays.
 */
export function parseJoysoundDetail(value: unknown): JoysoundDetail {
  if (!isPlainObject(value)) {
    throw new Error(`parseJoysoundDetail: expected an object, got ${typeof value}`);
  }

  // Unwrap a one-key envelope when the song record lives under data/detail/result.
  let obj: Record<string, unknown> = value;
  for (const key of ['data', 'detail', 'result']) {
    const inner = obj[key];
    if (isPlainObject(inner) && typeof inner.naviGroupId !== 'undefined') {
      obj = inner;
      break;
    }
  }

  const naviGroupId = coerceRequired(obj.naviGroupId);
  if (naviGroupId === null) {
    throw new Error('parseJoysoundDetail: missing required field naviGroupId');
  }
  const selSongNo = coerceRequired(obj.selSongNo);
  if (selSongNo === null) {
    throw new Error('parseJoysoundDetail: missing required field selSongNo');
  }
  const songName = coerceRequired(obj.songName);
  if (songName === null) {
    throw new Error('parseJoysoundDetail: missing required field songName');
  }

  // Flatten artistInfo → artistName / artistId, with top-level fallbacks.
  const artistInfoRaw = obj.artistInfo;
  const artistInfo = isPlainObject(artistInfoRaw) ? artistInfoRaw : {};
  const artistName = coerceOptional(artistInfo.artistName) ?? coerceOptional(obj.artistName);
  const artistId = coerceOptional(artistInfo.artistId) ?? coerceOptional(obj.artistId);

  return {
    naviGroupId,
    songId: coerceOptional(obj.songId),
    selSongNo,
    songName,
    songNameRuby: coerceOptional(obj.songNameRuby),
    artistName,
    artistId,
    lyricist: coerceOptional(obj.lyricist),
    composer: coerceOptional(obj.composer),
    relDate: coerceOptional(obj.relDate),
    newFlg: coerceOptional(obj.newFlg),
    lyricIntro: coerceOptional(obj.lyricIntro),
    genreNames: flattenNames(obj.genreList),
    tieupNames: flattenNames(obj.tieupList),
    aplServicePublishDates: flattenAplDates(obj.aplList),
  };
}
