import { featured } from '../data/featured.js';

interface EmptyStateProps {
  onPickArtist: (name: string) => void;
}

const SECTIONS: ReadonlyArray<{ key: keyof typeof featured; label: string }> = [
  { key: 'jpop', label: 'J-POP' },
  { key: 'vocaloid', label: 'Vocaloid' },
  { key: 'anime', label: 'Anime' },
];

/**
 * Default landing view shown on the Browse tab when `query` is empty.
 * The favorites preview previously rendered here lives on the Favorites tab
 * now (see TabBar + App.tsx). EmptyState is purely featured-artist content.
 */
export function EmptyState({ onPickArtist }: EmptyStateProps) {
  return (
    <div class="empty-state">
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
