import { useEffect, useState } from 'preact/hooks';
import { type SearchBackend, isFallbackStatusSource } from '../lib/backend.js';

/**
 * Subscribes to a backend's fallback-active signal (T4-6). Returns `true` while
 * the most recent data operation was served from the local corpus because the
 * API failed, so the App can surface a subtle "offline / saved list" hint.
 *
 * Backends without the fallback capability (the offline/local-dev backend, or a
 * plain API backend) report `false` forever — the hook is a no-op for them.
 */
export function useFallbackStatus(backend: SearchBackend): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!isFallbackStatusSource(backend)) {
      setActive(false);
      return;
    }
    // Sync to the current value on mount, then track changes.
    setActive(backend.isFallbackActive());
    return backend.subscribeFallback(() => setActive(backend.isFallbackActive()));
  }, [backend]);

  return active;
}
