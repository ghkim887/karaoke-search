import type { SongRecord } from '@karaoke/schema';
import { ResultCard } from './ResultCard.js';

interface ResultListProps {
  records: SongRecord[];
  isFavorite: (id: string) => boolean;
  onToggleFavorite: (id: string) => void;
}

/**
 * Shared result-list block used by both the Browse and Favorites render
 * branches in `App.tsx`. Extracted purely to remove duplication — the JSX
 * inside is identical between the two branches and any future card-row
 * styling change should land in exactly one place.
 */
export function ResultList({ records, isFavorite, onToggleFavorite }: ResultListProps) {
  return (
    <ul class="result-list">
      {records.map((r) => (
        <li key={r.id} class="result-list-item">
          <ResultCard
            record={r}
            isFavorite={isFavorite(r.id)}
            onToggleFavorite={onToggleFavorite}
          />
        </li>
      ))}
    </ul>
  );
}
