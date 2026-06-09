/**
 * Featured-artist suggestions for the empty state.
 *
 * Most chips use the visible label as the search query. Some display labels
 * include metadata for readability (for example producer aliases), so those
 * entries carry a separate `query` that maps to a real indexed artist term.
 *
 * A single flat, unlabeled list — the landing page no longer groups featured
 * artists by category.
 */
export type FeaturedArtist = string | { label: string; query: string };

export const featured: FeaturedArtist[] = [
  '米津玄師',
  'Ado',
  'back number',
  'King Gnu',
  'ヨルシカ',
  'YOASOBI',
  'DECO*27',
  '40mP',
  'Orangestar',
  'Neru',
  { label: 'じん｜自然の敵P', query: 'じん' },
  'LiSA',
  'Linked Horizon',
  '鈴木このみ',
  'fripSide',
  'EGOIST',
  'ClariS',
];

export function featuredArtistLabel(artist: FeaturedArtist): string {
  return typeof artist === 'string' ? artist : artist.label;
}

export function featuredArtistQuery(artist: FeaturedArtist): string {
  return typeof artist === 'string' ? artist : artist.query;
}
