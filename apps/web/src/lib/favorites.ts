import { useCallback, useMemo, useState } from 'preact/hooks';

const STORAGE_KEY = 'karaoke-favorites:v1';

function readFromStorage(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writeToStorage(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage quota or disabled — best-effort.
  }
}

export interface UseFavoritesReturn {
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
  orderedIds: string[];
}

/**
 * Device-local favorites backed by `localStorage` key `karaoke-favorites:v1`.
 * Returns an ordered array (newest-favorited first) so callers can render in
 * order without re-sorting, plus O(1) helpers backed by an internal Set.
 */
export function useFavorites(): UseFavoritesReturn {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => readFromStorage());

  const toggle = useCallback((id: string) => {
    setOrderedIds((prev) => {
      const idx = prev.indexOf(id);
      const next = idx >= 0 ? prev.filter((x) => x !== id) : [id, ...prev];
      writeToStorage(next);
      return next;
    });
  }, []);

  // Internal Set derived from orderedIds — O(1) isFavorite without exposing
  // the raw Set on the public interface (callers use isFavorite()).
  const favorites = useMemo(() => new Set(orderedIds), [orderedIds]);

  const isFavorite = useCallback((id: string) => favorites.has(id), [favorites]);

  return { toggle, isFavorite, orderedIds };
}
