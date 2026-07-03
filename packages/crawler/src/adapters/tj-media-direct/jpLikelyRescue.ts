import { hasKana } from '@karaoke/search';
import type { HttpClient } from '../../http.js';
import type { EnrichmentEntry, SearchSongCache } from './cache.js';
import { classifyRecord } from './parser.js';
import { searchSongByPro } from './searchSong.js';

export interface CatalogShell {
  tj: string;
  title: string;
  artist: string;
}

export function parseCatalogShell(item: Record<string, unknown>): CatalogShell | null {
  const proRaw = item.pro;
  const title = typeof item.indexTitle === 'string' ? item.indexTitle.trim() : '';
  const artist = typeof item.indexSong === 'string' ? item.indexSong.trim() : '';
  let tj: string | null = null;
  if (typeof proRaw === 'number' && Number.isFinite(proRaw)) tj = String(proRaw);
  else if (typeof proRaw === 'string' && proRaw.trim() !== '') tj = proRaw.trim();
  if (!tj || !title || !artist) return null;
  return { tj, title, artist };
}

export interface JpLikelyRescueStats {
  candidates: number;
  fetches: number;
  admitted: number;
  misses: number;
  skippedCached: number;
  errors: number;
}

export async function rescueJpLikelyDroppedRecords(
  http: Pick<HttpClient, 'postForm'>,
  items: ReadonlyArray<Record<string, unknown>>,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): Promise<JpLikelyRescueStats> {
  const stats: JpLikelyRescueStats = {
    candidates: 0,
    fetches: 0,
    admitted: 0,
    misses: 0,
    skippedCached: 0,
    errors: 0,
  };

  const now = new Date().toISOString();
  for (const item of items) {
    const shell = parseCatalogShell(item);
    if (shell === null) continue;
    if (classifyRecord(shell.tj, shell.artist, cache, force) !== 'drop') continue;
    if (!isStrongJpLikelyCandidate(shell)) continue;

    stats.candidates++;
    const cached = cache.proEnrichmentMap[shell.tj];
    if (cached?.nationalcode) {
      stats.skippedCached++;
      continue;
    }

    let match: Awaited<ReturnType<typeof searchSongByPro>>;
    try {
      match = await searchSongByPro(http, shell.tj);
      stats.fetches++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tj-rescue] title-search failed for pro=${shell.tj}: ${msg}`);
      stats.errors++;
      continue;
    }
    if (match?.nationalcode === 'JPN') {
      const entry: EnrichmentEntry = {
        nationalcode: match.nationalcode,
        sortTitleKo: match.sortTitleKo,
        sortSongKo: match.sortSongKo,
        subTitle: match.subTitle,
        publishdate: match.publishdate,
        lastSeen: now,
      };
      cache.proEnrichmentMap[shell.tj] = entry;
      stats.admitted++;
    } else {
      stats.misses++;
    }
  }

  if (stats.fetches > 0) cache.generatedAt = now;
  return stats;
}

function isStrongJpLikelyCandidate(shell: CatalogShell): boolean {
  const text = `${shell.title} ${shell.artist}`;
  if (hasKana(text)) return true;
  return (
    /\b(OP|ED|OST)\b/.test(shell.title) &&
    /[犬夜叉銀魂進撃名探偵図書館戦争地獄少女最遊記]/.test(shell.title)
  );
}
