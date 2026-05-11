import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Allowed song categories. Exactly these three values, no others.
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md, Data Model section.
 */
export type Category = (typeof CATEGORY_VALUES)[number];

/**
 * Karaoke machine catalog numbers per source. All values nullable so a record
 * can be created from a single source and merged with others later.
 */
export interface KaraokeNumbers {
  tj: string | null;
  ky: string | null;
  joysound: string | null;
}

/**
 * Universal song record. Single shape consumed by both crawler output and
 * frontend search. See spec Data Model worked examples (lines 117-146).
 */
export interface SongRecord {
  /** `{source_slug}-{source_local_id}` — e.g. `blog-1596` or `blog-449-0`. */
  id: string;
  /** Mandatory per-record attribution back-link. */
  source_url: string;
  /** Official primary title in any script (ja/en/mixed). */
  title_primary: string;
  /** Official Korean title. Nullable. */
  title_ko: string | null;
  /** Official primary artist name in any script. */
  artist_primary: string;
  /** Official Korean artist name. Nullable. */
  artist_ko: string | null;
  /**
   * Optional alternate forms of the canonical `artist_primary`. Populated by
   * the alias-resolution stage (pre-merge) when an `artist_primary` carries
   * full-width pipe (`｜`) separators OR a bare record's value matches a
   * known alias of another canonical. NEVER used as the canonical key.
   * Empty/absent when the record has no known aliases.
   *
   * Spec: docs/superpowers/specs/2026-05-04-artist-alias-dedup-design.md.
   */
  artist_aliases?: string[];
  /** Cross-source karaoke numbers. */
  karaoke_numbers: KaraokeNumbers;
  /** At least one category, no duplicates. */
  categories: Category[];
  /** ISO-8601 date-time when the source page was crawled. */
  crawled_at: string;
  /**
   * Korean translation of the parenthetical media-context tag, when
   * title_primary contains one. e.g. title_primary "Somewhere(スレイヤーズ TRY OST)"
   * → media_context_ko "(슬레이어즈 TRY OST)". Independent of title_ko —
   * a record may have one, both, or neither.
   *
   * Spec: docs/superpowers/specs/2026-05-06-title-ko-backfill-design.md.
   */
  media_context_ko?: string;
  /**
   * Provenance tag for title_ko.
   *   'blog'           — original blog crawl Korean translation
   *   'llm-translated' — agent-translated in the title_ko backfill pipeline
   *   'manual'         — reserved for any future hand-curation
   *
   * TJ-direct sortTitleKo never lands here. The Stage 1 normalizer nulls
   * every TJ-derived title_ko (it is transliteration, not translation).
   */
  title_ko_source?: 'blog' | 'llm-translated' | 'manual';
  /**
   * Confidence the agent attached during the title_ko backfill pipeline.
   * Only valid when `title_ko_source === 'llm-translated'`. Records with
   * 'low' confidence are surfaced in scripts/data/llm-review.csv for
   * human spot-check.
   */
  title_ko_confidence?: 'high' | 'medium' | 'low';
}

/**
 * Pre-normalization shape emitted by adapter parsers before the normalizer
 * stage assigns `id` and `crawled_at`. Cells from raw HTML are nullable when
 * unparseable; only `title_primary`, `artist_primary`, and `source_url` are
 * required for a row to enter the pipeline.
 */
export interface RawSongRecord {
  source_url: string;
  title_primary: string;
  title_ko: string | null;
  artist_primary: string;
  artist_ko: string | null;
  /**
   * Optional alias forms — adapters MAY populate this directly when they have
   * structured alias data; otherwise the alias-resolution stage populates it
   * from `artist_primary` shape. See `SongRecord.artist_aliases`.
   */
  artist_aliases?: string[];
  karaoke_numbers: KaraokeNumbers;
  categories: Category[];
}

const CATEGORY_VALUES = ['jpop', 'vocaloid', 'anime'] as const;

/**
 * Ajv-compatible JSON Schema for `SongRecord`.
 *
 * The `id` pattern `^[a-z0-9-]+-\d+$` permits multi-segment hyphens in the
 * source slug, e.g. `blog-449-0` (the trailing `\d+` consumes the final
 * numeric segment, `[a-z0-9-]+` consumes everything before — including
 * additional `-` characters). Verified against plan Phase 3 IDs.
 */
export const songRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'source_url',
    'title_primary',
    'title_ko',
    'artist_primary',
    'artist_ko',
    'karaoke_numbers',
    'categories',
    'crawled_at',
  ],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9-]+-\\d+$',
    },
    source_url: {
      type: 'string',
      format: 'uri',
    },
    title_primary: { type: 'string', minLength: 1 },
    title_ko: { type: ['string', 'null'], minLength: 1 },
    artist_primary: { type: 'string', minLength: 1 },
    artist_ko: { type: ['string', 'null'], minLength: 1 },
    artist_aliases: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
      // No `minItems` — empty array is tolerated. The resolver omits the
      // field when there are no aliases (smaller corpus footprint), but a
      // record with `artist_aliases: []` still validates so callers can be
      // lenient about producing empty arrays.
    },
    karaoke_numbers: {
      type: 'object',
      additionalProperties: false,
      required: ['tj', 'ky', 'joysound'],
      properties: {
        tj: { type: ['string', 'null'] },
        ky: { type: ['string', 'null'] },
        joysound: { type: ['string', 'null'] },
      },
    },
    categories: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: CATEGORY_VALUES,
      },
      // Three-way mutual-exclusivity: at most one of
      // `{jpop, vocaloid, anime}` per record. Enforced via `maxItems: 1`
      // (the live enum currently has exactly these three values, so the
      // constraint reduces to "exactly one tag"). Defense-in-depth alongside
      // the runtime `applyCategoryExclusivity` helper in @karaoke/category-rules.
    },
    crawled_at: {
      type: 'string',
      format: 'date-time',
    },
    media_context_ko: { type: 'string', minLength: 1, pattern: '^\\(.*\\)$' },
    title_ko_source: {
      type: 'string',
      enum: ['blog', 'llm-translated', 'manual'],
    },
    title_ko_confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  allOf: [
    {
      if: {
        properties: {
          title_ko_confidence: { type: 'string' },
        },
        required: ['title_ko_confidence'],
      },
      then: {
        properties: {
          title_ko_source: { const: 'llm-translated' },
        },
        required: ['title_ko_source'],
      },
    },
  ],
} as const;

// Ajv (when emitted via CJS interop) puts the constructor on `.default`.
// Normalize both shapes here so consumers don't have to.
const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const addFormatsFn =
  (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;

const ajv = new AjvCtor({ allErrors: true, strict: true });
addFormatsFn(ajv);

const validator: ValidateFunction = ajv.compile(songRecordSchema);

/**
 * Asserts that `value` conforms to `SongRecord`. Throws an Error containing
 * Ajv's human-readable error text on failure. Uses `asserts` syntax so the
 * caller's binding is narrowed after a successful call.
 */
export function validateSongRecord(value: unknown): asserts value is SongRecord {
  if (!validator(value)) {
    throw new Error(`Invalid SongRecord: ${ajv.errorsText(validator.errors)}`);
  }
}
