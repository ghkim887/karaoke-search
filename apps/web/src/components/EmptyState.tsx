import type { SongRecord } from '@karaoke/schema';
import { featured } from '../data/featured.js';
import { ResultCard } from './ResultCard.js';

interface EmptyStateProps {
  onPickArtist: (name: string) => void;
  favoriteIds: string[];
  byId: Map<string, SongRecord> | null;
  isFavorite: (id: string) => boolean;
  onToggleFavorite: (id: string) => void;
}

const SECTIONS: ReadonlyArray<{ key: keyof typeof featured; label: string }> = [
  { key: 'jpop', label: 'J-POP' },
  { key: 'vocaloid', label: 'Vocaloid' },
  { key: 'anime', label: 'Anime' },
];

/**
 * Default landing view shown when `query` is empty.
 *
 * If the user has any favorites, the favorites section renders FIRST. The id
 * list comes from `useFavorites().orderedIds` (already newest-first); ids that
 * no longer resolve in the loaded corpus (`byId`) are silently skipped.
 */
export function EmptyState({
  onPickArtist,
  favoriteIds,
  byId,
  isFavorite,
  onToggleFavorite,
}: EmptyStateProps) {
  // Resolve favorite ids to records, dropping stale/unloaded ids silently.
  const favoriteRecords: SongRecord[] = [];
  if (byId !== null) {
    for (const id of favoriteIds) {
      const rec = byId.get(id);
      if (rec !== undefined) favoriteRecords.push(rec);
    }
  }

  return (
    <div class="empty-state">
      {favoriteRecords.length > 0 && (
        <section class="empty-section empty-favorites-section">
          <h2 class="empty-section-title empty-favorites-title">
            ★ 즐겨찾기 ({favoriteRecords.length}) / Favorites
          </h2>
          <ul class="result-list">
            {favoriteRecords.map((r) => (
              <li key={r.id} class="result-list-item">
                <ResultCard
                  record={r}
                  isFavorite={isFavorite(r.id)}
                  onToggleFavorite={onToggleFavorite}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {SECTIONS.map((section) => {
        const artists = featured[section.key];
        return (
          <section key={section.key} class="empty-section">
            <h2 class={`empty-section-title empty-section-title-${section.key}`}>
              {section.label}
            </h2>
            {artists.length === 0 ? (
              <p class="empty-section-placeholder">아직 없음 / Not yet</p>
            ) : (
              <div class="empty-section-chips">
                {artists.map((name) => (
                  <button
                    key={name}
                    type="button"
                    class="featured-chip"
                    onClick={() => onPickArtist(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
