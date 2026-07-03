import { type Static, Type } from '@sinclair/typebox';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// Single source of truth
//
// Every field is declared once as a TypeBox schema. The exported TypeScript
// types are DERIVED via `Static<>` and the exported JSON Schemas ARE these
// same TypeBox objects — so the TS shape and the Ajv validator can never drift.
//
// Two small helpers reproduce the exact JSON-Schema representation the
// hand-written schema used (rather than TypeBox's default `anyOf`/`const`
// encodings), so the generated schema stays byte-for-byte equal to the
// long-reviewed original. Each keeps the runtime keyword and the static type
// bound together in one place, so there is still only one thing to edit.
// ---------------------------------------------------------------------------

/**
 * A string-or-null field encoded as `{ type: ['string', 'null'], ...opts }`
 * (the pre-TypeBox representation) with static type `string | null`. Extra
 * keywords such as `minLength` / `pattern` are merged in.
 */
function Nullable(opts: Record<string, unknown> = {}) {
  return Type.Unsafe<string | null>({ type: ['string', 'null'], ...opts });
}

/**
 * A closed string enum encoded as `{ type: 'string', enum: [...] }` with a
 * static type of the literal union. The literal values are written once; the
 * union type is inferred from them.
 */
function StringEnum<const T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({ type: 'string', enum: values });
}

/**
 * Karaoke machine catalog numbers per source. All values nullable so a record
 * can be created from a single source and merged with others later.
 */
const karaokeNumbersSchema = Type.Object(
  {
    tj: Nullable(),
    ky: Nullable(),
    // Defense-in-depth: a string joysound value must be bare digits (all real
    // codes look like `190001`). `null` stays valid — `pattern` only constrains
    // string instances. Catches blog-parse junk like the Korean word "등록일"
    // that landed in blog-826-175 before the parser guard.
    joysound: Nullable({ pattern: '^[0-9]+$' }),
  },
  { additionalProperties: false },
);

/**
 * Field schemas shared between `SongRecord` and its pre-normalization
 * counterpart `RawSongRecord`. Declaring them once keeps the two record shapes
 * in lock-step.
 */
const sharedFields = {
  /** Mandatory per-record attribution back-link. */
  source_url: Type.String({ format: 'uri' }),
  /** Official primary title in any script (ja/en/mixed). */
  title_primary: Type.String({ minLength: 1 }),
  /** Official Korean title. Nullable. */
  title_ko: Nullable({ minLength: 1 }),
  /** Official primary artist name in any script. */
  artist_primary: Type.String({ minLength: 1 }),
  /** Official Korean artist name. Nullable. */
  artist_ko: Nullable({ minLength: 1 }),
  /**
   * Optional alternate forms of the canonical `artist_primary`. Populated by
   * the alias-resolution stage (pre-merge) when an `artist_primary` carries
   * full-width pipe (`｜`) separators OR a bare record's value matches a known
   * alias of another canonical. NEVER used as the canonical key. Empty/absent
   * when the record has no known aliases.
   *
   * No `minItems` — an empty array is tolerated: the resolver omits the field
   * when there are no aliases (smaller corpus footprint), but a record with
   * `artist_aliases: []` still validates so callers can be lenient.
   *
   * Design notes: docs/PROJECT-KNOWLEDGE.md (Merger and alias resolution).
   */
  artist_aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  /** Cross-source karaoke numbers. */
  karaoke_numbers: karaokeNumbersSchema,
} as const;

/**
 * Universal song record. Single shape consumed by both crawler output and
 * frontend search. See spec Data Model worked examples (lines 117-146).
 *
 * The `id` pattern `^[a-z0-9-]+-\d+$` permits multi-segment hyphens in the
 * source slug, e.g. `blog-449-0` (the trailing `\d+` consumes the final numeric
 * segment, `[a-z0-9-]+` consumes everything before — including additional `-`).
 *
 * The `allOf` cross-field rule enforces that `title_ko_confidence` may only
 * appear when `title_ko_source === 'llm-translated'`.
 */
const songRecordSchemaInner = Type.Object(
  {
    /** `{source_slug}-{source_local_id}` — e.g. `blog-1596` or `blog-449-0`. */
    id: Type.String({ pattern: '^[a-z0-9-]+-\\d+$' }),
    source_url: sharedFields.source_url,
    title_primary: sharedFields.title_primary,
    title_ko: sharedFields.title_ko,
    artist_primary: sharedFields.artist_primary,
    artist_ko: sharedFields.artist_ko,
    artist_aliases: sharedFields.artist_aliases,
    karaoke_numbers: sharedFields.karaoke_numbers,
    /** ISO-8601 date-time when the source page was crawled. */
    crawled_at: Type.String({ format: 'date-time' }),
    /**
     * Korean translation of the parenthetical media-context tag, when
     * title_primary contains one. e.g. "Somewhere(スレイヤーズ TRY OST)" →
     * "(슬레이어즈 TRY OST)". Independent of title_ko — a record may have one,
     * both, or neither. Design notes: docs/PROJECT-KNOWLEDGE.md.
     */
    media_context_ko: Type.Optional(Type.String({ minLength: 1, pattern: '^\\(.*\\)$' })),
    /**
     * Provenance tag for title_ko.
     *   'blog'           — original blog crawl Korean translation
     *   'llm-translated' — agent-translated in the title_ko backfill pipeline
     *   'manual'         — reserved for any future hand-curation
     * TJ-direct sortTitleKo never lands here (Stage 1 nulls TJ-derived title_ko).
     */
    title_ko_source: Type.Optional(StringEnum(['blog', 'llm-translated', 'manual'])),
    /**
     * Confidence the agent attached during the title_ko backfill pipeline. Only
     * valid when `title_ko_source === 'llm-translated'` (enforced by `allOf`
     * below). 'low' confidence rows are surfaced in scripts/data/llm-review.csv.
     */
    title_ko_confidence: Type.Optional(StringEnum(['high', 'medium', 'low'])),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: { title_ko_confidence: { type: 'string' } },
          required: ['title_ko_confidence'],
        },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a Promise-like object.
        then: {
          properties: { title_ko_source: { const: 'llm-translated' } },
          required: ['title_ko_source'],
        },
      },
    ],
  },
);

/**
 * Pre-normalization shape emitted by adapter parsers before the normalizer
 * stage assigns `id` and `crawled_at`. Cells from raw HTML are nullable when
 * unparseable; only `title_primary`, `artist_primary`, and `source_url` are
 * required for a row to enter the pipeline.
 */
const rawSongRecordSchemaInner = Type.Object(
  {
    source_url: sharedFields.source_url,
    title_primary: sharedFields.title_primary,
    title_ko: sharedFields.title_ko,
    artist_primary: sharedFields.artist_primary,
    artist_ko: sharedFields.artist_ko,
    artist_aliases: sharedFields.artist_aliases,
    karaoke_numbers: sharedFields.karaoke_numbers,
  },
  { additionalProperties: false },
);

// --- Derived TypeScript types (single source: the schemas above) -----------

/** @see karaokeNumbersSchema */
export type KaraokeNumbers = Static<typeof karaokeNumbersSchema>;
/** @see songRecordSchema */
export type SongRecord = Static<typeof songRecordSchemaInner>;
/** @see rawSongRecordSchema */
export type RawSongRecord = Static<typeof rawSongRecordSchemaInner>;

/**
 * Ajv-compatible JSON Schema for `SongRecord`. Kept as the public export name;
 * now generated from TypeBox rather than hand-maintained.
 */
export const songRecordSchema = songRecordSchemaInner;

/**
 * Ajv-compatible JSON Schema for `RawSongRecord` (additive — the pipeline entry
 * shape previously had no runtime schema). Not wired into any stage; provided
 * for callers that want to validate parser output before normalization.
 */
export const rawSongRecordSchema = rawSongRecordSchemaInner;

// Ajv (when emitted via CJS interop) puts the constructor on `.default`.
// Normalize both shapes here so consumers don't have to.
const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const addFormatsFn =
  (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;

const ajv = new AjvCtor({ allErrors: true, strict: true });
addFormatsFn(ajv);

const validator: ValidateFunction = ajv.compile(songRecordSchema);
const rawValidator: ValidateFunction = ajv.compile(rawSongRecordSchema);

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

/**
 * Asserts that `value` conforms to `RawSongRecord`. Additive counterpart to
 * `validateSongRecord`; not currently wired into the pipeline.
 */
export function validateRawSongRecord(value: unknown): asserts value is RawSongRecord {
  if (!rawValidator(value)) {
    throw new Error(`Invalid RawSongRecord: ${ajv.errorsText(rawValidator.errors)}`);
  }
}
