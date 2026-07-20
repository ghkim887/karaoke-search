#!/usr/bin/env node
/**
 * B-wave reviewed-merge-pair encoder (audit follow-up B).
 *
 * Converts the manual merge review verdicts (scripts/data/b-review-merge-verdicts/
 * verdicts-*.json + batch-*.json) into `reviewedMergePairs.ts` Tier E / Tier F
 * entries, deterministically and reproducibly. It DOES NOT edit the .ts file; it
 * emits the entry lines + expected new counts (--out) so the change stays a
 * reviewable diff, and a machine-readable plan (--plan-out).
 *
 * Tier mechanism (mirrors merge.ts, which is the source of truth):
 *   - Tier E `[tj, joysound]`: unions the record carrying `tj` (its tj
 *     vendor-number cell) with the joysound record. Since #165 the reviewed
 *     tiers look both sides up via a FULL vendor index (any cluster state, any
 *     id-slug) and union their clusters, gated only by the vendor-number
 *     conflict guard — the old tj-slug/singleton requirement is gone. So a
 *     Tier E `[tj, joysound]` entry fires for a both-vendor (tj+ky) affected
 *     row regardless of that row's id-slug (ky-, tjpdf-, blog-), and Tier E is
 *     the table used to encode every both-vendor target (its tj number is the
 *     stable, unique key).
 *   - Tier F `[vendor, number, joysound]`: unions a SINGLE-vendor (exactly one
 *     of tj/ky, joysound null) target with a joysound row. Used for tj-only,
 *     ky-only, tjpdf and blog single-vendor targets.
 *
 * Guard chain — a verdict is left UNENCODABLE (reported, never forced) when:
 *   - `forbidden`: the pair is present in a reviewedMergePairs.ts FORBIDDEN set
 *     (a prior review explicitly held it back — e.g. ハッピー☆マテリアル
 *     multi-variant, "artist 19" manual holds, reviewed-but-not-strong). Never
 *     auto-reversed here.
 *   - `already-encoded` / `*-conflict-existing`: the joysound target or the
 *     tj/vendor:number target is already present in the committed tables.
 *   - `3way-dupJ`: two affected rows (one tj, one ky) map to one joysound. The
 *     unique-joysound invariant permits only one entry per J, so the tj-side is
 *     encoded and the ky-side is reported (this is the rejected attach-tier's
 *     class — a second single-vendor target on an already-consumed joysound).
 *
 * Input verdict `verdict` field is case-insensitive (`merge`/`MERGE`).
 *
 * BUILD PREREQUISITE: none (parses reviewedMergePairs.ts as text; no dist).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DEFAULT_REVIEWS = resolve(REPO_ROOT, 'scripts/data/b-review-merge-verdicts');
const DEFAULT_SOURCE = resolve(REPO_ROOT, 'packages/crawler/src/reviewedMergePairs.ts');

export const USAGE =
  'usage: node scripts/encode-b-wave-merge-pairs.mjs [--reviews <dir>] [--source <reviewedMergePairs.ts>] [--out <entries.txt>] [--plan-out <plan.json>]';

export function parseArgs(argv) {
  const args = {
    reviews: DEFAULT_REVIEWS,
    source: DEFAULT_SOURCE,
    out: null,
    planOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reviews') args.reviews = resolve(argv[++i]);
    else if (a === '--source') args.source = resolve(argv[++i]);
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--plan-out') args.planOut = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown arg: ${a}\n${USAGE}`);
  }
  return args;
}

const norm = (v) => (v == null || v === '' ? null : String(v));

/**
 * Parse the current reviewedMergePairs.ts as TEXT so the guard sets never drift
 * from the committed tables. Returns the existing Tier E/F targets, the set of
 * every joysound number already used, and both FORBIDDEN sets.
 */
export function parseReviewedSource(sourceText) {
  // Anchor every block on its `const <NAME>` declaration, not the bare name.
  // A prose comment elsewhere may legitimately mention a set name (e.g. a
  // forbidden-release note in the strong-pair table above the declaration);
  // matching the bare name would silently slice the wrong block. The `const `
  // prefix is unique to the declaration.
  const block = (startMarker) => {
    const start = sourceText.indexOf(startMarker);
    if (start < 0) throw new Error(`marker not found: ${startMarker}`);
    const open = sourceText.indexOf('[', start);
    const close = sourceText.indexOf('] as const', open);
    return sourceText.slice(open, close);
  };
  const setBlock = (startMarker) => {
    const start = sourceText.indexOf(startMarker);
    if (start < 0) throw new Error(`marker not found: ${startMarker}`);
    const open = sourceText.indexOf('[', start);
    const close = sourceText.indexOf(']', open);
    return sourceText.slice(open, close);
  };

  // Tier E strong pairs: ['NUM', 'NUM'],
  const eBlock = block('const REVIEWED_TIER_E_STRONG_PAIRS');
  const tierE = new Map(); // tj -> Set<joysound>
  const existingJ = new Set();
  for (const m of eBlock.matchAll(/\[\s*'(\d+)'\s*,\s*'(\d+)'\s*\]/g)) {
    const [, tj, j] = m;
    if (!tierE.has(tj)) tierE.set(tj, new Set());
    tierE.get(tj).add(j);
    existingJ.add(j);
  }

  // Tier F strong pairs: ['tj'|'ky', 'NUM', 'NUM'],
  const fBlock = block('const REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS');
  const tierF = new Map(); // "vendor:number" -> Set<joysound>
  for (const m of fBlock.matchAll(/\[\s*'(tj|ky)'\s*,\s*'(\d+)'\s*,\s*'(\d+)'\s*\]/g)) {
    const [, v, n, j] = m;
    const key = `${v}:${n}`;
    if (!tierF.has(key)) tierF.set(key, new Set());
    tierF.get(key).add(j);
    existingJ.add(j);
  }

  // Forbidden sets.
  const forbiddenE = new Set(); // "tj|joysound"
  const forbiddenEBlock = setBlock('const REVIEWED_TIER_E_FORBIDDEN_PAIRS');
  for (const m of forbiddenEBlock.matchAll(/'(\d+)\|(\d+)'/g)) {
    forbiddenE.add(`${m[1]}|${m[2]}`);
  }
  const forbiddenF = new Set(); // "vendor|number|joysound"
  const forbiddenFBlock = block('const REVIEWED_TIER_F_FORBIDDEN_PAIRS');
  for (const m of forbiddenFBlock.matchAll(/\[\s*'(tj|ky)'\s*,\s*'(\d+)'\s*,\s*'(\d+)'\s*\]/g)) {
    forbiddenF.add(`${m[1]}|${m[2]}|${m[3]}`);
  }

  return { tierE, tierF, existingJ, forbiddenE, forbiddenF };
}

/**
 * Load merge verdicts joined with their batch vendor numbers.
 *
 * Files are read in sorted name order so "later file wins" is deterministic for
 * both the batch song index and the verdict dedup. Each song_id resolves to
 * exactly ONE authoritative verdict: if the same song_id is decided in more than
 * one verdict file, the last-sorted file's verdict supersedes the earlier one
 * (e.g. a supplemental `verdicts-D-*.json` `merge` overrides an original B-wave
 * `uncertain` for that song). Every such override is recorded in the returned
 * `overrides` array (and logged by main) so the precedence is explicit and
 * auditable rather than a silent last-writer-wins over an unsorted readdir.
 */
export function loadReviews(dir) {
  const files = readdirSync(dir).sort();
  const songs = new Map(); // song_id -> {tj, ky, title, artist, candidates}
  for (const f of files.filter((f) => /^batch-.*\.json$/.test(f))) {
    for (const b of JSON.parse(readFileSync(resolve(dir, f), 'utf8'))) {
      // Later-sorted batch file wins (a supplemental batch-D-* redefinition
      // overrides the original batch entry for the same song_id).
      songs.set(b.song.id, {
        tj: norm(b.song.tj),
        ky: norm(b.song.ky),
        title: b.song.title,
        artist: b.song.artist,
        candidates: b.candidates ?? [],
      });
    }
  }

  // Collapse to one verdict per song_id (later file wins), tracking overrides.
  const verdictBySong = new Map(); // song_id -> { v, file }
  const overrides = [];
  for (const f of files.filter((f) => /^verdicts-.*\.json$/.test(f))) {
    for (const v of JSON.parse(readFileSync(resolve(dir, f), 'utf8'))) {
      const prev = verdictBySong.get(v.song_id);
      if (prev) {
        overrides.push({
          song_id: v.song_id,
          from: { verdict: String(prev.v.verdict).toLowerCase(), file: prev.file },
          to: { verdict: String(v.verdict).toLowerCase(), file: f },
        });
      }
      verdictBySong.set(v.song_id, { v, file: f });
    }
  }

  const merges = [];
  const uncertain = [];
  const counts = { merge: 0, reject: 0, uncertain: 0 };
  for (const { v } of verdictBySong.values()) {
    const verdict = String(v.verdict).toLowerCase();
    counts[verdict] = (counts[verdict] ?? 0) + 1;
    const sv = songs.get(v.song_id);
    const cand = sv?.candidates?.find((c) => c.id === v.candidate_id);
    const row = {
      song_id: v.song_id,
      title: sv?.title ?? v.title ?? '',
      artist: sv?.artist ?? '',
      tj: sv?.tj ?? null,
      ky: sv?.ky ?? null,
      J: norm(v.candidate_joysound),
      candTitle: cand?.title ?? '',
      candArtist: cand?.artist ?? '',
      reason: v.reason ?? '',
    };
    if (verdict === 'merge') merges.push(row);
    else if (verdict === 'uncertain') uncertain.push(row);
  }
  return { merges, uncertain, counts, songCount: songs.size, overrides };
}

/**
 * Deterministic sort so dup-joysound resolution prefers the tj side. A
 * both-vendor (tj+ky) row now encodes as Tier E via its tj number (see
 * buildPlan), so it counts as a tj-side encoder here regardless of id-slug.
 */
function encodeVendor(row) {
  const hasTj = row.tj != null;
  const hasKy = row.ky != null;
  if (hasTj) return 'tj';
  if (hasKy) return 'ky';
  return null;
}

export function buildPlan(reviews, existing) {
  const tierE = [];
  const tierF = [];
  const unencodable = {
    forbidden: [],
    'already-encoded': [],
    '3way-existing-reviewed': [],
    'both-vendor-number': [],
    'target-conflict-existing': [],
    '3way-dupJ': [],
    'dup-target-inbatch': [],
    'no-vendor-number': [],
  };
  // Reverse index of every joysound already used → its existing owner label.
  const jOwner = new Map();
  for (const [tj, set] of existing.tierE) for (const j of set) jOwner.set(j, `tierE tj-${tj}`);
  for (const [key, set] of existing.tierF) for (const j of set) jOwner.set(j, `tierF ${key}`);
  const claimedJ = new Map(); // joysound -> song_id (first winner)
  const claimedTarget = new Set(); // "E:tj" / "F:vendor:number"

  // Sort: group by J, tj-side first, then stable by song_id — so a 3-way's tj
  // row wins the joysound and the ky row is the reported loser.
  const sorted = [...reviews].sort((a, b) => {
    if (a.J !== b.J) return (a.J ?? '').localeCompare(b.J ?? '');
    const av = encodeVendor(a) === 'tj' ? 0 : 1;
    const bv = encodeVendor(b) === 'tj' ? 0 : 1;
    if (av !== bv) return av - bv;
    return a.song_id.localeCompare(b.song_id);
  });

  for (const row of sorted) {
    const push = (bucket, extra) =>
      unencodable[bucket].push({ song_id: row.song_id, title: row.title, J: row.J, ...extra });
    if (row.J == null) {
      push('no-vendor-number', { note: 'candidate has no joysound number' });
      continue;
    }
    const hasTj = row.tj != null;
    const hasKy = row.ky != null;
    const both = hasTj && hasKy;

    // Decide intended tier/entry.
    let entry;
    if (both) {
      // Both-vendor (tj+ky) target → Tier E `[tj, joysound]`, regardless of the
      // row's id-slug. Since #165 removed the reviewed-tier tj-slug/singleton
      // guard, a Tier E entry fires by matching the tj vendor-number cell of any
      // record (ky-/tjpdf-/blog-slug included), gated only by the cluster
      // vendor-number conflict guard. The tj number is the stable unique key.
      entry = { tier: 'E', v: 'tj', n: row.tj, J: row.J };
    } else if (hasTj) entry = { tier: 'F', v: 'tj', n: row.tj, J: row.J };
    else if (hasKy) entry = { tier: 'F', v: 'ky', n: row.ky, J: row.J };
    else {
      push('no-vendor-number', { note: 'affected row has neither tj nor ky' });
      continue;
    }

    // Guard: forbidden (pair-level, tier-agnostic).
    const eKey = `${entry.n}|${entry.J}`;
    const fKey = `${entry.v}|${entry.n}|${entry.J}`;
    if ((entry.v === 'tj' && existing.forbiddenE.has(eKey)) || existing.forbiddenF.has(fKey)) {
      push('forbidden', { entry });
      continue;
    }

    // Guard: existing tables.
    const existingHasPairE = entry.v === 'tj' && existing.tierE.get(entry.n)?.has(entry.J);
    const existingHasPairF = existing.tierF.get(`${entry.v}:${entry.n}`)?.has(entry.J);
    if (existingHasPairE || existingHasPairF) {
      push('already-encoded', { entry });
      continue;
    }
    if (existing.existingJ.has(entry.J)) {
      // The joysound target is already merged to another reviewed pair. A ky
      // row here is a 3-way second single-vendor member (joysound consumed by
      // an existing tj-pair; would be inert since Tier E runs first / dup-J in
      // Tier F). A tj row here means both sides carry a non-joysound vendor
      // number (tj↔tj/tjpdf) with no joysound target — the R1
      // "mechanism-inexpressible" class. Either way, not encodable.
      const bucket = entry.v === 'ky' ? '3way-existing-reviewed' : 'both-vendor-number';
      push(bucket, { entry, existingOwner: jOwner.get(entry.J) ?? null });
      continue;
    }
    const targetExistsE = entry.v === 'tj' && existing.tierE.has(entry.n);
    const targetExistsF = existing.tierF.has(`${entry.v}:${entry.n}`);
    if ((entry.tier === 'E' && targetExistsE) || (entry.tier === 'F' && targetExistsF)) {
      push('target-conflict-existing', { entry });
      continue;
    }

    // Guard: within-batch joysound uniqueness (3-way second target).
    if (claimedJ.has(entry.J)) {
      push('3way-dupJ', { entry, winner: claimedJ.get(entry.J) });
      continue;
    }
    // Guard: within-batch target uniqueness.
    const targetKey = entry.tier === 'E' ? `E:${entry.n}` : `F:${entry.v}:${entry.n}`;
    if (claimedTarget.has(targetKey)) {
      push('dup-target-inbatch', { entry });
      continue;
    }

    claimedJ.set(entry.J, row.song_id);
    claimedTarget.add(targetKey);
    const record = {
      ...entry,
      song_id: row.song_id,
      title: row.title,
      artist: row.artist,
      candTitle: row.candTitle,
      candArtist: row.candArtist,
    };
    if (entry.tier === 'E') tierE.push(record);
    else tierF.push(record);
  }

  // Deterministic output order: by numeric target.
  tierE.sort((a, b) => Number(a.n) - Number(b.n));
  tierF.sort((a, b) => (a.v === b.v ? Number(a.n) - Number(b.n) : a.v.localeCompare(b.v)));

  const unencCount = Object.values(unencodable).reduce((n, xs) => n + xs.length, 0);
  return {
    tierE,
    tierF,
    unencodable,
    counts: {
      merges: reviews.length,
      encodedTierE: tierE.length,
      encodedTierF: tierF.length,
      encodedTotal: tierE.length + tierF.length,
      unencodable: unencCount,
    },
  };
}

const cleanComment = (s) =>
  String(s)
    .replace(/[\r\n]+/g, ' ')
    .trim();
const entryComment = (e) =>
  `${e.song_id} ${cleanComment(e.title)} / ${cleanComment(e.artist)} ↔ ${cleanComment(e.candTitle)} / ${cleanComment(e.candArtist)}`;

/**
 * Code-ready entry lines for direct insertion into reviewedMergePairs.ts. The
 * report (formatEntries) and the .ts injection share this one path so the
 * committed diff is exactly what the converter emits.
 */
export function entryLines(plan) {
  return {
    tierE: plan.tierE.map((e) => `  ['${e.n}', '${e.J}'], // ${entryComment(e)}`),
    tierF: plan.tierF.map((e) => `  ['${e.v}', '${e.n}', '${e.J}'], // ${entryComment(e)}`),
  };
}

export function formatEntries(plan) {
  const { tierE, tierF } = entryLines(plan);
  const lines = [];
  lines.push('=== Tier E additions (append to REVIEWED_TIER_E_STRONG_PAIRS) ===');
  lines.push('  // --- Audit follow-up B (2026-07-16 manual merge review, 16 batches) ---');
  lines.push(...tierE);
  lines.push('');
  lines.push('=== Tier F additions (append to REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS) ===');
  lines.push('  // --- Audit follow-up B (2026-07-16 manual merge review, 16 batches) ---');
  lines.push(...tierF);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!existsSync(args.reviews)) {
    console.error(`ERROR: reviews dir not found: ${args.reviews}`);
    process.exitCode = 2;
    return;
  }
  const existing = parseReviewedSource(readFileSync(args.source, 'utf8'));
  const { merges, uncertain, counts, overrides } = loadReviews(args.reviews);
  const plan = buildPlan(merges, existing);

  console.log(
    `[encode-b] verdicts: merge ${counts.merge}, reject ${counts.reject}, uncertain ${counts.uncertain}`,
  );
  if (overrides.length) {
    console.log(`[encode-b] verdict overrides (later file wins): ${overrides.length}`);
    for (const o of overrides) {
      console.log(
        `  - ${o.song_id}: ${o.from.verdict} (${o.from.file}) → ${o.to.verdict} (${o.to.file})`,
      );
    }
  }
  console.log(
    `[encode-b] encoded: Tier E ${plan.counts.encodedTierE}, Tier F ${plan.counts.encodedTierF} (total ${plan.counts.encodedTotal})`,
  );
  console.log(`[encode-b] unencodable: ${plan.counts.unencodable}`);
  for (const [k, xs] of Object.entries(plan.unencodable)) {
    if (xs.length) console.log(`  - ${k}: ${xs.length}`);
  }

  if (args.out) {
    writeTextAtomic(args.out, `${formatEntries(plan)}\n`);
    console.log(`[encode-b] wrote entries → ${args.out}`);
  }
  if (args.planOut) {
    writeJsonAtomic(
      args.planOut,
      {
        counts: plan.counts,
        tierE: plan.tierE,
        tierF: plan.tierF,
        unencodable: plan.unencodable,
        uncertain,
      },
      { indent: 2, trailingNewline: true },
    );
    console.log(`[encode-b] wrote plan → ${args.planOut}`);
  }
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
