import type { SongRecord } from '@karaoke/schema';
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

  // Phase 1 mutation: produce a parallel array of records (cloned where the
  // pipe-split fires; identity-passed otherwise). We finish Phase 1 before
  // computing Phase 2 collisions because alias map population is order-
  // independent for the collision check.
  const phase1: SongRecord[] = records.map((r) => {
    const segments = splitOnPipe(r.artist_primary);
    if (segments.length === 0) {
      // No pipe in input — pass through unchanged.
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

  // Pre-Phase-3 helper: a reverse map from normalized canonical key →
  // ordered list of (un-normalized) alias surface forms. Built by walking
  // the pipe-form records of Phase 1 once. Used in Phase 3's "already
  // canonical" branch so a record whose `artist_primary` is the canonical
  // surface form still picks up known aliases for search coverage. Without
  // this enhancement, only records that arrived as a pipe-form OR that were
  // re-keyed from a bare alias would carry the alias — bare records that
  // happened to use the canonical Japanese name would silently lose the
  // Latin alias for search. (Spec §6 promises "searchable" + "visible";
  // omitting this lookup would create a search-coverage gap on records
  // that incidentally arrived in canonical form.)
  const aliasesByCanonical = new Map<string, string[]>();
  for (let i = 0; i < records.length; i++) {
    const original = records[i];
    const resolvedRec = phase1[i];
    if (!original || !resolvedRec) continue;
    if (!original.artist_primary.includes(FULLWIDTH_PIPE)) continue;
    const aliases = resolvedRec.artist_aliases;
    if (!aliases || aliases.length === 0) continue;
    const canonicalKey = normalize(resolvedRec.artist_primary);
    const existing = aliasesByCanonical.get(canonicalKey);
    if (existing) {
      // Union order-preserving across multiple pipe-form records sharing the
      // same canonical (e.g. several `スピッツ｜Spitz` rows from different
      // Tistory posts).
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
  }

  // Phase 3: re-key bare records (and propagate known aliases onto bare-
  // canonical records — see `aliasesByCanonical` rationale above).
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

  return { records: phase3, warnings };
}
