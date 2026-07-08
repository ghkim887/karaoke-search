#!/usr/bin/env node
// Build a deploy-READY-but-NOT-DEPLOYED *candidate* corpus that merges the
// audited JOYSOUND full-catalog admits into the current corpus.
//
//   decision-log.jsonl (admit rows) ──▶ JOYSOUND SongRecords
//                                       (normalizeJoysoundRecord shape)
//   current corpus (songs.json) ──▶ conflict-resolution (null misattributed
//                                   blog joysound numbers)
//                                       │
//                                       ▼
//   resolveArtistAliases ▶ mergeRecords ▶ candidate corpus
//                                       │
//                                       ▼
//   schema-validate every record  +  compareCorpora delta report
//
// CRITICAL: this writes the candidate to .tmp_review/.../songs-candidate.json,
// NEVER to apps/web/public/data/songs.json. It does NOT deploy. There is NO
// 1000-delta safety gate (the JOYSOUND sweep adds 200k+ records on purpose).
//
// CHECKPOINT-1: the detail sweep started with a stale 175-entry ALLOW
// classifier; the owner later removed 3 SUSPECT entries (Korean-language
// songs) from reviewedJoysoundOverrides.ts (175 -> 172, see
// tasks/checkpoint1-screening.md). Depending on when the sweep picked up the
// rebuilt classifier, the decision log may record those 3 selSongNos as
// admits (stale dist) or drops — either way they must NOT enter the corpus,
// so this builder EXCLUDES any admit on them (`excludeCheckpoint1Admits`)
// before any downstream stage. A current sweep on a from-corpus listing no
// longer lists the 3 at all (they were removed from the overrides and dropped
// from the corpus), which is fine — nothing to exclude.
//
// Heap: parses ~12 MB corpus + ~291k decision rows; run with
//   node --max-old-space-size=8192 scripts/build-joysound-candidate.mjs
//
// Exported helpers (`admitRowToListItem`, `buildJoysoundRecord`,
// `normalizeForConflictMatch`, `resolveExistingNumberConflicts`,
// `excludeCheckpoint1Admits`, `classifyMutation`, `stableStringify`) are
// unit-tested in scripts/build-joysound-candidate.test.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { compareCorpora } from './lib/corpus-audit-guardrails.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const SONG_PAGE_BASE = 'https://www.joysound.com/web/search/song';

const songsPath = resolve(repoRoot, 'apps/web/public/data/songs.json');
const decisionLogPath = resolve(
  repoRoot,
  '.tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl',
);
const candidateOutPath = resolve(
  repoRoot,
  '.tmp_review/joysound-detail-sweep-20260610/songs-candidate.json',
);
const deltaOutPath = resolve(
  repoRoot,
  '.tmp_review/joysound-detail-sweep-20260610/candidate-delta.json',
);

const normalizerJsPath = resolve(
  repoRoot,
  'packages/crawler/dist/adapters/joysound-official/normalizer.js',
);
const mergeJsPath = resolve(repoRoot, 'packages/crawler/dist/merge.js');
const aliasesJsPath = resolve(repoRoot, 'packages/crawler/dist/aliases.js');
const schemaJsPath = resolve(repoRoot, 'packages/schema/dist/index.js');

// --- Pure transform helpers (unit-tested) --------------------------------

/**
 * Reconstruct a `JoysoundListItem` (the `normalizeJoysoundRecord` input) from a
 * decision-log admit row. We pass the RAW (still-hyphenated, if any) selSongNo
 * through to `selSongNo` so the normalizer's own hyphen-strip + digits guard
 * runs — `selSongNoRaw` is preferred; the already-dashless `selSongNo` is the
 * fallback. `artistId` / `tieupId` are not in the decision log and are null
 * (matching the listing parser's `$undefined` → null normalization).
 *
 * @param {Record<string, unknown>} entry
 * @returns {import('../packages/crawler/dist/adapters/joysound-official/types.js').JoysoundListItem}
 */
export function admitRowToListItem(entry) {
  const selSongNo =
    typeof entry.selSongNoRaw === 'string' && entry.selSongNoRaw.length > 0
      ? entry.selSongNoRaw
      : String(entry.selSongNo ?? '');
  return {
    naviGroupId: String(entry.naviGroupId ?? ''),
    selSongNo,
    songName: String(entry.title ?? ''),
    artistName: String(entry.artist ?? ''),
    artistId: null,
    tieupInfo: typeof entry.tieupInfo === 'string' ? entry.tieupInfo : null,
    tieupId: null,
  };
}

let _normalizeJoysoundRecord = null;
/**
 * Lazily-bound `normalizeJoysoundRecord` from the built crawler dist. Set by
 * `loadNormalizer()` before `buildJoysoundRecord` is used outside tests; tests
 * import it directly via the module-level binding (the test triggers the
 * top-level await import below).
 */
export async function loadNormalizer() {
  if (_normalizeJoysoundRecord) return _normalizeJoysoundRecord;
  const mod = await import(pathToFileURL(normalizerJsPath).href);
  if (typeof mod.normalizeJoysoundRecord !== 'function') {
    throw new Error('dist normalizer did not export normalizeJoysoundRecord');
  }
  _normalizeJoysoundRecord = mod.normalizeJoysoundRecord;
  return _normalizeJoysoundRecord;
}

/**
 * Build a JOYSOUND SongRecord from a decision-log admit row using the REAL
 * `normalizeJoysoundRecord` (so the field shape, id, source_url, and
 * hyphen-strip + schema validation match the crawler exactly).
 *
 * Detail-sweep rows embed the parsed `JoysoundDetail` (compacted: no
 * `lyricIntro`, null/empty fields omitted) under `entry.detail` — thread it
 * through so the normalizer's detail-preferring title/artist and the A1
 * `artist_aliases` enrichment (native-script `artistNameForeign`) fire. Rows
 * without `detail` (listing-only sweeps, failed fetches, older logs) behave
 * exactly as before.
 *
 * @param {Record<string, unknown>} entry
 * @param {string} crawledAt
 * @returns {import('@karaoke/schema').SongRecord}
 */
export function buildJoysoundRecord(entry, crawledAt) {
  if (!_normalizeJoysoundRecord) {
    throw new Error('buildJoysoundRecord: call loadNormalizer() before use');
  }
  const listItem = admitRowToListItem(entry);
  const sourceUrl = `${SONG_PAGE_BASE}/${encodeURIComponent(listItem.naviGroupId)}`;
  return _normalizeJoysoundRecord({
    listItem,
    ...(entry.detail ? { detail: entry.detail } : {}),
    sourceUrl,
    crawledAt,
  });
}

/**
 * Normalize a title/artist string the SAME way the audit comparator does
 * (`normalizeForComparison` in corpus-audit-guardrails.mjs): NFKC, collapse
 * whitespace, trim, lowercase (ja-JP). Used to decide "same song vs different
 * song" for an overlapping JOYSOUND number.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeForConflictMatch(value) {
  const str = typeof value === 'string' ? value : '';
  return str.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
}

function normalizeJoysoundNumber(value) {
  const str = typeof value === 'string' ? value : '';
  return str.replace(/-/gu, '');
}

/**
 * Normalized (dashless) JOYSOUND number key of a decision-log row: prefer the
 * raw (possibly hyphenated) `selSongNoRaw`, fall back to `selSongNo`, then
 * hyphen-strip — the same selSongNo semantics `admitRowToListItem` feeds the
 * normalizer. Shared by the CHECKPOINT-1 exclusion and conflict resolution.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function admitNumberKey(entry) {
  return normalizeJoysoundNumber(
    typeof entry.selSongNoRaw === 'string' && entry.selSongNoRaw.length > 0
      ? entry.selSongNoRaw
      : String(entry.selSongNo ?? ''),
  );
}

/**
 * CHECKPOINT-1 SUSPECT selSongNos (dashless). The detail sweep started with a
 * stale 175-entry ALLOW classifier in memory; the owner removed these 3
 * Korean-language songs from reviewedJoysoundOverrides.ts afterwards
 * (175 -> 172, see tasks/checkpoint1-screening.md). Depending on when the
 * sweep picked up the rebuilt classifier, the decision log may record them as
 * admits (stale dist) or drops — either way they must NOT (re-)enter the
 * corpus. The real 20260610 log records all 3 as `drop`/`foreign-korean`, so
 * the expected build outcome is 0 exclusions / 3 already-dropped-in-log.
 */
export const CHECKPOINT1_EXCLUDED_SEL_SONG_NOS = ['148140', '153397', '735357'];

/**
 * Drop the CHECKPOINT-1 SUSPECT admits from the admit set, BEFORE record
 * building and before `resolveExistingNumberConflicts` sees them. Rows are
 * matched on the normalized (selSongNoRaw-preferred, hyphen-stripped) number.
 *
 * INVARIANT: none of the 3 SUSPECT numbers may survive as an admit. This holds
 * regardless of how the decision log looks, so all of these PASS:
 *   - ABSENT   — a current sweep on a from-corpus listing no longer lists the 3
 *                (they were removed from reviewedJoysoundOverrides.ts and
 *                dropped from the corpus); nothing to exclude (excluded = 0).
 *   - as DROP  — the real 20260610 log records all 3 as `drop`/`foreign-korean`,
 *                so they never reach the admit set (excluded = 0).
 *   - as ADMIT — a log written by the stale 175-entry classifier records them
 *                as admits; those rows are excluded here (excluded = 3).
 * `checkpoint1Decisions` (every decision-log row matching a SUSPECT number, ANY
 * decision — collected by `readJsonlAdmits`) is used only to report
 * `droppedInLog`; it no longer gates the guard. FAIL-FAST only if a SUSPECT
 * admit somehow survives exclusion (number-key matching is broken) — see
 * tasks/checkpoint1-screening.md.
 *
 * @param {Record<string, unknown>[]} admits  decision-log admit rows
 * @param {{ selSongNo: string, decision: string }[]} [checkpoint1Decisions]
 * @returns {{ kept: Record<string, unknown>[], excluded: Record<string, unknown>[], droppedInLog: number }}
 */
export function excludeCheckpoint1Admits(admits, checkpoint1Decisions) {
  const targets = new Set(CHECKPOINT1_EXCLUDED_SEL_SONG_NOS);
  const kept = [];
  const excluded = [];
  for (const entry of admits) {
    if (targets.has(admitNumberKey(entry))) excluded.push(entry);
    else kept.push(entry);
  }
  // The loop above removes every admit on a SUSPECT number by construction, so
  // `kept` must contain none of them. If one survived, number-key matching is
  // broken — abort rather than let an owner-removed Korean-language song
  // (re-)enter the corpus (see tasks/checkpoint1-screening.md).
  const survived = kept.filter((entry) => targets.has(admitNumberKey(entry)));
  if (survived.length > 0) {
    throw new Error(
      `[build-joysound-candidate] CHECKPOINT-1 guard: ${survived.length} SUSPECT admit(s) survived exclusion (selSongNos [${CHECKPOINT1_EXCLUDED_SEL_SONG_NOS.join(', ')}]) — number-key matching is broken; see tasks/checkpoint1-screening.md.`,
    );
  }
  const droppedInLog = (checkpoint1Decisions ?? []).filter((d) => d.decision !== 'admit').length;
  return { kept, excluded, droppedInLog };
}

// Dash / hyphen / prolonged-sound-mark codepoints that render the SAME song
// title differently across sources but must fold for same-song matching:
//   U+002D ASCII '-', U+2010–2015 (hyphen..horizontal bar), U+2212 minus,
//   U+FF0D fullwidth hyphen-minus, U+30FC katakana-hiragana prolonged mark,
//   U+FF70 halfwidth katakana prolonged mark.
// NFKC does NOT fold these into one another (e.g. U+FF0D vs U+30FC stay
// distinct), so the strict comparator saw `スパイダ－` ≠ `スパイダー`.
const DASH_LIKE_RE = /[-‐-―−－ーｰ]/gu;
// Decorative title/credit marks that JOYSOUND/manual sources sometimes swap
// while referring to the same catalog number (`♡人生♡` vs `・人生・`,
// `ブラック★ロックシューター` vs `ブラックロックシューター`). Strip only
// a small, observed ornament set for conflict-nulling; do not use this in strict
// audit/delta comparisons. Middle dot is only stripped at title/credit edges;
// internal `・` often separates meaningful title/artist parts.
const DECORATIVE_MARK_RE = /[♡♥❤★☆♪※◇◆●○◎▽▼△▲□■]/gu;
const EDGE_MIDDLE_DOT_RE = /^[・･]+|[・･]+$/gu;
// Parenthetical / subtitle / media-context trailing segments to strip before
// loose comparison: `(...)`, `（...）`, `~...~`, `～...～`. Applied repeatedly so
// nested/multiple segments all peel off.
const PAREN_SEGMENT_RE = /\s*[([（].*?[)\]）]\s*$|\s*[~～][^~～]*[~～]\s*$/u;

/**
 * Loose, conflict-nulling-only title/artist normalization. Builds on
 * `normalizeForConflictMatch` (NFKC + lowercase + space-collapse) and ADDITIONALLY
 * folds the variant classes NFKC leaves distinct:
 *   - strips trailing parenthetical / subtitle / media-context segments,
 *   - removes all dash/prolonged-mark codepoints AND whitespace (so `スパイダ－`
 *     ≡ `スパイダー`, and `X-JAPAN` ≡ `X JAPAN`).
 * NOT used for the audit comparator (which must stay strict) — only to decide
 * whether an overlapping JOYSOUND number is CONFIDENTLY a different song.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeForLooseMatch(value) {
  let s = normalizeForConflictMatch(value);
  // Peel trailing paren/subtitle segments until none remain.
  let prev;
  do {
    prev = s;
    s = s.replace(PAREN_SEGMENT_RE, '').trim();
  } while (s !== prev && s.length > 0);
  // Remove dash-like marks, decorative source-rendering marks, edge middle dots,
  // AND whitespace so dash/space/ornament/none all fold without erasing
  // meaningful internal middle-dot separators.
  s = s
    .replace(DASH_LIKE_RE, '')
    .replace(DECORATIVE_MARK_RE, '')
    .replace(EDGE_MIDDLE_DOT_RE, '')
    .replace(/\s+/gu, '');
  return s;
}

/**
 * Character-bigram Jaccard similarity of two strings (0..1). Used as the LONG-
 * string similarity signal (it degrades on very short strings, where a single
 * char swap drops the score below any safe threshold — handled by Levenshtein
 * below instead).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function bigramJaccard(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const grams = (s) => {
    const set = new Set();
    if (s.length === 1) {
      set.add(s);
      return set;
    }
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Character-level Levenshtein edit distance. The right signal for 旧字↔新字
 * single-character kanji substitutions (`眞`↔`真`, `戀`↔`恋`, `氣`↔`気`) which
 * bigram Jaccard scores too low on short titles to fold safely.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

const LOOSE_SIMILARITY_THRESHOLD = 0.7;
// Fraction of the longer string's length tolerated as edit distance when
// deciding same-song. `max(1, floor(maxLen * 0.34))` lets a single char swap
// fold on any length and ~1/3 of a longer string change, while a 7-char title
// vs a 7-char different title (distance 7) stays distinct.
const LOOSE_EDIT_FRACTION = 0.34;

/**
 * One-sided loose-equality of two already-loose-normalized strings, in priority
 * order: exact, OR substring/prefix containment, OR small Levenshtein edit
 * distance (folds 旧字/新字 char swaps), OR bigram-Jaccard ≥ threshold (folds
 * longer near-identical strings). The conflict-nulling philosophy is "do NOT
 * null unless CONFIDENTLY different", so this is intentionally generous — a
 * false-benign costs at most one Tier-A union of two truly-different songs
 * sharing a number, whereas a false-conflict strips a correct number AND
 * creates a duplicate (the P0 this guards).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function looseFieldEqual(a, b) {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const maxLen = Math.max(a.length, b.length);
  const allowedEdits = Math.max(1, Math.floor(maxLen * LOOSE_EDIT_FRACTION));
  if (levenshtein(a, b) <= allowedEdits) return true;
  return bigramJaccard(a, b) >= LOOSE_SIMILARITY_THRESHOLD;
}

function hasInternalMiddleDot(value) {
  const s = normalizeForConflictMatch(value).replace(EDGE_MIDDLE_DOT_RE, '');
  return /[・･]/u.test(s);
}

function internalMiddleDotMismatch(a, b) {
  return hasInternalMiddleDot(a) !== hasInternalMiddleDot(b);
}

/**
 * Conservative same-song test for conflict nulling. Returns true when the two
 * (title, artist) pairs are PLAUSIBLY the same song under loose matching, so the
 * overlapping JOYSOUND number must be left benign for Tier-A union. Requires
 * BOTH title AND artist to loosely match — protects against folding different
 * artists that happen to share a title.
 *
 * @param {unknown} aTitle
 * @param {unknown} aArtist
 * @param {unknown} bTitle
 * @param {unknown} bArtist
 * @returns {boolean}
 */
export function looseSameSong(aTitle, aArtist, bTitle, bArtist) {
  if (internalMiddleDotMismatch(aTitle, bTitle)) return false;
  if (internalMiddleDotMismatch(aArtist, bArtist)) return false;
  const titleOk = looseFieldEqual(normalizeForLooseMatch(aTitle), normalizeForLooseMatch(bTitle));
  if (!titleOk) return false;
  return looseFieldEqual(normalizeForLooseMatch(aArtist), normalizeForLooseMatch(bArtist));
}

function decisionLooseMatchesRecord(entry, record) {
  return looseSameSong(entry?.title, entry?.artist, record?.title_primary, record?.artist_primary);
}

/**
 * Resolve `existingNumberConflict`s CONSERVATIVELY: when an admitted JOYSOUND
 * number already exists in the current corpus, null the existing record's
 * joysound number ONLY IF NO admit on that number is plausibly the same song
 * under LOOSE matching (`looseSameSong`). The sole purpose of nulling is to stop
 * Tier-A union-find from merging two genuinely DIFFERENT songs that happen to
 * share a joysound number. For same-song VARIANT renderings (旧字/新字 kanji,
 * prolonged-mark/dash codepoints, subtitle/media-context parens, artist-paren
 * rendering) — which strict NFKC does NOT fold — Tier-A union is CORRECT (no
 * duplicate, no number loss), so those are left benign.
 *
 * "Same song" is decided per-number across ALL admits carrying that number: if
 * ANY admit on the number loosely matches the existing record's title/artist,
 * the overlap is benign and the number is preserved.
 *
 * @param {import('@karaoke/schema').SongRecord[]} currentRecords
 * @param {Record<string, unknown>[]} admits  decision-log admit rows
 * @returns {{ records: import('@karaoke/schema').SongRecord[], conflictsResolved: number, benignOverlaps: number }}
 */
export function resolveExistingNumberConflicts(currentRecords, admits) {
  // number -> list of admit rows carrying that (normalized) number.
  const admitsByNumber = new Map();
  for (const entry of admits) {
    const key = admitNumberKey(entry);
    if (key === '') continue;
    const list = admitsByNumber.get(key) ?? [];
    list.push(entry);
    admitsByNumber.set(key, list);
  }

  let conflictsResolved = 0;
  let benignOverlaps = 0;

  const records = currentRecords.map((record) => {
    const existingNumber = record?.karaoke_numbers?.joysound;
    if (typeof existingNumber !== 'string' || existingNumber.length === 0) return record;
    const key = normalizeJoysoundNumber(existingNumber);
    const matchingAdmits = admitsByNumber.get(key);
    if (!matchingAdmits || matchingAdmits.length === 0) return record;

    const benign = matchingAdmits.some((entry) => decisionLooseMatchesRecord(entry, record));
    if (benign) {
      benignOverlaps += 1;
      return record;
    }

    // CONFIDENTLY a different song (no admit loosely matches) → the existing
    // joysound number was misattributed → null it so Tier-A does not union two
    // distinct songs.
    conflictsResolved += 1;
    return {
      ...record,
      karaoke_numbers: { ...record.karaoke_numbers, joysound: null },
    };
  });

  return { records, conflictsResolved, benignOverlaps };
}

function recordJoysound(record) {
  const value = record?.karaoke_numbers?.joysound;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Audit same-song duplicate pairs that Tier-A left UNUNIONED: for each
 * `joysound-*` record in the candidate, find a SEPARATE (different-id)
 * non-joysound record that is `looseSameSong` and does NOT share its joysound
 * number. Blocked by loose-normalized title to stay O(n·bucket).
 *
 * Each such pair is classified BY CAUSE:
 *   - `regression`  — the twin is a record whose joysound number THIS sweep's
 *      conflict-resolution NULLED (`nulledIds`). This is the P0 signal — a
 *      same-song variant we wrongly split. Target ~0.
 *   - `preexistingDifferentNumber` — the twin still carries a DIFFERENT joysound
 *      number (same song, two distinct JOYSOUND catalog entries, no shared
 *      number for Tier-A; Tier-B/C blocked by title variance). Independent of
 *      this sweep.
 *   - `preexistingMergerGap` — the twin has NO joysound number at all (e.g. a
 *      TJ-only record whose title carries a media-context paren the merger's
 *      strict `normalize()` does not strip). A pre-existing merger Tier-B/C
 *      limitation, surfaced (not caused) by this sweep.
 *
 * @param {import('@karaoke/schema').SongRecord[]} candidateRecords
 * @param {Set<string>} nulledIds  ids whose joysound was nulled by conflict-res
 * @returns {{ total: number, regression: number, preexistingDifferentNumber: number, preexistingMergerGap: number, regressionSamples: object[], preexistingSamples: object[] }}
 */
function auditSameSongDuplicatePairs(candidateRecords, nulledIds) {
  // Block by loose-normalized title. Each bucket holds every record sharing
  // that title key; within a bucket we compare artists loosely.
  const byTitleKey = new Map();
  for (const record of candidateRecords) {
    const key = normalizeForLooseMatch(record?.title_primary);
    if (key === '') continue;
    const bucket = byTitleKey.get(key) ?? [];
    bucket.push(record);
    byTitleKey.set(key, bucket);
  }

  let total = 0;
  let regression = 0;
  let preexistingDifferentNumber = 0;
  let preexistingMergerGap = 0;
  const regressionSamples = [];
  const preexistingSamples = [];
  const counted = new Set();
  for (const record of candidateRecords) {
    if (!record?.id?.startsWith('joysound-')) continue;
    const jsNum = recordJoysound(record);
    const key = normalizeForLooseMatch(record.title_primary);
    const bucket = byTitleKey.get(key);
    if (!bucket) continue;
    const artistKey = normalizeForLooseMatch(record.artist_primary);
    for (const other of bucket) {
      if (other.id === record.id) continue;
      if (other.id.startsWith('joysound-')) continue; // twin must be a non-joysound (existing) record
      if (!looseFieldEqual(artistKey, normalizeForLooseMatch(other.artist_primary))) continue;
      // Same song, separate records. If they share the SAME joysound number,
      // Tier-A would have unioned them (so they wouldn't BE separate).
      const otherJs = recordJoysound(other);
      if (jsNum !== null && otherJs !== null && jsNum === otherJs) continue;
      const pairKey = [record.id, other.id].sort().join('|');
      if (counted.has(pairKey)) continue;
      counted.add(pairKey);
      total += 1;
      const sample = {
        joysound_id: record.id,
        joysound_title: record.title_primary,
        joysound_artist: record.artist_primary,
        joysound_number: jsNum,
        twin_id: other.id,
        twin_title: other.title_primary,
        twin_artist: other.artist_primary,
        twin_number: otherJs,
      };
      if (nulledIds.has(other.id)) {
        regression += 1;
        if (regressionSamples.length < 20) regressionSamples.push(sample);
      } else if (otherJs !== null) {
        preexistingDifferentNumber += 1;
        if (preexistingSamples.length < 10) preexistingSamples.push(sample);
      } else {
        preexistingMergerGap += 1;
        if (preexistingSamples.length < 10) preexistingSamples.push(sample);
      }
    }
  }
  return {
    total,
    regression,
    preexistingDifferentNumber,
    preexistingMergerGap,
    regressionSamples,
    preexistingSamples,
  };
}

/**
 * Compute the set of existing-record ids whose `karaoke_numbers.joysound` was
 * present in the baseline but is null/absent in the candidate — i.e. nulled by
 * the conflict-resolution step (the only path that removes a joysound number
 * from an existing record). Used to scope the duplicate-pair regression metric.
 *
 * @param {import('@karaoke/schema').SongRecord[]} baselineRecords
 * @param {Map<string, import('@karaoke/schema').SongRecord>} candidateById
 * @returns {Set<string>}
 */
function conflictNulledIds(baselineRecords, candidateById) {
  const ids = new Set();
  for (const record of baselineRecords) {
    const after = candidateById.get(record.id);
    if (!after) continue;
    if (recordJoysound(record) !== null && recordJoysound(after) === null) ids.add(record.id);
  }
  return ids;
}

// --- Main build ----------------------------------------------------------

function readJsonlAdmits(path) {
  const raw = readFileSync(path, 'utf8');
  const checkpoint1Targets = new Set(CHECKPOINT1_EXCLUDED_SEL_SONG_NOS);
  const checkpoint1Decisions = [];
  const admits = [];
  let total = 0;
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    total += 1;
    const entry = JSON.parse(trimmed);
    // Track EVERY row (any decision) on a CHECKPOINT-1 SUSPECT number so the
    // exclusion guard can verify it is looking at the right log.
    const key = admitNumberKey(entry);
    if (checkpoint1Targets.has(key)) {
      checkpoint1Decisions.push({ selSongNo: key, decision: String(entry?.decision ?? '') });
    }
    if (entry?.decision === 'admit') admits.push(entry);
  }
  return { admits, total, checkpoint1Decisions };
}

async function main() {
  for (const [label, p] of [
    ['normalizer dist', normalizerJsPath],
    ['merge dist', mergeJsPath],
    ['aliases dist', aliasesJsPath],
    ['schema dist', schemaJsPath],
    ['decision log', decisionLogPath],
    ['current corpus', songsPath],
  ]) {
    if (!existsSync(p)) {
      console.error(`[build-joysound-candidate] missing ${label}: ${p}`);
      process.exit(1);
    }
  }

  await loadNormalizer();
  const { mergeRecords } = await import(pathToFileURL(mergeJsPath).href);
  const { resolveArtistAliases } = await import(pathToFileURL(aliasesJsPath).href);
  const { validateSongRecord } = await import(pathToFileURL(schemaJsPath).href);
  if (
    typeof mergeRecords !== 'function' ||
    typeof resolveArtistAliases !== 'function' ||
    typeof validateSongRecord !== 'function'
  ) {
    console.error('[build-joysound-candidate] dist did not export the expected functions');
    process.exit(1);
  }

  // --- Load current corpus -------------------------------------------------
  const currentCorpus = JSON.parse(readFileSync(songsPath, 'utf8'));
  if (!Array.isArray(currentCorpus) || currentCorpus.length === 0) {
    console.error('[build-joysound-candidate] current corpus is not a non-empty array');
    process.exit(1);
  }
  console.log(`[build-joysound-candidate] current corpus: ${currentCorpus.length} records`);

  // Deep-clone snapshot of the ORIGINAL baseline, taken before any pipeline
  // stage touches `currentCorpus`. The conflict-resolution / alias / merge
  // stages must NOT mutate their inputs (they clone), but the delta report's
  // integrity is too important to depend on that invariant holding forever —
  // snapshot here so `compareCorpora` + the mutation classifier always compare
  // against the true on-disk baseline regardless of any downstream in-place
  // write. JSON round-trip is sufficient: records are plain JSON.
  const baselineSnapshot = JSON.parse(JSON.stringify(currentCorpus));

  // --- Step 1: normalize admits -> SongRecords -----------------------------
  const { admits: rawAdmits, total, checkpoint1Decisions } = readJsonlAdmits(decisionLogPath);
  console.log(
    `[build-joysound-candidate] decision log: ${total} rows, ${rawAdmits.length} admit rows`,
  );

  // CHECKPOINT-1: drop any admit on the 3 owner-removed SUSPECT numbers before
  // ANY downstream stage (record building AND conflict resolution). A current
  // sweep that no longer lists them is fine (nothing to exclude) — see
  // tasks/checkpoint1-screening.md.
  const {
    kept: admits,
    excluded: checkpoint1Excluded,
    droppedInLog: checkpoint1DroppedInLog,
  } = excludeCheckpoint1Admits(rawAdmits, checkpoint1Decisions);
  console.log(
    `[build-joysound-candidate] CHECKPOINT-1 exclusion (selSongNos ${CHECKPOINT1_EXCLUDED_SEL_SONG_NOS.join(', ')}): ` +
      `${checkpoint1Excluded.length} admit row(s) excluded, ${checkpoint1DroppedInLog} already dropped in-log; ` +
      `${admits.length} admit rows remain`,
  );

  const crawledAt = new Date().toISOString();
  const joysoundRecords = [];
  let skippedBuild = 0;
  const buildFailures = [];
  for (const entry of admits) {
    try {
      const record = buildJoysoundRecord(entry, crawledAt);
      // normalizeJoysoundRecord validates internally, but re-validate defensively
      // so a future shape drift surfaces here, not silently downstream.
      validateSongRecord(record);
      joysoundRecords.push(record);
    } catch (err) {
      skippedBuild += 1;
      if (buildFailures.length < 5) {
        buildFailures.push({
          naviGroupId: entry?.naviGroupId ?? null,
          selSongNo: entry?.selSongNo ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  console.log(
    `[build-joysound-candidate] built ${joysoundRecords.length} JOYSOUND records (skipped ${skippedBuild})`,
  );
  if (buildFailures.length > 0) {
    console.log('[build-joysound-candidate] first build failures:');
    for (const f of buildFailures) console.log(`  ${JSON.stringify(f)}`);
  }

  // --- Step 2: conflict resolution (null misattributed blog joysound #s) ----
  const {
    records: conflictResolvedCorpus,
    conflictsResolved,
    benignOverlaps,
  } = resolveExistingNumberConflicts(currentCorpus, admits);
  console.log(
    `[build-joysound-candidate] conflict resolution: ${conflictsResolved} blog number(s) nulled, ${benignOverlaps} benign overlap(s) preserved`,
  );

  // --- Step 3: alias resolve, then merge -----------------------------------
  const combined = [...conflictResolvedCorpus, ...joysoundRecords];
  const { records: resolved, warnings: aliasWarnings } = resolveArtistAliases(combined);
  console.log(`[build-joysound-candidate] alias resolution: ${aliasWarnings.length} warning(s)`);
  const { records: candidateRecords, conflicts } = mergeRecords(resolved);
  console.log(
    `[build-joysound-candidate] merged candidate: ${candidateRecords.length} records, ${conflicts.length} merge conflict(s)`,
  );

  // --- Same-song-duplicate-pair audit (P0 regression guard) ----------------
  // For each joysound-* record, find a SEPARATE same-song twin Tier-A left
  // ununioned, classified by CAUSE. The `regression` bucket — twins whose
  // joysound number THIS sweep nulled — is the P0 signal (target ~0). The
  // `preexisting*` buckets are merger-level Tier-B/C limitations (media-context
  // parens, distinct catalog numbers) independent of this sweep.
  const candidateByIdForDupes = new Map(candidateRecords.map((r) => [r.id, r]));
  const nulledIds = conflictNulledIds(baselineSnapshot, candidateByIdForDupes);
  const dupAudit = auditSameSongDuplicatePairs(candidateRecords, nulledIds);
  console.log(
    `[build-joysound-candidate] same-song duplicate pairs: total=${dupAudit.total} ` +
      `(REGRESSION=${dupAudit.regression} [P0, target ~0], ` +
      `preexisting-different-number=${dupAudit.preexistingDifferentNumber}, ` +
      `preexisting-merger-gap=${dupAudit.preexistingMergerGap})`,
  );
  if (dupAudit.regressionSamples.length > 0) {
    console.log('[build-joysound-candidate] REGRESSION duplicate samples (conflict-null caused):');
    for (const p of dupAudit.regressionSamples) console.log(`  ${JSON.stringify(p)}`);
  }

  // --- Step 5: schema-validate every candidate record ----------------------
  let invalid = 0;
  const invalidSamples = [];
  for (const record of candidateRecords) {
    try {
      validateSongRecord(record);
    } catch (err) {
      invalid += 1;
      if (invalidSamples.length < 5) {
        invalidSamples.push({
          id: record?.id ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  console.log(`[build-joysound-candidate] schema-invalid candidate records: ${invalid}`);
  if (invalidSamples.length > 0) {
    console.log('[build-joysound-candidate] first invalid records:');
    for (const s of invalidSamples) console.log(`  ${JSON.stringify(s)}`);
  }

  // --- Step 4: write candidate (NOT the real corpus) -----------------------
  writeJsonAtomic(candidateOutPath, candidateRecords, { indent: 2, trailingNewline: true });
  console.log(`[build-joysound-candidate] wrote candidate -> ${candidateOutPath}`);

  // --- Step 6: delta report (compareCorpora) -------------------------------
  // Compare against the ORIGINAL baseline snapshot (taken before any pipeline
  // stage) so every change to an existing record surfaces and is classified
  // below — immune to any in-place mutation of `currentCorpus`.
  const delta = compareCorpora(baselineSnapshot, candidateRecords);

  // Recompute the full mutated/removed id sets (compareCorpora only samples).
  const candidateById = new Map(candidateRecords.map((r) => [r.id, r]));
  const removedIds = baselineSnapshot.filter((r) => !candidateById.has(r.id)).map((r) => r.id);

  // Classify every mutated existing record into EXPECTED (a documented
  // merge/conflict-resolution side effect) vs UNEXPECTED (genuine corruption).
  // Expected classes are tallied by reason so the briefing can account for the
  // full mutation total; the UNEXPECTED bucket must be empty for a deploy-ready
  // candidate. See `classifyMutation` for the per-class rules.
  const expectedMutationCounts = {};
  const expectedMutationReasonsById = {};
  const unexpectedMutations = [];
  for (const record of baselineSnapshot) {
    const after = candidateById.get(record.id);
    if (!after) continue;
    if (stableStringify(record) === stableStringify(after)) continue;
    const { expected, reasons, badReasons } = classifyMutation(record, after);
    if (expected) {
      for (const reason of reasons)
        expectedMutationCounts[reason] = (expectedMutationCounts[reason] ?? 0) + 1;
      expectedMutationReasonsById[record.id] = reasons;
    } else {
      unexpectedMutations.push({
        id: record.id,
        badReasons,
        before: {
          karaoke_numbers: record.karaoke_numbers,
          title_primary: record.title_primary,
          artist_primary: record.artist_primary,
          title_ko: record.title_ko,
        },
        after: {
          karaoke_numbers: after.karaoke_numbers,
          title_primary: after.title_primary,
          artist_primary: after.artist_primary,
          title_ko: after.title_ko,
        },
      });
    }
  }
  const intentionalMutations = Object.keys(expectedMutationReasonsById);
  // Reason-combination distribution (one entry per mutated-expected record),
  // so the briefing can see e.g. how many records changed ONLY crawled_at vs
  // crawled_at + a number add. Sorted-by-frequency object.
  const expectedMutationReasonCombos = {};
  for (const reasons of Object.values(expectedMutationReasonsById)) {
    const key = [...reasons].sort().join('+') || '(none)';
    expectedMutationReasonCombos[key] = (expectedMutationReasonCombos[key] ?? 0) + 1;
  }
  // Conflict null-outs that survived into the candidate as a joysound loss
  // (i.e. no same-song JOYSOUND record re-supplied a number): the headline
  // figure the task asks to separate from any unexpected mutation.
  const conflictJoysoundNullsInCandidate = expectedMutationCounts['conflict-joysound-null'] ?? 0;

  const deltaReport = {
    generatedAt: new Date().toISOString(),
    candidateRecordCount: candidateRecords.length,
    joysoundRecordsBuilt: joysoundRecords.length,
    joysoundAdmitRowsSkipped: skippedBuild,
    conflictsResolved,
    benignOverlaps,
    sameSongDuplicatePairs: {
      total: dupAudit.total,
      regression: dupAudit.regression,
      preexistingDifferentNumber: dupAudit.preexistingDifferentNumber,
      preexistingMergerGap: dupAudit.preexistingMergerGap,
      regressionSamples: dupAudit.regressionSamples,
      preexistingSamples: dupAudit.preexistingSamples,
    },
    schemaInvalidCandidateRecords: invalid,
    duplicateCandidateIds: delta.summary.duplicateCandidateIds,
    duplicateBaselineIds: delta.summary.duplicateBaselineIds,
    removed: removedIds.length,
    removedIdsSample: removedIds.slice(0, 20),
    mutatedTotal: intentionalMutations.length + unexpectedMutations.length,
    expectedMutations: intentionalMutations.length,
    expectedMutationCounts,
    expectedMutationReasonCombos,
    conflictJoysoundNullsInCandidate,
    unexpectedMutations: unexpectedMutations.length,
    unexpectedMutationsSample: unexpectedMutations.slice(0, 20),
    compareCorpora: delta,
  };
  writeJsonAtomic(deltaOutPath, deltaReport, { indent: 2, trailingNewline: true });

  // --- Console summary -----------------------------------------------------
  console.log('');
  console.log('=== JOYSOUND candidate delta ===');
  console.log(`Candidate records      : ${candidateRecords.length}`);
  console.log(`Baseline (current)     : ${currentCorpus.length}`);
  console.log(`Added (new ids)        : ${delta.summary.added}`);
  console.log(`JOYSOUND records built : ${joysoundRecords.length} (skipped ${skippedBuild})`);
  console.log(`Conflicts resolved     : ${conflictsResolved} (blog joysound #s nulled)`);
  console.log(`Benign overlaps unioned: ${benignOverlaps}`);
  console.log(
    `Same-song dup pairs    : total=${dupAudit.total}  REGRESSION=${dupAudit.regression} (P0, target ~0) | preexisting-diff-num=${dupAudit.preexistingDifferentNumber} preexisting-merger-gap=${dupAudit.preexistingMergerGap}`,
  );
  console.log(`Schema-invalid records : ${invalid}  (must be 0)`);
  console.log(`Duplicate candidate ids: ${delta.summary.duplicateCandidateIds}  (must be 0)`);
  console.log(`Removed (existing lost): ${removedIds.length}  (must be 0)`);
  console.log(
    `Mutated total          : ${deltaReport.mutatedTotal}  (expected=${intentionalMutations.length}, unexpected=${unexpectedMutations.length}  [unexpected must be 0])`,
  );
  console.log('Expected-mutation breakdown:');
  for (const [reason, n] of Object.entries(expectedMutationCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${n}`);
  }
  console.log(
    `Conflict joysound nulls in candidate: ${conflictJoysoundNullsInCandidate}  (subset of expected; rest re-unioned same-song)`,
  );
  console.log(
    `Rich-field loss        : ${delta.summary.richFieldLoss}  (= conflict joysound nulls)`,
  );
  if (unexpectedMutations.length > 0) {
    console.log('');
    console.log('!! UNEXPECTED MUTATIONS (first 5):');
    for (const m of unexpectedMutations.slice(0, 5)) console.log(`  ${JSON.stringify(m)}`);
  }
  console.log('');
  console.log(`[build-joysound-candidate] delta report -> ${deltaOutPath}`);
}

/**
 * Order-independent deep serialization for equality checks. Mirrors
 * `stableStringify` in corpus-audit-guardrails.mjs: arrays preserve order,
 * object keys are sorted recursively. Used to decide whether an existing
 * record changed at all before classifying HOW it changed.
 *
 * NOTE: the previous implementation used `JSON.stringify(record,
 * Object.keys(record).sort())` — but the 2nd arg is a REPLACER ALLOWLIST, not a
 * key sorter, and it recurses into nested objects, so `karaoke_numbers` (whose
 * keys tj/ky/joysound are absent from the top-level allowlist) serialized as
 * `{}`. That made all karaoke_numbers changes invisible to the equality check.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Fields whose ANY change is genuine corruption — the JOYSOUND merge must never
// rewrite these on an existing record (it only unions numbers/aliases
// and refreshes crawled_at).
const IMMUTABLE_TEXT_FIELDS = [
  'id',
  'source_url',
  'title_primary',
  'title_ko',
  'artist_primary',
  'artist_ko',
  'media_context_ko',
  'title_ko_source',
  'title_ko_confidence',
];

/**
 * Classify a single existing-record mutation (before -> after) as EXPECTED (a
 * documented merge / conflict-resolution side effect) or UNEXPECTED (genuine
 * corruption). Returns `{ expected, reasons[], badReasons[] }`.
 *
 * EXPECTED merge side effects on this sweep:
 *   - `crawled_at-refresh`     — a same-song union adopted the incoming
 *      JOYSOUND record's (newer) crawled_at.
 *   - `karaoke-number-added`   — a provider cell went null -> value (Tier-A/B/C
 *      enrichment from the unioned JOYSOUND record).
 *   - `joysound-number-swap`   — joysound value -> a DIFFERENT value (the merger
 *      picked the JOYSOUND-source number on a same-song cluster; the prior blog
 *      number was a duplicate/mis-attribution for the same song).
 *   - `conflict-joysound-null` — joysound value -> null, the conflict-resolution
 *      step's intended null-out that no same-song JOYSOUND record re-supplied.
 *   - `artist-aliases-added`   — artist_aliases is a pure superset of before
 *      (alias-resolver propagation).
 *
 * UNEXPECTED (badReasons): any change to an immutable text field, a tj/ky cell
 * losing or swapping its value, a joysound cell being emptied for a non-conflict
 * reason (already covered by conflict-joysound-null otherwise), or
 * artist_aliases dropping entries.
 */
export function classifyMutation(before, after) {
  const reasons = [];
  const badReasons = [];

  for (const field of IMMUTABLE_TEXT_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      badReasons.push(`text-field-changed:${field}`);
    }
  }

  if (JSON.stringify(before.crawled_at) !== JSON.stringify(after.crawled_at)) {
    reasons.push('crawled_at-refresh');
  }

  const bKn = before.karaoke_numbers ?? {};
  const aKn = after.karaoke_numbers ?? {};
  // tj / ky: only an exact-equal value is acceptable; any change is corruption.
  for (const provider of ['tj', 'ky']) {
    if (JSON.stringify(bKn[provider]) !== JSON.stringify(aKn[provider])) {
      if (bKn[provider] == null && typeof aKn[provider] === 'string') {
        reasons.push('karaoke-number-added');
      } else {
        badReasons.push(`karaoke-number-corrupted:${provider}`);
      }
    }
  }
  // joysound: null->value (added), value->different (same-song swap), value->null
  // (conflict null-out) are all expected; value-changes are only here.
  if (JSON.stringify(bKn.joysound) !== JSON.stringify(aKn.joysound)) {
    if (bKn.joysound == null && typeof aKn.joysound === 'string') {
      reasons.push('karaoke-number-added');
    } else if (typeof bKn.joysound === 'string' && typeof aKn.joysound === 'string') {
      reasons.push('joysound-number-swap');
    } else if (typeof bKn.joysound === 'string' && aKn.joysound == null) {
      reasons.push('conflict-joysound-null');
    } else {
      badReasons.push('karaoke-number-corrupted:joysound');
    }
  }

  if (JSON.stringify(before.artist_aliases) !== JSON.stringify(after.artist_aliases)) {
    const bAliases = new Set(Array.isArray(before.artist_aliases) ? before.artist_aliases : []);
    const aAliases = new Set(Array.isArray(after.artist_aliases) ? after.artist_aliases : []);
    const lostAlias = [...bAliases].some((alias) => !aAliases.has(alias));
    if (lostAlias) {
      badReasons.push('artist-aliases-dropped');
    } else {
      reasons.push('artist-aliases-added');
    }
  }

  return { expected: badReasons.length === 0, reasons, badReasons };
}

function printUsage() {
  console.log(`build-joysound-candidate.mjs — build the JOYSOUND deploy-candidate corpus (writes
to .tmp_review/, NEVER to apps/web/public/data/songs.json; does NOT deploy).

Usage:
  node --max-old-space-size=8192 scripts/build-joysound-candidate.mjs

No flags besides -h/--help; all paths are hardcoded:
  decision log : .tmp_review/joysound-detail-sweep-20260610/decision-log.jsonl
  candidate out: .tmp_review/joysound-detail-sweep-20260610/songs-candidate.json
  delta out    : .tmp_review/joysound-detail-sweep-20260610/candidate-delta.json

CHECKPOINT-1: any admit row for selSongNos ${CHECKPOINT1_EXCLUDED_SEL_SONG_NOS.join(', ')} is
excluded (SUSPECTs removed from reviewedJoysoundOverrides.ts after the sweep
started — see tasks/checkpoint1-screening.md). The build fails fast unless the
log contains exactly one row per number (any decision).

Heap: parses the ~12 MB corpus + ~291k decision rows — run with
--max-old-space-size=8192 or the build can OOM.`);
}

// Only run main() when invoked directly (not when imported by the test).
if (isCliInvocation(import.meta.url)) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
