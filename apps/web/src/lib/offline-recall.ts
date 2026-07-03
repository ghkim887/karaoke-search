import type { SongRecord } from '@karaoke/schema';
import {
  type KaraokeProvider,
  MAX_PREFIX_TOKEN_CHARS,
  makeHangulInitials,
  normalizeKaraokeNumber,
  normalizeSearchText,
  parseKaraokeNumberQuery,
} from '@karaoke/search';

/**
 * Offline recall side-index (T6-1). Closes two structural recall gaps in the
 * MiniSearch offline/fallback path that the worker `/api/search` covers but a
 * pure text index cannot: karaoke-number queries (`68381`, `tj68381`) and
 * all-choseong Hangul-initials queries (`ㄴㄷ`, `ㅇㅅㅂ`). MiniSearch indexes
 * only title/artist TEXT, so both query shapes return nothing from it today.
 *
 * This structure is derived from the SAME `SongRecord[]` the MiniSearch index is
 * built from and is consulted by `searchLocalIndex` BEFORE the text path, but
 * ONLY for those two query shapes — every other query still flows through
 * MiniSearch byte-for-byte unchanged. The matching + ranking here deliberately
 * mirror the worker's number and initial semantics (apps/worker/src/index.ts)
 * so the two paths converge:
 *
 *  - Number ranking replicates the worker's fixed per-predicate scores
 *    (`findKaraokeNumberCandidateRows`): exact `number` > exact `number_key` >
 *    `number`/`number_key` prefix, summed per song. Ties break by the record's
 *    position in the corpus array, which equals the worker's `sort_order`
 *    (@karaoke/data-store writes `sort_order = array index`).
 *  - Initials ranking replicates the worker's single-`initial`-token score for an
 *    all-choseong query. Because the token's idf and query-weight are constant
 *    across every matching song, the worker's order collapses to the SUM of the
 *    matched fields' weights (title 5, artist 3, alias 2), tie-broken by the same
 *    corpus position. See @karaoke/data-store SEARCH_TEXT_FIELDS.
 */
export interface OfflineRecallIndex {
  /**
   * Ranked record ids for a karaoke-number query, or `null` when `query` is not
   * a number query (so the caller falls through to the text path). `scope`, when
   * provided, restricts matches to numbers belonging to those providers — the
   * vendor-chip analogue of the worker's `kn.provider IN (...)` filter.
   */
  matchNumberQuery(query: string, scope?: ReadonlySet<KaraokeProvider>): string[] | null;
  /**
   * Ranked record ids for a Hangul-initials query — one composed only of
   * choseong (standalone consonants) and whitespace, yielding ≥ 2 initials — or
   * `null` when `query` is not that shape (caller falls through to the text
   * path). This is a REPLACEMENT path: MiniSearch returns nothing for a jamo
   * query, so there is no existing text result to preserve. Interior spaces are
   * collapsed into a single initial token, matching the worker's
   * `makeHangulInitials(query)` `initial` token (`"ㅂㅇ ㄷㄹ"` == `"ㅂㅇㄷㄹ"`).
   */
  matchInitialsQuery(query: string): string[] | null;
}

/** Providers in the worker's canonical order (matches @karaoke/data-store). */
const PROVIDERS: readonly KaraokeProvider[] = ['tj', 'ky', 'joysound'];

// Fixed per-predicate scores mirrored from apps/worker findKaraokeNumberCandidateRows.
const SCORE_NUMBER_EXACT = 1_000_000_000;
const SCORE_KEY_EXACT = 990_000_000;
const SCORE_NUMBER_PREFIX = 900_000_000;
const SCORE_KEY_PREFIX = 900_000_000;

// Field weights mirrored from @karaoke/data-store SEARCH_TEXT_FIELDS. Aliases
// collapse into a single slot (the worker dedupes `initial` tokens per field).
const WEIGHT_TITLE = 5;
const WEIGHT_ARTIST = 3;
const WEIGHT_ALIAS = 2;

// Hangul choseong (leading-consonant) code-point range. A standalone-consonant
// query (typed as compatibility jamo ㄱ-ㅎ) NFKC-folds into this range, so an
// "all initials" query is one whose normalized form is choseong + whitespace
// (interior spaces let a user separate words, e.g. "ㅂㅇ ㄷㄹ").
const HANGUL_CHOSEONG_START = 0x1100;
const HANGUL_CHOSEONG_END = 0x1112;

interface NumberEntry {
  idx: number;
  provider: KaraokeProvider;
  /** Raw catalog number, exactly as stored on the record (worker `number`). */
  number: string;
  /** Digits-only, leading-zeros trimmed (worker `number_key`), or `null`. */
  key: string | null;
}

/** Precomputed choseong of each weighted field for one song. */
interface InitialSlots {
  titlePrimary: string;
  titleKo: string;
  artistPrimary: string;
  artistKo: string;
  aliases: string[];
}

/** Worker `number_key`: digits only, leading zeros trimmed. `null` if no digit
 *  survives (mirrors @karaoke/data-store `karaokeNumberKey`). */
function numberKeyOf(raw: string): string | null {
  const digits = normalizeKaraokeNumber(raw);
  if (digits.length === 0) {
    return null;
  }
  return digits.replace(/^0+/u, '') || '0';
}

function trimLeadingZeroes(value: string): string {
  return value.replace(/^0+/u, '') || '0';
}

/** Whether `value` is composed only of Hangul choseong code points and
 *  whitespace (and contains at least one choseong). */
function isChoseongQuery(value: string): boolean {
  let hasChoseong = false;
  for (const character of value) {
    if (/\s/u.test(character)) {
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < HANGUL_CHOSEONG_START ||
      codePoint > HANGUL_CHOSEONG_END
    ) {
      return false;
    }
    hasChoseong = true;
  }
  return hasChoseong;
}

/** First index `i` where `accessor(sorted[i]) >= target` (lower bound). */
function lowerBound<T>(
  sorted: readonly T[],
  accessor: (item: T) => string,
  target: string,
): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: mid is always in-bounds.
    if (accessor(sorted[mid]!) < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Walk the contiguous run of entries whose `accessor` value starts with
 *  `prefix` (sorted array ⇒ the run is contiguous from the lower bound). */
function walkPrefix<T>(
  sorted: readonly T[],
  accessor: (item: T) => string,
  prefix: string,
  visit: (item: T) => void,
): void {
  for (let i = lowerBound(sorted, accessor, prefix); i < sorted.length; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by sorted.length.
    const item = sorted[i]!;
    if (!accessor(item).startsWith(prefix)) {
      return;
    }
    visit(item);
  }
}

export function buildOfflineRecallIndex(records: readonly SongRecord[]): OfflineRecallIndex {
  const ids: string[] = new Array(records.length);
  const numberEntries: NumberEntry[] = [];
  const initialSlots: InitialSlots[] = new Array(records.length);

  records.forEach((record, idx) => {
    ids[idx] = record.id;
    for (const provider of PROVIDERS) {
      const raw = record.karaoke_numbers[provider];
      if (raw !== null) {
        numberEntries.push({ idx, provider, number: raw, key: numberKeyOf(raw) });
      }
    }
    initialSlots[idx] = {
      titlePrimary: makeHangulInitials(record.title_primary),
      titleKo: record.title_ko !== null ? makeHangulInitials(record.title_ko) : '',
      artistPrimary: makeHangulInitials(record.artist_primary),
      artistKo: record.artist_ko !== null ? makeHangulInitials(record.artist_ko) : '',
      aliases: (record.artist_aliases ?? [])
        .map((alias) => makeHangulInitials(alias))
        .filter((initials) => initials.length > 0),
    };
  });

  // Two sorted views drive exact + prefix number lookups via binary search.
  const byNumber = [...numberEntries].sort((a, b) =>
    a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
  );
  const byKey = numberEntries
    .filter((entry): entry is NumberEntry & { key: string } => entry.key !== null)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    matchNumberQuery(query, scope) {
      const parsed = parseKaraokeNumberQuery(query);
      if (parsed === null) {
        return null;
      }
      // An empty (or absent) scope means "no vendor filter", matching
      // `filterByVendors` — only a non-empty set narrows to those providers.
      const scoped = scope !== undefined && scope.size > 0;
      const allowed = (provider: KaraokeProvider): boolean =>
        (parsed.provider === undefined || provider === parsed.provider) &&
        (!scoped || scope.has(provider));

      const wanted = parsed.number;
      const wantedKey = trimLeadingZeroes(wanted);
      // Per-song predicate flags: number=exact, key=exact, number prefix, key prefix.
      const flags = new Map<number, { p1: boolean; p2: boolean; p3: boolean; p4: boolean }>();
      const flagsFor = (idx: number) => {
        let entry = flags.get(idx);
        if (entry === undefined) {
          entry = { p1: false, p2: false, p3: false, p4: false };
          flags.set(idx, entry);
        }
        return entry;
      };

      walkPrefix(
        byNumber,
        (entry) => entry.number,
        wanted,
        (entry) => {
          if (!allowed(entry.provider)) {
            return;
          }
          const flag = flagsFor(entry.idx);
          flag.p3 = true;
          if (entry.number === wanted) {
            flag.p1 = true;
          }
        },
      );
      walkPrefix(
        byKey,
        (entry) => entry.key,
        wantedKey,
        (entry) => {
          if (!allowed(entry.provider)) {
            return;
          }
          const flag = flagsFor(entry.idx);
          flag.p4 = true;
          if (entry.key === wantedKey) {
            flag.p2 = true;
          }
        },
      );

      const scored: { idx: number; score: number }[] = [];
      for (const [idx, flag] of flags) {
        const score =
          (flag.p1 ? SCORE_NUMBER_EXACT : 0) +
          (flag.p2 ? SCORE_KEY_EXACT : 0) +
          (flag.p3 ? SCORE_NUMBER_PREFIX : 0) +
          (flag.p4 ? SCORE_KEY_PREFIX : 0);
        scored.push({ idx, score });
      }
      scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
      // biome-ignore lint/style/noNonNullAssertion: idx is a valid corpus index.
      return scored.map((entry) => ids[entry.idx]!);
    },

    matchInitialsQuery(query) {
      const normalized = normalizeSearchText(query).trim();
      // Fire ONLY for a choseong(+whitespace) query (standalone consonants),
      // never for Hangul syllables or mixed scripts — those keep their
      // byte-identical text path. The token is derived like the worker's
      // `makeHangulInitials(query)` `initial` token (choseong → compatibility
      // jamo, interior spaces dropped), sliced to the shared prefix-token cap.
      if (!isChoseongQuery(normalized)) {
        return null;
      }
      const token = makeHangulInitials(normalized).slice(0, MAX_PREFIX_TOKEN_CHARS);
      if (Array.from(token).length < 2) {
        return null;
      }

      const scored: { idx: number; weight: number }[] = [];
      initialSlots.forEach((slots, idx) => {
        let weight = 0;
        if (slots.titlePrimary.startsWith(token)) {
          weight += WEIGHT_TITLE;
        }
        if (slots.titleKo.startsWith(token)) {
          weight += WEIGHT_TITLE;
        }
        if (slots.artistPrimary.startsWith(token)) {
          weight += WEIGHT_ARTIST;
        }
        if (slots.artistKo.startsWith(token)) {
          weight += WEIGHT_ARTIST;
        }
        if (slots.aliases.some((initials) => initials.startsWith(token))) {
          weight += WEIGHT_ALIAS;
        }
        if (weight > 0) {
          scored.push({ idx, weight });
        }
      });
      scored.sort((a, b) => b.weight - a.weight || a.idx - b.idx);
      // biome-ignore lint/style/noNonNullAssertion: idx is a valid corpus index.
      return scored.map((entry) => ids[entry.idx]!);
    },
  };
}
