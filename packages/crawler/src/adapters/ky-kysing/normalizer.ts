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
 * Media tie-up keywords that mark a trailing parenthetical as a WORK annotation
 * of the same song (`(映画"さくらん")`, `(ドラマ"…")`, `(TVアニメ「…」)`,
 * `(劇場版…)`) — the dominant KY tie-up format that the merger's role-tail
 * stripper (`stripContextSuffix`, keyed on OP/ED/OST/主題歌) does NOT cover.
 * `アニメ` subsumes `TVアニメ`. Added audit follow-up A Phase 1b (2026-07-16)
 * after real-data confirmation (ky-42263 `この世の限り (映画"さくらん")` etc. were
 * left un-stripped, undercounting the merge candidates).
 */
const KY_MEDIA_CONTEXT_RE = /映画|ドラマ|劇場版|アニメ/u;
/**
 * Version/cut markers — a trailing paren carrying one is a DISTINCT karaoke cut
 * and must NOT be stripped even if it also names a work (version wins, matching
 * the reviewer-confirmed version-first rule in `stripContextSuffix`). Copied
 * verbatim from merge.ts `CONTEXT_VERSION_RE`; keep in sync (KY-adapter-local so
 * the media strip below stays consistent without changing the merger).
 */
const KY_VERSION_MARKER_RE =
  /(?:tv\s*size|tvサイズ|テレビ.*サイズ|サイズ|\bsize\b|anime\s*ver\.?|アニメ\s*ver\.?|movie\s*ver\.?|short\s*ver\.?|remix|リミックス|cover|カバー|version|\bver\.?\b|バージョン|m@ster|acoustic|live|instrumental)/iu;
/** Trailing parenthetical (half/full-width), inner text captured. */
const KY_TRAILING_PAREN_RE = /[（(]([^（）()]{1,180})[）)]\s*$/u;

/**
 * Peel trailing media-tie-up parentheticals (`(映画"X")`, `(ドラマ"X")`, …) —
 * repeatedly, so `曲(映画"A")(ドラマ"B")` fully cleans — but STOP at a paren that
 * (a) carries a version/cut marker (distinct cut → keep, version wins), or
 * (b) has no media keyword, or (c) would empty the title.
 */
function stripMediaContext(title: string): string {
  let current = title;
  while (true) {
    const match = current.match(KY_TRAILING_PAREN_RE);
    if (!match) break;
    const inner = (match[1] ?? '').trim();
    if (KY_VERSION_MARKER_RE.test(inner)) break; // version/cut → keep
    if (!KY_MEDIA_CONTEXT_RE.test(inner)) break; // not a media tie-up → keep
    const next = current.slice(0, match.index).trimEnd();
    if (next === '') break; // never strip to empty
    current = next;
  }
  return current;
}

/**
 * Normalize a KY title to the merger's tie-up-canonical form (audit follow-up A,
 * owner decision 2026-07-16).
 *
 * KY renders a trailing tie-up parenthetical — a ROLE tail (`("BLEACH"OP)`) OR,
 * far more commonly, a MEDIA-name annotation (`(映画"さくらん")`, `(ドラマ"X")`) —
 * where the JOYSOUND row it should cluster with carries the clean title
 * (`この世の限り`). The merger's Tier C keys on the RAW title (suffix present →
 * no match) and Tier D keys on the WHOLE artist (collab format differs → no
 * match), so these rows never merged (v23 audit: 89% of the unmerged Tier-A
 * candidates were `ky-*`). We clean the title HERE (KY-only blast radius, vs a
 * merger tier change that would re-cluster all ~313k rows) in two passes:
 *   1. the merger's own {@link stripContextSuffix} for ROLE tails (zero drift);
 *   2. {@link stripMediaContext} for MEDIA-name context parens (Phase 1b — the
 *      dominant KY format the role stripper missed).
 * The two are looped to stable so interleaved tails (`曲(OST)(映画"X")`) fully
 * clean. Tier C's title+lead-artist key then matches the JOYSOUND twin.
 *
 * Version/cut markers (`(Live)`, `(Short Ver.)`, `(アニメ Ver.)`) are KEPT by
 * BOTH passes — they denote distinct karaoke cuts. A title that is ONLY a
 * parenthetical keeps its original form (never strips to empty).
 *
 * DISPLAY IMPACT: a KY-ONLY record (no JOYSOUND/TJ/blog twin) now displays the
 * stripped title, dropping the tie-up hint. This diverges from the blog
 * convention of keeping tie-ups, but is the accepted cost of clustering — and a
 * merged record's title always comes from a higher `TITLE_ARTIST_CHAIN` source
 * (ky is last), so only unmerged KY-only rows are visibly affected.
 */
export function normalizeKyTitle(rawTitle: string): string {
  let current = rawTitle;
  // Bounded loop: alternate role-tail + media-context peels until stable. A KY
  // title has at most a handful of trailing parens; 8 is a generous ceiling.
  for (let i = 0; i < 8; i += 1) {
    const roleStripped = stripContextSuffix(current).title;
    const afterRole = roleStripped.trim() === '' ? current : roleStripped;
    const afterMedia = stripMediaContext(afterRole);
    const next = afterMedia.trim() === '' ? afterRole : afterMedia;
    if (next === current) break;
    current = next;
  }
  return current;
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
