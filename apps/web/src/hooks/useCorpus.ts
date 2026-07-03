import { useEffect, useState } from 'preact/hooks';
import type { SearchBackend } from '../lib/backend.js';
import type { IndexBundle } from '../lib/search.js';

export interface CorpusState {
  /** The loaded offline bundle, or `null` when unloaded / in API mode. */
  bundle: IndexBundle | null;
  /** True until the corpus load settles. In API mode this flips to `false`
   *  immediately (there is nothing to download). */
  loading: boolean;
  /** Corpus download/parse error message, or `null`. */
  error: string | null;
}

/**
 * Owns the one-shot corpus load. The offline backend downloads + builds the
 * MiniSearch bundle; the API backend resolves `null` and simply flips
 * `loading` off. Callers gate the "Building index" chrome on
 * `loading && backend.requiresLocalCorpus`.
 */
export function useCorpus(backend: SearchBackend): CorpusState {
  const [bundle, setBundle] = useState<IndexBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    backend
      .loadCorpus()
      .then((loaded) => {
        if (cancelled) return;
        setBundle(loaded);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  return { bundle, loading, error };
}
