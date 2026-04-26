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
  jpop: ['中森明菜', 'DREAMS COME TRUE', 'RADWIMPS', 'GReeeeN', '中島みゆき', 'GRANRODEO'],
  vocaloid: ['DECO*27', '40mP｜40meterP', 'cosMo@暴走P', 'MIMI', 'OSTER project', 'mothy_悪ノP'],
  anime: [],
};
