import { featured, featuredArtistLabel, featuredArtistQuery } from '../data/featured.js';

interface EmptyStateProps {
  onPickArtist: (name: string) => void;
}

/**
 * Default landing view shown on the Browse tab when `query` is empty.
 * The favorites preview previously rendered here lives on the Favorites tab
 * now (see TabBar + App.tsx). EmptyState is purely featured-artist content —
 * a single unlabeled chip list (no category section grouping).
 */
export function EmptyState({ onPickArtist }: EmptyStateProps) {
  return (
    <div class="empty-state">
      <section class="empty-section">
        {featured.length === 0 ? (
          <p class="empty-section-placeholder">아직 없음 / Not yet</p>
        ) : (
          <div class="empty-section-chips">
            {featured.map((artist) => {
              const label = featuredArtistLabel(artist);
              const query = featuredArtistQuery(artist);
              return (
                <button key={label} type="button" class="chip" onClick={() => onPickArtist(query)}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
