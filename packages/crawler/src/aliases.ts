import type { SongRecord } from '@karaoke/schema';
import { canonicalizeArtistName } from './artistCanonicalization.js';
import { normalize } from './normalize.js';

/**
 * Alias-resolution stage. Runs BEFORE `mergeRecords` so that pipe-form
 * `artist_primary` strings (`"ずっと真夜中でいいのに。｜ZUTOMAYO"`) are split
 * into a canonical + aliases pair, and bare records whose `artist_primary`
 * happens to equal a known alias of another canonical are re-keyed to the
 * canonical surface form.
 *
 * Spec: docs/superpowers/specs/2026-05-04-artist-alias-dedup-design.md.
 *
 * Splitter scope: ONLY the full-width pipe `｜` (U+FF5C). The ASCII `|`
 * (U+007C) is intentionally NOT a delimiter — the only known ASCII-pipe band
 * name in the corpus is `Qverktett:||` and treating ASCII `|` as a separator
 * would break it. ` - ` and ` / ` are also explicitly out of scope.
 *
 * Conflict policy: when the alias map detects a collision (the same alias
 * surface form points to two distinct canonicals), DON'T silently merge —
 * leave both pipe-form records as-is on the split (the splitting itself is
 * always correct), but skip Phase 3's bare-record rewrite for that alias and
 * emit a warning. The maintainer dispositions each.
 */

/** The ONLY delimiter the resolver splits on. Full-width pipe (U+FF5C). */
const FULLWIDTH_PIPE = '｜';

/** A single alias→canonical collision detected during Phase 2. */
export interface AliasConflict {
  /** Original (un-normalized) alias surface form — first observed. */
  alias: string;
  /** All canonical surface forms keyed by this alias (un-normalized). */
  canonicals: string[];
  /** Number of bare records left untouched because of the collision. */
  affected: number;
}

export interface AliasResolutionResult {
  records: SongRecord[];
  warnings: AliasConflict[];
}

/**
 * Trim the surrounding whitespace from a pipe-segment after NFKC. Mirrors the
 * shape of the splitter's per-segment cleanup; isolated for testability.
 */
function trimSegment(s: string): string {
  return s.normalize('NFKC').trim();
}

/**
 * Split `artist_primary` on the full-width pipe and return the surviving
 * non-empty trimmed segments. An empty list signals "no pipe in input"; a
 * 1-element list signals "pipe present but only one non-empty segment"
 * (malformed — caller emits a warning).
 */
function splitOnPipe(artist: string): string[] {
  if (!artist.includes(FULLWIDTH_PIPE)) return [];
  const raw = artist.split(FULLWIDTH_PIPE);
  const out: string[] = [];
  for (const seg of raw) {
    const t = trimSegment(seg);
    if (t !== '') out.push(t);
  }
  return out;
}

/**
 * Deduplicate while preserving first-seen order. Used for the `aliases`
 * portion of a pipe-split (`X｜Y｜Y` → `["Y"]`).
 */
function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Single-pass per-phase alias resolver. Returns a NEW array of records — does
 * NOT mutate inputs. The crawler's pipeline contract treats `SongRecord`
 * instances as immutable upstream of merge.
 *
 * Algorithm (per spec §3.B):
 *
 *   Phase 1 — Walk every record. For each whose `artist_primary` contains
 *   `｜`, split on the codepoint and trim segments via NFKC. Discard empty
 *   segments. If fewer than 2 non-empty segments survive, treat as malformed
 *   (untouched + warning). Otherwise: canonical = segments[0], aliases =
 *   segments.slice(1) (deduped, order-preserving). Populate the alias map
 *   `M: Map<aliasKey, Set<canonicalKey>>` and a parallel display map for
 *   resolving back to original surface forms.
 *
 *   Phase 2 — For each (aliasKey, canonicalSet) in M: when canonicalSet.size
 *   > 1, mark the aliasKey as colliding and emit a warning.
 *
 *   Phase 3 — Walk every record again. For each whose `artist_primary` does
 *   NOT contain `｜`: compute `bareKey = normalize(artist_primary)`. If
 *   `bareKey` is in M and is NOT colliding, look up the singleton canonical;
 *   when bareKey === canonicalKey, no rewrite (record already canonical);
 *   otherwise rewrite `artist_primary` to the canonical surface form and add
 *   the original bare string to `artist_aliases` (deduped, exclude when it
 *   equals the canonical).
 */
export function resolveArtistAliases(records: SongRecord[]): AliasResolutionResult {
  const warnings: AliasConflict[] = [];

  // Phase 1: split pipe-form records and seed the alias map.
  // `aliasMap`: normalized alias key → set of normalized canonical keys.
  // `aliasDisplay`: normalized alias key → first-observed un-normalized surface form.
  // `canonicalDisplay`: normalized canonical key → first-observed un-normalized surface form.
  const aliasMap = new Map<string, Set<string>>();
  const aliasDisplay = new Map<string, string>();
  const canonicalDisplay = new Map<string, string>();

  // Seed the alias map for one (canonical, aliases) pair. Shared by the
  // pipe-form path and the A1 adapter-emitted path (below) so both feed
  // collision detection (Phase 2) and propagation (`aliasesByCanonical`)
  // uniformly. Registers `canonicalDisplay[canonicalKey]` and, for each alias
  // that doesn't degenerate onto its own canonical, an `aliasMap` edge
  // alias→canonical plus its display form.
  const seedAliasMap = (canonical: string, aliases: string[]): void => {
    const canonicalKey = normalize(canonical);
    if (!canonicalDisplay.has(canonicalKey)) {
      canonicalDisplay.set(canonicalKey, canonical);
    }
    for (const a of aliases) {
      const aliasKey = normalize(a);
      // Don't index the alias if it normalizes to the same key as the
      // canonical (degenerate case: `"X｜X"` produces no useful alias map
      // entry; the alias would just collapse onto its own canonical). The
      // record still carries the alias in `artist_aliases` for display, but
      // the map is suppressed so it cannot collide.
      if (aliasKey === canonicalKey) continue;
      if (aliasKey === '') continue;
      if (!aliasDisplay.has(aliasKey)) {
        aliasDisplay.set(aliasKey, a);
      }
      const set = aliasMap.get(aliasKey);
      if (set) set.add(canonicalKey);
      else aliasMap.set(aliasKey, new Set([canonicalKey]));
    }
  };

  // Phase 1 mutation: produce a parallel array of records (cloned where the
  // pipe-split fires; identity-passed otherwise). We finish Phase 1 before
  // computing Phase 2 collisions because alias map population is order-
  // independent for the collision check.
  const phase1: SongRecord[] = records.map((r) => {
    const segments = splitOnPipe(r.artist_primary);
    if (segments.length === 0) {
      // No pipe in input — pass through unchanged. A1 (b): when a bare record
      // carries an adapter-emitted `artist_aliases` (e.g. the JOYSOUND
      // normalizer's native-name alias), seed the alias map with its declared
      // canonical (= `artist_primary`) so the alias (i) participates in
      // collision detection — one alias under two distinct canonicals stays
      // un-merged + warned — and (ii) propagates to same-canonical bare records
      // via `aliasesByCanonical`. The record itself is still identity-passed
      // (its `artist_aliases` is preserved untouched — A1 (a)).
      if (r.artist_aliases && r.artist_aliases.length > 0) {
        seedAliasMap(r.artist_primary, dedupePreserveOrder(r.artist_aliases));
      }
      return r;
    }
    if (segments.length < 2) {
      // Malformed: pipe present, but fewer than 2 non-empty segments.
      // Leave the record untouched, emit a warning. The warning is recorded
      // in Phase 1 (rather than batched into Phase 2) because there's no
      // alias map entry to disposition — it's purely a malformed-input flag.
      warnings.push({
        alias: r.artist_primary,
        canonicals: [],
        affected: 1,
      });
      return r;
    }

    // segments.length >= 2 by the check above, so segments[0] is defined.
    const canonical = segments[0] as string;
    const aliases = dedupePreserveOrder(segments.slice(1));
    seedAliasMap(canonical, aliases);

    return {
      ...r,
      artist_primary: canonical,
      // Spec §2.B: omit the field when there are no aliases (storage compact).
      ...(aliases.length > 0 ? { artist_aliases: aliases } : {}),
    };
  });

  // Phase 2: detect alias→canonical collisions. Track which aliasKeys are
  // unsafe to use for Phase 3 re-keying; the affected count is filled in
  // during Phase 3 so the warning's `affected` reflects actual residual bare
  // records (not just hypothetical ones).
  const collidingKeys = new Set<string>();
  // Map collidingAliasKey → AliasConflict that the affected counter writes to.
  const collisionWarnings = new Map<string, AliasConflict>();
  for (const [aliasKey, canonicalSet] of aliasMap) {
    if (canonicalSet.size > 1) {
      collidingKeys.add(aliasKey);
      const conflict: AliasConflict = {
        alias: aliasDisplay.get(aliasKey) ?? aliasKey,
        canonicals: [...canonicalSet]
          .map((k) => canonicalDisplay.get(k) ?? k)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        affected: 0,
      };
      collisionWarnings.set(aliasKey, conflict);
      warnings.push(conflict);
    }
  }

  if (records.length !== phase1.length) {
    throw new Error(
      `aliases.ts Phase 2 invariant violated: records.length (${records.length}) !== phase1.length (${phase1.length}). Phase 1 must produce exactly one phase1[] entry per input record.`,
    );
  }

  // Pre-Phase-3 helper: a reverse map from normalized canonical key →
  // ordered list of (un-normalized) alias surface forms. Built by walking
  // Phase 1 once. Used in Phase 3's "already canonical" branch so a record
  // whose `artist_primary` is the canonical surface form still picks up known
  // aliases for search coverage. Without this enhancement, only records that
  // arrived as a pipe-form OR that were re-keyed from a bare alias would carry
  // the alias — bare records that happened to use the canonical Japanese name
  // would silently lose the Latin alias for search. (Spec §6 promises
  // "searchable" + "visible"; omitting this lookup would create a
  // search-coverage gap on records that incidentally arrived in canonical
  // form.)
  //
  // PROPAGATION SOURCE (A1, 2026-06-09 — invariant WIDENED): `aliasesByCanonical`
  // is now populated from BOTH (1) Phase 1 pipe-form records (canonical =
  // segments[0]) AND (2) bare records carrying an adapter-emitted
  // `artist_aliases` (the schema permits this on `RawSongRecord` — see
  // `packages/schema/src/index.ts:79-92`; the JOYSOUND normalizer emits the
  // native artist name this way). For (2) the canonical IS the record's own
  // (unchanged) `artist_primary`. Both sources keyed identically, so an
  // adapter-emitted alias propagates to same-canonical bare records exactly as
  // a pipe-form alias does. Collision safety is unchanged: an alias declared
  // under two distinct canonicals (whether by pipe-form or adapter) lands in
  // `aliasMap` with set size > 1 → `collidingKeys` → Phase 3 leaves the bare
  // alias-record untouched + warns. The propagation branch keys on the
  // CANONICAL (not the alias), so it never crosses a collision boundary.
  const aliasesByCanonical = new Map<string, string[]>();
  const addAliases = (canonicalKey: string, aliases: readonly string[]): void => {
    const existing = aliasesByCanonical.get(canonicalKey);
    if (existing) {
      // Union order-preserving across multiple records sharing the same
      // canonical (e.g. several `スピッツ｜Spitz` rows from different Tistory
      // posts, or a pipe-form + adapter-emitted pair).
      const seen = new Set(existing);
      for (const a of aliases) {
        if (!seen.has(a)) {
          existing.push(a);
          seen.add(a);
        }
      }
    } else {
      aliasesByCanonical.set(canonicalKey, [...aliases]);
    }
  };
  for (const resolvedRec of phase1) {
    // (1) pipe-form: canonical is the Phase-1-resolved `artist_primary`.
    // (2) adapter-emitted on a bare record: canonical is the unchanged
    //     `artist_primary`. Both reduce to "the resolved record's
    //     `artist_primary` is the canonical and its `artist_aliases` are the
    //     known aliases" — so a single keyed-on-resolved-primary path covers
    //     both, no pipe-form-only guard needed.
    const aliases = resolvedRec.artist_aliases;
    if (!aliases || aliases.length === 0) continue;
    addAliases(normalize(resolvedRec.artist_primary), aliases);
  }

  // Phase 3: re-key bare records (and propagate known aliases onto bare-
  // canonical records — see `aliasesByCanonical` rationale above).
  // NOTE: the propagation source is `aliasesByCanonical`, populated from BOTH
  // pipe-form Phase 1 rows AND bare records carrying adapter-emitted
  // `artist_aliases` (A1, 2026-06-09). See the PROPAGATION SOURCE comment above.
  const phase3 = phase1.map((r) => {
    if (r.artist_primary.includes(FULLWIDTH_PIPE)) {
      // Pipe-form records were already canonicalized in Phase 1. Skip.
      return r;
    }
    const bareKey = normalize(r.artist_primary);
    if (bareKey === '') return r;

    if (collidingKeys.has(bareKey)) {
      // Bare record matches a colliding alias — the safe action is to leave
      // it untouched. Bump the conflict's affected counter so the warning
      // reflects real residual records, not hypothetical ones.
      // See aliases.test.ts "collision guard vs canonical identity (audit regression)"
      // for the X｜Y / Y｜Z / bare-Y scenario that confirms this guard is alias-keyed.
      const conflict = collisionWarnings.get(bareKey);
      if (conflict) conflict.affected += 1;
      return r;
    }

    // Bare record IS itself a known canonical — propagate any registered
    // aliases for search coverage. This is the "already canonical" branch
    // (the spec's `bareKey === canonicalKey` skip case, extended to attach
    // the canonical's known aliases). Identity-pass when there are no
    // known aliases for this canonical to keep the no-op fast path.
    if (aliasesByCanonical.has(bareKey)) {
      const known = aliasesByCanonical.get(bareKey);
      if (!known || known.length === 0) return r;
      const existing = r.artist_aliases ?? [];
      // Filter aliases that equal the canonical surface form (defense-in-
      // depth: shouldn't happen because Phase 1 suppresses self-aliases,
      // but cheap to enforce).
      const merged = dedupePreserveOrder([...existing, ...known]).filter(
        (a) => a !== r.artist_primary,
      );
      if (merged.length === existing.length && merged.every((a, idx) => a === existing[idx])) {
        // No change — return the original to keep idempotence byte-stable.
        return r;
      }
      return {
        ...r,
        artist_aliases: merged,
      };
    }

    const canonicalSet = aliasMap.get(bareKey);
    if (!canonicalSet || canonicalSet.size !== 1) {
      // Either bareKey isn't an alias, or it's an alias of zero/many
      // canonicals (the multi-canonical case is already in collidingKeys, so
      // this branch is the no-match case).
      return r;
    }
    // size === 1 by the check above.
    const [canonicalKey] = [...canonicalSet];
    if (canonicalKey === undefined) return r;
    if (canonicalKey === bareKey) {
      // Should be unreachable — handled by the `aliasesByCanonical` branch
      // above. Defensive identity-pass.
      return r;
    }
    const canonicalSurface = canonicalDisplay.get(canonicalKey);
    if (canonicalSurface === undefined) return r;

    // Rewrite to the canonical surface form. Add the original bare string as
    // an alias, then attach any other known aliases for this canonical so
    // re-keyed records carry the same alias set as the pipe-form records.
    const originalBare = r.artist_primary;
    const existing = r.artist_aliases ?? [];
    const known = aliasesByCanonical.get(canonicalKey) ?? [];
    let nextAliases: string[];
    if (originalBare === canonicalSurface) {
      nextAliases = dedupePreserveOrder([...existing, ...known]);
    } else {
      nextAliases = dedupePreserveOrder([...existing, originalBare, ...known]);
    }
    nextAliases = nextAliases.filter((a) => a !== canonicalSurface);
    return {
      ...r,
      artist_primary: canonicalSurface,
      ...(nextAliases.length > 0 ? { artist_aliases: nextAliases } : {}),
    };
  });

  // Phase 4: NFKC-variant canonicalization. Runs after Phase 3 re-keying so
  // any pipe-form alias rewrites have already settled. Applied only to bare
  // records (pipe-form records were canonicalized in Phase 1 and never reach
  // this branch). When a record's `artist_primary` matches a
  // CanonicalizationRule `from`, it is rewritten to `to`, and the original
  // surface form is added to `artist_aliases` (deduped, excluding the new
  // canonical) so search recall is preserved.
  const phase4 = phase3.map((r) => {
    // Skip pipe-form records — they were already handled in Phase 1.
    if (r.artist_primary.includes(FULLWIDTH_PIPE)) return r;
    const canonical = canonicalizeArtistName(r.artist_primary);
    if (canonical === r.artist_primary) return r; // no rule matched

    const originalForm = r.artist_primary;
    const existing = r.artist_aliases ?? [];
    const nextAliases = dedupePreserveOrder([...existing, originalForm]).filter(
      (a) => a !== canonical,
    );
    return {
      ...r,
      artist_primary: canonical,
      ...(nextAliases.length > 0 ? { artist_aliases: nextAliases } : {}),
    };
  });

  return { records: phase4, warnings };
}
