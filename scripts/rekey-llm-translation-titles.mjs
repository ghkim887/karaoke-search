#!/usr/bin/env node
/**
 * Re-key drifted Stage-2 translation-cache `title_primary` guards to the
 * current corpus.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Stage-2 replay cache lives in `scripts/data/llm-translations-chunk-*.json`
 * as `{ id, title_primary, title_ko, ... }` entries. `applyDecisionsToCorpus`
 * (scripts/translate_title_ko_via_agents.mjs) applies a cached translation only
 * when the cached `title_primary` NFKC-matches the corpus row's `title_primary`
 * — the guard against a TJ title edit silently re-applying a stale translation.
 *
 * When a crawl re-derives a title with cosmetic drift (a space before a tie-up
 * paren, a tie-up paren newly present/absent, or a space that shifted next to a
 * `~…~` subtitle bracket) the guard NFKC-mismatches and the cached Korean title
 * silently stops re-applying — a real loss even though it is the SAME song.
 * This is the documented realignment RULE in docs/PROJECT-KNOWLEDGE.md (the
 * "title_primary changed → realign BOTH guard surfaces in the same change,
 * translations byte-preserved" pitfall; PR #125 realigned the tjpdf side).
 *
 * Originally built for the positional-id era, when blog-* ids were re-assigned
 * to different songs on every crawl and this drift RECURRED. Since the blog
 * stable-identity change (2026-07-14) blog ids are stable — minted from the
 * row's claimed vendor number — so the tool now serves as the general safety
 * net for cosmetic title drift on ANY source (a vendor title edit between
 * crawls) and for legacy holdover entries. Re-run it after a crawl introduces
 * new drift.
 *
 * WHAT IT DOES
 * ------------
 * For every cache entry that is drifted vs the corpus (NFKC(title_primary)
 * differs) it re-keys the stored `title_primary` to the corpus value ONLY when
 * the two titles match on a conservative CORE comparison (see `coreTitle`):
 *   NFKC → strip ALL parenthesized segments (ASCII; NFKC folds full-width
 *   parens to ASCII) → normalize whitespace around the wave-dash/tilde family →
 *   collapse/trim whitespace.
 * Every other field (translation values included) is byte-preserved and key
 * order is unchanged (`title_primary` is replaced in place). Entries whose
 * cores do NOT match are left untouched and reported as a review-needed
 * remainder — this is what stops a re-assigned blog id (a genuinely different
 * song sharing the same id) from receiving the previous song's translation.
 *
 * SAFETY: destructive-nullout hold. Re-keying aligns the guard so the merge
 * APPLIES the entry. If the cache decision carries no translation
 * (title_ko null/empty) but the corpus row already holds one from a non-manual
 * source, aligning the guard would let the null decision NULL that existing
 * title_ko at the next merge (data loss). Such entries are HELD (not re-keyed)
 * and reported. Manual-sourced title_ko is merge-protected, so it is never at
 * risk and is re-keyed normally (the alignment is inert).
 *
 * USAGE
 * -----
 *   node scripts/rekey-llm-translation-titles.mjs [corpus.json] [chunks_dir]
 * Defaults: corpus = apps/web/public/data/songs.json, chunks_dir = scripts/data.
 * Rewrites each changed chunk file in place with the canonical byte-shape
 * (JSON.stringify indent=2 + trailing newline, LF, no BOM). Idempotent:
 * re-running after a successful pass writes nothing. Prints a JSON report.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const CHUNK_OUTPUT_RE = /^llm-translations-chunk-\d+\.json$/;

/** True for a non-empty string. */
function hasText(value) {
  return typeof value === 'string' && value !== '';
}

/** NFKC-normalize, tolerating null/undefined. */
function nfkc(value) {
  return (value ?? '').normalize('NFKC');
}

/**
 * Conservative CORE of a title for the re-key match test.
 *
 * NFKC → strip ALL parenthesized segments (ASCII parens; NFKC has already
 * folded full-width （ ）to ASCII) → normalize whitespace around the
 * wave-dash / tilde family used in `~…~` subtitle brackets to a single
 * canonical marker → collapse internal whitespace runs and trim.
 *
 * It deliberately does NOT remove whitespace that sits inside the base title,
 * so titles differing by an internal space (or by a real word) stay distinct.
 *
 * @param {string} title
 * @returns {string}
 */
export function coreTitle(title) {
  let t = nfkc(title);
  // Strip parenthesized segments; loop until stable so adjacent/nested groups
  // are all removed.
  let prev;
  do {
    prev = t;
    t = t.replace(/\([^()]*\)/g, '');
  } while (t !== prev);
  // Wave-dash / tilde family: ~ U+007E, 〜 U+301C, ～ U+FF5E, ∼ U+223C,
  // 〰 U+3030, ⁓ U+2053, ˜ U+02DC. Collapse any surrounding whitespace so a
  // space that drifted next to the bracket does not defeat the match.
  t = t.replace(/\s*[~〜～∼〰⁓˜]\s*/g, '~');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * True when two titles share the same conservative core (and it is non-empty —
 * a title that is nothing but a parenthetical strips to '' and must not match
 * an unrelated empty core).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function coresMatch(a, b) {
  const core = coreTitle(a);
  return core !== '' && core === coreTitle(b);
}

/**
 * True when re-keying this entry would let a null cache decision destroy an
 * existing corpus title_ko at merge time. See the SAFETY note in the header.
 *
 * @param {{ title_ko?: string|null }} cacheEntry
 * @param {{ title_ko?: string|null, title_ko_source?: string|null }} corpusRec
 * @returns {boolean}
 */
export function isDestructiveNullout(cacheEntry, corpusRec) {
  return (
    !hasText(cacheEntry.title_ko) &&
    hasText(corpusRec.title_ko) &&
    corpusRec.title_ko_source !== 'manual'
  );
}

/**
 * Pure transform over one chunk's entries. Returns a NEW array plus the
 * decision report; does not mutate input.
 *
 * @param {Array<object>} entries
 * @param {Map<string, object>} corpusById
 * @returns {{ entries: Array<object>, rekeyed: Array, held: Array, remainder: Array }}
 */
export function rekeyEntries(entries, corpusById) {
  const rekeyed = [];
  const held = [];
  const remainder = [];
  const out = entries.map((entry) => {
    const rec = corpusById.get(entry.id);
    // Id absent from corpus, or not drifted → leave the entry byte-identical.
    if (!rec) return entry;
    if (nfkc(entry.title_primary) === nfkc(rec.title_primary)) return entry;

    if (!coresMatch(entry.title_primary, rec.title_primary)) {
      remainder.push({
        id: entry.id,
        cacheTitle: entry.title_primary,
        corpusTitle: rec.title_primary,
      });
      return entry;
    }
    if (isDestructiveNullout(entry, rec)) {
      held.push({
        id: entry.id,
        reason: `would null existing ${rec.title_ko_source ?? 'unknown'}-sourced title_ko`,
        cacheTitle: entry.title_primary,
        corpusTitle: rec.title_primary,
      });
      return entry;
    }
    rekeyed.push({ id: entry.id, from: entry.title_primary, to: rec.title_primary });
    // Replace ONLY title_primary; spreading preserves key order and every other
    // field (translation values included) byte-for-byte.
    return { ...entry, title_primary: rec.title_primary };
  });
  return { entries: out, rekeyed, held, remainder };
}

/**
 * CLI entrypoint: load corpus + chunk files, re-key, rewrite changed chunks
 * atomically with the canonical byte-shape, print a JSON report.
 */
function main(corpusPath, chunksDir) {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
  const byId = new Map(corpus.map((r) => [r.id, r]));
  const files = readdirSync(chunksDir)
    .filter((f) => CHUNK_OUTPUT_RE.test(f))
    .sort();

  const rekeyed = [];
  const held = [];
  const remainder = [];
  let filesChanged = 0;

  for (const f of files) {
    const path = join(chunksDir, f);
    const original = readFileSync(path, 'utf-8');
    const arr = JSON.parse(original);
    const result = rekeyEntries(arr, byId);
    rekeyed.push(...result.rekeyed);
    held.push(...result.held);
    remainder.push(...result.remainder);
    if (result.rekeyed.length > 0) {
      const next = `${JSON.stringify(result.entries, null, 2)}\n`;
      if (next !== original) {
        writeTextAtomic(path, next);
        filesChanged += 1;
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        corpusPath,
        chunksDir,
        chunkFiles: files.length,
        filesChanged,
        rekeyed: rekeyed.length,
        held: held.length,
        remainder: remainder.length,
        heldDetail: held,
        remainderIds: remainder.map((r) => r.id),
      },
      null,
      2,
    )}\n`,
  );
}

if (isCliInvocation(import.meta.url)) {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(HERE, '..');
  const corpusPath = process.argv[2] ?? resolve(repoRoot, 'apps/web/public/data/songs.json');
  const chunksDir = process.argv[3] ?? resolve(HERE, 'data');
  main(corpusPath, chunksDir);
}
