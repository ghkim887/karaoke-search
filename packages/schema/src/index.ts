import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Allowed song categories. Exactly these three values, no others.
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md, Data Model section.
 */
export type Category = 'jpop' | 'vocaloid' | 'anime';

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
  /** Cross-source karaoke numbers. */
  karaoke_numbers: KaraokeNumbers;
  /** At least one category, no duplicates. */
  categories: Category[];
  /** ISO-8601 date-time when the source page was crawled. */
  crawled_at: string;
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
  karaoke_numbers: KaraokeNumbers;
  categories: Category[];
}

const CATEGORY_VALUES: readonly Category[] = ['jpop', 'vocaloid', 'anime'];

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
    title_ko: { type: ['string', 'null'] },
    artist_primary: { type: 'string', minLength: 1 },
    artist_ko: { type: ['string', 'null'] },
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
      uniqueItems: true,
      items: {
        type: 'string',
        enum: CATEGORY_VALUES,
      },
    },
    crawled_at: {
      type: 'string',
      format: 'date-time',
    },
  },
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
