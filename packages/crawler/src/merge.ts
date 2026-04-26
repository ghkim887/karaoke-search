import type { Category, KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { normalize } from './normalize.js';

/**
 * Identity key per spec: `normalize(title_primary) + "|" + normalize(artist_primary)`.
 */
function identityKey(r: SongRecord): string {
  return `${normalize(r.title_primary)}|${normalize(r.artist_primary)}`;
}

/**
 * Source slug derived from the `id` prefix (everything before the first `-`).
 * The schema's `id` pattern is `^[a-z0-9-]+-\d+$`, so the slug may itself
 * contain `-` only if the source convention uses it; for the v1 blog source
 * (`blog-449-0`) the slug is `blog`.
 */
function sourceSlug(r: SongRecord): string {
  const dash = r.id.indexOf('-');
  return dash === -1 ? r.id : r.id.slice(0, dash);
}

function pickFirstNonNull<T>(values: (T | null)[]): T | null {
  for (const v of values) {
    if (v !== null) return v;
  }
  return null;
}

function mergeKaraokeNumbers(records: SongRecord[]): KaraokeNumbers {
  return {
    tj: pickFirstNonNull(records.map((r) => r.karaoke_numbers.tj)),
    ky: pickFirstNonNull(records.map((r) => r.karaoke_numbers.ky)),
    joysound: pickFirstNonNull(records.map((r) => r.karaoke_numbers.joysound)),
  };
}

function mergeCategories(records: SongRecord[]): Category[] {
  const set = new Set<Category>();
  for (const r of records) {
    for (const c of r.categories) set.add(c);
  }
  return [...set].sort();
}

interface GroupEntry {
  record: SongRecord;
  /** Position in the original input array. Lower wins across distinct sources. */
  inputIndex: number;
}

/**
 * Pick the collision winner among `group`.
 *
 *  - The lowest `inputIndex` from each distinct source represents that source
 *    in the cross-source comparison.
 *  - Cross-source: lowest `inputIndex` wins (registration order).
 *  - Same-source: lowest `crawled_at` wins.
 */
function pickWinner(group: GroupEntry[]): GroupEntry {
  // Step 1: per-source champion by lowest crawled_at.
  const perSource = new Map<string, GroupEntry>();
  for (const entry of group) {
    const slug = sourceSlug(entry.record);
    const incumbent = perSource.get(slug);
    if (!incumbent) {
      perSource.set(slug, entry);
      continue;
    }
    if (entry.record.crawled_at < incumbent.record.crawled_at) {
      perSource.set(slug, entry);
    }
  }
  // Step 2: cross-source by lowest inputIndex among each source's champion.
  let winner: GroupEntry | undefined;
  for (const champ of perSource.values()) {
    if (!winner || champ.inputIndex < winner.inputIndex) {
      winner = champ;
    }
  }
  if (!winner) throw new Error('empty group');
  return winner;
}

/**
 * Source-agnostic merger. Keys records on
 * `normalize(title_primary) + "|" + normalize(artist_primary)`.
 *
 * Collision rules (spec Section Crawler Architecture stage 3):
 *  - `title_primary`, `title_ko`, `artist_primary`, `artist_ko`, `source_url`,
 *    `release_year`, `id`, `crawled_at`: registration-order winner.
 *    Same-source ties break by lower `crawled_at`.
 *  - `karaoke_numbers.{tj,ky,joysound}`: first non-null across the group.
 *  - `categories`: union, deduped, alphabetically sorted.
 *
 * Output preserves first-seen order of the identity keys.
 */
export function mergeRecords(records: SongRecord[]): SongRecord[] {
  const groups = new Map<string, GroupEntry[]>();
  const order: string[] = [];

  records.forEach((record, idx) => {
    const key = identityKey(record);
    const existing = groups.get(key);
    if (existing) {
      existing.push({ record, inputIndex: idx });
    } else {
      groups.set(key, [{ record, inputIndex: idx }]);
      order.push(key);
    }
  });

  const out: SongRecord[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (!group) continue;
    const winner = pickWinner(group).record;
    const groupRecords = group.map((g) => g.record);
    const merged: SongRecord = {
      id: winner.id,
      source_url: winner.source_url,
      title_primary: winner.title_primary,
      title_ko: winner.title_ko,
      artist_primary: winner.artist_primary,
      artist_ko: winner.artist_ko,
      release_year: winner.release_year,
      karaoke_numbers: mergeKaraokeNumbers(groupRecords),
      categories: mergeCategories(groupRecords),
      crawled_at: winner.crawled_at,
    };
    out.push(merged);
  }
  return out;
}
