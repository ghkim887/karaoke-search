import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import { stripContextSuffix } from '../../merge.js';
import { normalizeKyNumber } from './normalizeKyNumber.js';

export interface NormalizeKyArgs {
  ky: string;
  title: string;
  artist: string;
  crawledAt: string;
}

/** Per-song stable back-link: the `category=1` detail page for the number. */
export function kySourceUrl(ky: string): string {
  return `https://kysing.kr/search/?category=1&keyword=${ky}`;
}

/**
 * Normalize a KY title to the merger's tie-up-canonical form (audit follow-up A,
 * owner decision 2026-07-16).
 *
 * KY renders a trailing tie-up/role parenthetical (`この世の限り(錯乱 OST)`)
 * where the JOYSOUND row it should cluster with carries the clean title
 * (`この世の限り`). The merger's Tier C keys on the RAW title (suffix present →
 * no match) and Tier D keys on the WHOLE artist (collab format differs → no
 * match), so these rows never merged (v23 audit: 89% of the unmerged Tier-A
 * candidates were `ky-*`). Stripping the suffix HERE — with the merger's own
 * {@link stripContextSuffix} so there is zero drift — makes the KY title clean,
 * so Tier C's title+lead-artist key now matches the JOYSOUND twin. Chosen over
 * broadening a merger tier key because the blast radius is KY-only (the tier
 * change would re-cluster all ~313k rows across every source).
 *
 * Only ROLE tie-ups are peeled (OP/ED/OST/主題歌/…); version/cut markers
 * (`(Live)`, `(Short Ver.)`) are deliberately KEPT — they denote distinct
 * karaoke cuts that must stay separate. A title that is ONLY a parenthetical
 * keeps its original form (never strips to empty).
 *
 * DISPLAY IMPACT: a KY-ONLY record (no JOYSOUND/TJ/blog twin) now displays the
 * stripped title, dropping the tie-up hint. This diverges from the blog
 * convention of keeping tie-ups, but is the accepted cost of clustering — and a
 * merged record's title always comes from a higher `TITLE_ARTIST_CHAIN` source
 * (ky is last), so only unmerged KY-only rows are visibly affected.
 */
export function normalizeKyTitle(rawTitle: string): string {
  const stripped = stripContextSuffix(rawTitle).title;
  // Guard: a title that is only a tie-up parenthetical would strip to empty;
  // keep the original so the row still has a (valid, non-empty) title.
  return stripped.trim() === '' ? rawTitle : stripped;
}

/**
 * Map a classified KY row to a validated `SongRecord`.
 *
 *  - `id` = `ky-{number}` (the catalog number is KY's stable primary key).
 *  - `source_url` = the per-song `category=1` detail page — a stable back-link
 *    keyed by the number.
 *  - `karaoke_numbers.ky` = the canonical bare-digit number; `tj` / `joysound`
 *    are forced null (this adapter only populates its own column). The number
 *    is re-run through {@link normalizeKyNumber} as a defensive invariant — a
 *    row that reaches here always carries a valid number, so a `null` is a
 *    programming error and throws.
 *  - `title_ko` / `artist_ko` are ALWAYS null: the KY jp catalog surface is
 *    Japanese and KY contributes no Korean translation. Threading anything into
 *    the KO fields would lie about provenance and contaminate the merger's
 *    KO_CHAIN.
 *  - `title_primary` is the tie-up-canonical form ({@link normalizeKyTitle}) so
 *    a KY row clusters with its clean-titled JOYSOUND twin.
 *  - `artist_aliases` is NOT set here — the pipeline's `resolveArtistAliases`
 *    owns alias derivation centrally.
 *
 * No schema change: every field is an existing `SongRecord` field.
 */
export function normalizeKyRecord(args: NormalizeKyArgs): SongRecord {
  const { ky, title, artist, crawledAt } = args;
  const number = normalizeKyNumber(ky);
  if (number === null) {
    throw new Error(`normalizeKyRecord: not a valid KY number: "${ky}"`);
  }
  if (title.trim() === '') {
    throw new Error(`normalizeKyRecord: empty title for ky=${number}`);
  }
  if (artist.trim() === '') {
    throw new Error(`normalizeKyRecord: empty artist for ky=${number}`);
  }

  const record: SongRecord = {
    id: `ky-${number}`,
    source_url: kySourceUrl(number),
    title_primary: normalizeKyTitle(title),
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: number, joysound: null },
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
