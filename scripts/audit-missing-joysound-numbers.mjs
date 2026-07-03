#!/usr/bin/env node
/**
 * READ-ONLY audit (Roadmap R1): diagnose the songs that carry a TJ and/or KY
 * karaoke number but NO JOYSOUND number. The owner's premise is that a song TJ
 * or KY licenses should almost always exist in JOYSOUND too, so a missing
 * JOYSOUND number is usually an unmerged duplicate cluster (a merge failure),
 * not a genuine catalog gap. This script produces a human-review CSV of
 * candidate merge pairs against the JOYSOUND-numbered corpus so a maintainer
 * can adjudicate the set in one pass and feed confirmed pairs into the existing
 * `reviewedMergePairs` allowlists.
 *
 * Why the matching uses the CANONICAL clustering primitives
 * --------------------------------------------------------
 * `normalizeForMatch` / `splitArtistCollab` are imported straight from the
 * built crawler dist (same pattern as `scripts/drop-artist-leaks.mjs` and
 * `scripts/splitter_parity_harness.mjs`). Reusing the exact code the merger and
 * crawl-time parser run means this audit's notion of "same title" / "same
 * artist" cannot silently drift from the pipeline it is auditing — a copy of
 * those functions here would defeat the purpose. A missing dist is a hard error
 * with a build hint, never an auto-rebuild.
 *
 * Tiering (per affected song, decided by its best candidate)
 * ---------------------------------------------------------
 *   A — a JOYSOUND-numbered song matches on title key AND shares an artist
 *       component. These "should have merged already" — flag for pipeline
 *       investigation (the matcher missed a pair it had enough signal for).
 *   B — title key matches but ZERO artist overlap. The main review set: artist
 *       renames (関ジャニ∞→SUPER EIGHT), vocaloid producer-vs-vocalist credit
 *       mismatches, or rendering variants that broke artist-key clustering.
 *   C — no title match at all in the JOYSOUND pool: a candidate GENUINE
 *       JOYSOUND catalog gap (e.g. a Korean song TJ licensed but JOYSOUND never
 *       carried). Expected residue — tag, do not force-merge.
 *
 * Title matching has two axes, because TJ decorates titles in ways that break
 * exact-key clustering: it appends tie-up suffixes (`Don't say "lazy"(けいおん!
 * ED)`) and injects odd spacing (`抱 擁`). So each side gets an exact key
 * (`normalizeForMatch(title_primary)`) and a decoration-stripped key
 * (`normalizeForMatch(stripDecorations(title_primary))`). An exact-key hit is a
 * stronger match than a stripped-key-only hit and ranks first.
 *
 * Output (nothing is committed — write to a gitignored dir or --out)
 * ------------------------------------------------------------------
 *   audit-missing-joysound.csv          one row per (song, candidate); songs
 *                                       with zero candidates emit one row with
 *                                       empty candidate columns. Excel-safe
 *                                       UTF-8 with BOM (via writeCsvWithBom).
 *   audit-missing-joysound-summary.json counts per tier / match_kind, plus the
 *                                       zero-candidate (tier C) count.
 *
 * Usage
 * -----
 *   node scripts/audit-missing-joysound-numbers.mjs <full-corpus.json> [--out <dir>]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCsvWithBom } from './lib/agent-chunks.mjs';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
// Default artifact dir: gitignored (see .gitignore) so a bare invocation never
// stages generated CSV/JSON. Callers point --out at an explicit path in CI.
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, 'scripts/data/audit-missing-joysound');

const CSV_NAME = 'audit-missing-joysound.csv';
const SUMMARY_NAME = 'audit-missing-joysound-summary.json';
const MAX_CANDIDATES_PER_SONG = 5;

export const CSV_HEADER = [
  'tier',
  'song_id',
  'title_primary',
  'artist_primary',
  'tj_number',
  'ky_number',
  'candidate_id',
  'candidate_joysound_number',
  'candidate_title',
  'candidate_artist',
  'match_kind',
  'artist_overlap_keys',
];

export const USAGE =
  'usage: node scripts/audit-missing-joysound-numbers.mjs <full-corpus.json> [--out <dir>]';

/** Parse CLI args. Throws on unknown flags, missing values, or missing corpus. */
export function parseArgs(argv) {
  const parsed = { corpusPath: null, outDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a directory value');
      parsed.outDir = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (parsed.corpusPath === null) {
      parsed.corpusPath = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  if (!parsed.help && parsed.corpusPath === null) {
    throw new Error('a corpus JSON path is required');
  }
  return parsed;
}

// A trailing parenthesized segment, half-width `(...)` or full-width `（...）`.
// Anchored at end (after optional trailing space) so only *trailing* tie-up
// decorations are peeled — a leading/mid-title paren is part of the title.
const TRAILING_PAREN_RE = /[（(][^（）()]*[）)]\s*$/;

// Curly quote folds. `normalizeForMatch` (NFKC) does NOT unify curly quotes
// with their ASCII forms, so a title punctuated with a typographic apostrophe
// keys differently from the same title with a straight one — the exact reason
// TJ's `Don’t say “lazy”` (U+2019/U+201C/U+201D) never keyed to JOYSOUND's
// `Don't say"lazy"` (ASCII). We fold only on the DECORATION axis so the exact
// axis stays byte-exact under the canonical normalizer.
const CURLY_SINGLE_RE = /[‘’‚‛]/g;
const CURLY_DOUBLE_RE = /[“”„‟]/g;

/**
 * Produce a decoration-stripped title for the SECOND (looser) match axis.
 *
 * Three transforms, each motivated by a real TJ catalog quirk that breaks
 * exact-title clustering:
 *   1. Collapse internal runs of whitespace to a single space (TJ emits
 *      `抱 擁` where JOYSOUND has `抱擁`). NOTE: `normalizeForMatch` already
 *      strips ALL whitespace when it derives the match key, so this collapse
 *      does not change the key — it is kept so the helper is meaningful and
 *      testable on its own (and so a future non-normalized consumer is safe).
 *   2. Fold curly single/double quotes to their ASCII forms (see the regex
 *      docblock). Unlike whitespace, this DOES change the derived key and is
 *      the fold that lets `Don’t say “lazy”(…)` reach JOYSOUND's ASCII-quoted
 *      entry once the suffix is peeled.
 *   3. Peel trailing parenthesized tie-up suffixes (`(けいおん! ED)`), both
 *      half- and full-width parens, repeatedly (`Title(A)(B)` → `Title`).
 *
 * Guard: a title that is ONLY a parenthetical must NOT strip to empty — if
 * peeling would empty the string we stop and keep the last non-empty form.
 * Otherwise `(instrumental)` would collapse to "" and false-match everything.
 */
export function stripDecorations(title) {
  let s = String(title ?? '')
    .replace(/\s+/g, ' ')
    .replace(CURLY_SINGLE_RE, "'")
    .replace(CURLY_DOUBLE_RE, '"')
    .trim();
  let prev;
  do {
    prev = s;
    const candidate = s.replace(TRAILING_PAREN_RE, '').trim();
    if (candidate === '') break; // only-parens title: keep prev, stop peeling
    s = candidate;
  } while (s !== prev);
  return s;
}

/** A karaoke_numbers value is "present" only when it is a non-empty string. */
function hasNumber(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Affected = carries a TJ and/or KY number but NO JOYSOUND number. These are
 * exactly the songs R1 is about (378 as measured 2026-07-04).
 */
export function isAffected(song) {
  const k = song?.karaoke_numbers ?? {};
  return (hasNumber(k.tj) || hasNumber(k.ky)) && !hasNumber(k.joysound);
}

/** A song belongs to the candidate pool iff it carries a JOYSOUND number. */
export function hasJoysound(song) {
  return hasNumber(song?.karaoke_numbers?.joysound);
}

/**
 * Set of normalized artist-component keys for a song, drawn from every artist
 * surface it exposes: `artist_primary`, each `artist_aliases` entry, and
 * `artist_ko` when present. Each surface is run through `splitArtistCollab`
 * (so `imase & なとり` contributes both components) then `normalizeForMatch`.
 * Empty keys are dropped. This is the SAME decomposition the merger uses to
 * decide "same artist", so overlap here means the pipeline had the signal too.
 */
export function artistKeySet(song, { normalizeForMatch, splitArtistCollab }) {
  const keys = new Set();
  const surfaces = [];
  if (typeof song?.artist_primary === 'string') surfaces.push(song.artist_primary);
  if (Array.isArray(song?.artist_aliases)) {
    for (const a of song.artist_aliases) if (typeof a === 'string') surfaces.push(a);
  }
  if (typeof song?.artist_ko === 'string') surfaces.push(song.artist_ko);
  for (const surface of surfaces) {
    for (const component of splitArtistCollab(surface)) {
      const key = normalizeForMatch(component);
      if (key !== '') keys.add(key);
    }
  }
  return keys;
}

/**
 * Build the JOYSOUND-numbered lookup: two title-key maps (exact + stripped)
 * whose entries are precomputed candidate descriptors (id, joysound number,
 * surface title/artist for the CSV, and the artist key set for overlap). Songs
 * whose exact title key is empty are skipped (nothing to match on).
 */
export function buildJoysoundIndex(pool, deps) {
  const { normalizeForMatch } = deps;
  const exact = new Map();
  const stripped = new Map();
  for (const song of pool) {
    const title = typeof song.title_primary === 'string' ? song.title_primary : '';
    const exactKey = normalizeForMatch(title);
    if (exactKey === '') continue;
    const strippedKey = normalizeForMatch(stripDecorations(title));
    const entry = {
      id: song.id == null ? '' : String(song.id),
      joysound: song.karaoke_numbers?.joysound ?? '',
      title,
      artist: typeof song.artist_primary === 'string' ? song.artist_primary : '',
      artistKeys: artistKeySet(song, deps),
    };
    pushToBucket(exact, exactKey, entry);
    // Index EVERY candidate under its stripped key too — decoration can sit on
    // either side, so an affected song's stripped key must be able to reach a
    // plainly-titled candidate (whose stripped key equals its exact key) as
    // well as a decoration-variant one. Exact hits reached via both maps dedupe
    // to exact-title in findCandidates, so this over-inclusion is harmless.
    if (strippedKey !== '') pushToBucket(stripped, strippedKey, entry);
  }
  return { exact, stripped };
}

function pushToBucket(map, key, entry) {
  const bucket = map.get(key);
  if (bucket) bucket.push(entry);
  else map.set(key, [entry]);
}

/**
 * Rank two candidates: exact-title before stripped-title, then more artist
 * overlap first, then candidate id ascending (stable, deterministic output).
 */
function compareCandidates(a, b) {
  if (a.match_kind !== b.match_kind) return a.match_kind === 'exact-title' ? -1 : 1;
  if (a.overlapCount !== b.overlapCount) return b.overlapCount - a.overlapCount;
  return a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;
}

/**
 * Find JOYSOUND candidates for one affected song. Returns
 * `{ tier, candidates }` where `candidates` is at most
 * MAX_CANDIDATES_PER_SONG rows and `tier` is decided on the FULL match set.
 * Exact-key hits win over stripped-key-only hits; a candidate reachable both
 * ways is kept once as exact-title. Self-id is skipped defensively.
 *
 * Two things MUST use the full (unsliced) ranking, not the emitted slice:
 *
 *  1. Tier. `compareCandidates` ranks every exact-title candidate above any
 *     stripped-title one (artist overlap only tie-breaks WITHIN a match_kind),
 *     so a flood of zero-overlap exact-title covers can push the sole
 *     artist-overlap candidate past the top-5 cutoff. Tiering on the slice
 *     would then mislabel a genuine merge (tier A) as the review set (tier B).
 *
 *  2. Actionability of the CSV. For a tier-A song the overlap candidate IS the
 *     merge target a reviewer needs to see. We reserve a slot for it: if the
 *     best overlap candidate would be sliced off, it replaces the lowest-ranked
 *     emitted row (keeping the total ≤ MAX). An exact-title overlap candidate
 *     can never be sliced off (it ranks at the top of its group), so this only
 *     ever rescues the stripped-title-overlap case that motivated the fix.
 */
export function findCandidates(song, index, deps) {
  const { normalizeForMatch } = deps;
  const title = typeof song.title_primary === 'string' ? song.title_primary : '';
  const exactKey = normalizeForMatch(title);
  const strippedKey = normalizeForMatch(stripDecorations(title));
  const songId = song.id == null ? '' : String(song.id);
  const songArtistKeys = artistKeySet(song, deps);

  // id -> match_kind, exact-title taking precedence over stripped-title.
  const byId = new Map();
  const consider = (entry, matchKind) => {
    if (entry.id === songId) return;
    const existing = byId.get(entry.id);
    if (existing === undefined) {
      byId.set(entry.id, { entry, matchKind });
    } else if (existing.matchKind === 'stripped-title' && matchKind === 'exact-title') {
      existing.matchKind = 'exact-title';
    }
  };
  if (exactKey !== '') {
    for (const entry of index.exact.get(exactKey) ?? []) consider(entry, 'exact-title');
  }
  if (strippedKey !== '') {
    for (const entry of index.stripped.get(strippedKey) ?? []) consider(entry, 'stripped-title');
  }

  const candidates = [];
  for (const { entry, matchKind } of byId.values()) {
    const overlap = [...songArtistKeys].filter((k) => entry.artistKeys.has(k)).sort();
    candidates.push({
      candidate_id: entry.id,
      candidate_joysound_number: entry.joysound,
      candidate_title: entry.title,
      candidate_artist: entry.artist,
      match_kind: matchKind,
      artist_overlap_keys: overlap,
      overlapCount: overlap.length,
    });
  }
  candidates.sort(compareCandidates);

  // Tier from the FULL sorted set — never the slice (see the docblock).
  const tier = tierForSong(candidates);

  let emitted = candidates.slice(0, MAX_CANDIDATES_PER_SONG);
  // Reserve a slot for the best artist-overlap candidate so a tier-A song
  // always carries its actionable merge target into the CSV, even when
  // zero-overlap exact-title covers filled the slice. `bestOverlap` is a
  // reference into `candidates`, so `emitted.includes` is an identity check.
  const bestOverlap = candidates.find((c) => c.overlapCount > 0);
  if (bestOverlap && !emitted.includes(bestOverlap)) {
    emitted = [...emitted.slice(0, MAX_CANDIDATES_PER_SONG - 1), bestOverlap];
  }
  return { tier, candidates: emitted };
}

/**
 * Song tier from its (already ranked) candidates:
 *   C — no title match at all (candidate genuine catalog gap)
 *   A — some candidate shares an artist component (should have merged)
 *   B — title match(es) but zero artist overlap anywhere (the review set)
 */
export function tierForSong(candidates) {
  if (candidates.length === 0) return 'C';
  return candidates.some((c) => c.overlapCount > 0) ? 'A' : 'B';
}

/**
 * Build CSV rows (including the header) from audit results. One row per
 * candidate; a tier-C song emits a single row with empty candidate columns.
 * Values are stringified here; `writeCsvWithBom` handles field escaping.
 */
export function buildCsvRows(results) {
  const rows = [CSV_HEADER];
  for (const r of results) {
    const base = [r.tier, r.song_id, r.title_primary, r.artist_primary, r.tj_number, r.ky_number];
    if (r.candidates.length === 0) {
      rows.push([...base, '', '', '', '', '', '']);
      continue;
    }
    for (const c of r.candidates) {
      rows.push([
        ...base,
        c.candidate_id,
        c.candidate_joysound_number,
        c.candidate_title,
        c.candidate_artist,
        c.match_kind,
        c.artist_overlap_keys.join(' '),
      ]);
    }
  }
  return rows;
}

/**
 * Core audit over an in-memory corpus. Pure aside from the injected `deps`
 * (the clustering primitives). Returns `{ results, summary }` — results in
 * corpus order (stable), summary with per-tier / per-match_kind counts.
 */
export function auditCorpus(corpus, deps) {
  const affected = corpus.filter(isAffected);
  const pool = corpus.filter(hasJoysound);
  const index = buildJoysoundIndex(pool, deps);

  const results = [];
  for (const song of affected) {
    const { tier, candidates } = findCandidates(song, index, deps);
    const k = song.karaoke_numbers ?? {};
    results.push({
      tier,
      song_id: song.id == null ? '' : String(song.id),
      title_primary: typeof song.title_primary === 'string' ? song.title_primary : '',
      artist_primary: typeof song.artist_primary === 'string' ? song.artist_primary : '',
      tj_number: hasNumber(k.tj) ? k.tj : '',
      ky_number: hasNumber(k.ky) ? k.ky : '',
      candidates,
    });
  }

  const summary = summarize(results, { affected: affected.length, pool: pool.length });
  return { results, summary };
}

function summarize(results, { affected, pool }) {
  const byTier = { A: 0, B: 0, C: 0 };
  const byMatchKind = { 'exact-title': 0, 'stripped-title': 0 };
  let candidateRows = 0;
  let songsWithZeroCandidates = 0;
  for (const r of results) {
    byTier[r.tier] += 1;
    if (r.candidates.length === 0) songsWithZeroCandidates += 1;
    for (const c of r.candidates) {
      candidateRows += 1;
      byMatchKind[c.match_kind] += 1;
    }
  }
  return {
    affectedSongs: affected,
    joysoundPoolSize: pool,
    byTier,
    byMatchKind,
    candidateRows,
    songsWithZeroCandidates,
  };
}

/**
 * Load the canonical clustering primitives from the built crawler dist. Hard
 * error (with the build hint) when the dist is missing — never auto-rebuild.
 */
export async function loadClusteringDeps() {
  if (!existsSync(CLUSTERING_DIST)) {
    throw new Error(
      `missing crawler dist at ${CLUSTERING_DIST}\n  Run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
  }
  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );
  return { normalizeForMatch, splitArtistCollab };
}

/**
 * Orchestrate: load corpus, run the audit, write the CSV + summary JSON.
 * `deps` is a test seam (defaults to the real clustering dist import).
 * Returns 0 on success, 2 on a missing prerequisite (corpus or dist).
 */
export async function runAudit({ corpusPath, outDir, deps = null, log = console }) {
  const resolvedCorpus = resolve(corpusPath);
  if (!existsSync(resolvedCorpus)) {
    log.error(`ERROR: missing corpus at ${resolvedCorpus}`);
    return 2;
  }
  let clusteringDeps = deps;
  if (clusteringDeps === null) {
    try {
      clusteringDeps = await loadClusteringDeps();
    } catch (err) {
      log.error(`ERROR: ${err.message}`);
      return 2;
    }
  }

  const resolvedOut = resolve(outDir ?? DEFAULT_OUT_DIR);
  mkdirSync(resolvedOut, { recursive: true });

  const corpus = loadCorpus(resolvedCorpus);
  const { results, summary } = auditCorpus(corpus, clusteringDeps);

  const csvPath = resolve(resolvedOut, CSV_NAME);
  const summaryPath = resolve(resolvedOut, SUMMARY_NAME);
  writeCsvWithBom(csvPath, buildCsvRows(results));
  writeJsonAtomic(summaryPath, summary);

  log.log(`affected songs: ${summary.affectedSongs} (JOYSOUND pool: ${summary.joysoundPoolSize})`);
  log.log(`tiers  A=${summary.byTier.A}  B=${summary.byTier.B}  C=${summary.byTier.C}`);
  log.log(
    `match_kind  exact-title=${summary.byMatchKind['exact-title']}  stripped-title=${summary.byMatchKind['stripped-title']}`,
  );
  log.log(
    `candidate rows: ${summary.candidateRows}  zero-candidate songs: ${summary.songsWithZeroCandidates}`,
  );
  log.log(`wrote ${csvPath}`);
  log.log(`wrote ${summaryPath}`);
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  process.exitCode = await runAudit({ corpusPath: args.corpusPath, outDir: args.outDir });
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(`audit-missing-joysound-numbers failed: ${err.message}`);
    process.exitCode = 1;
  });
}
