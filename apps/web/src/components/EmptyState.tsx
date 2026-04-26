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
 * Default landing view shown when `query` is empty. Surfaces the per-category
 * featured artists from `data/featured.ts` so the user has a one-click entry
 * point into the index.
 */
export function EmptyState({ onPickArtist }: EmptyStateProps) {
  return (
    <div class="empty-state">
      {SECTIONS.map((section) => {
        const artists = featured[section.key];
        return (
          <section key={section.key} class="empty-section">
            <h2 class="empty-section-title">{section.label}</h2>
            {artists.length === 0 ? (
              <p class="empty-section-placeholder">아직 없음 / まだなし</p>
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
