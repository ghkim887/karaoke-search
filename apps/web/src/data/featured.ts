/**
 * Featured-artist suggestions for the empty state. Names are taken verbatim
 * from `apps/web/public/data/songs.json` (`artist_primary` field) so a click
 * on a chip resolves to real index hits.
 *
 * - `jpop`: top-6 by record count in v1 data.
 * - `vocaloid`: top-6 by record count in v1 data.
 * - `anime`: empty in v1; `EmptyState` renders a placeholder for this section.
 */
export const featured: {
  jpop: string[];
  vocaloid: string[];
  anime: string[];
} = {
  jpop: ['米津玄師', 'Ado', 'back number', 'King Gnu', 'ヨルシカ', 'YOASOBI'],
  vocaloid: ['DECO*27', '40mP｜40meterP', 'Orangestar', 'Neru', 'じん｜自然の敵P'],
  anime: [],
};
