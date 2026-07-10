import { useEffect, useRef, useState } from 'preact/hooks';
import { DEBOUNCE_MS } from '../lib/constants.js';

export interface SearchQuery {
  /** Controlled value shown in the `<input>` — updates immediately on every
   *  keystroke (or when a featured chip is picked). */
  inputValue: string;
  /** Debounced value that actually drives the search — only updated after
   *  `DEBOUNCE_MS` of quiet, or synchronously via {@link setQueryImmediate}. */
  query: string;
  /** Keystroke handler: reflect the value in the input immediately and schedule
   *  a debounced `query` update. */
  handleInput: (value: string) => void;
  /** Set both the visible input and the search query synchronously (featured-
   *  artist chip; no debounce). */
  setQueryImmediate: (value: string) => void;
  /** Reset input + query to empty and cancel any pending debounce (tab switch). */
  reset: () => void;
}

/**
 * Owns the debounced search-input state machine: the controlled `inputValue`
 * shown in the box and the `query` that drives the search, promoted from the
 * input after `DEBOUNCE_MS` of quiet. The debounce timer is cancelled on
 * unmount, on every fresh keystroke, and by {@link SearchQuery.reset} /
 * {@link SearchQuery.setQueryImmediate} so a stale timer never revives an old
 * query after a tab switch or chip pick.
 */
export function useSearchQuery(): SearchQuery {
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  const handleInput = (value: string) => {
    setInputValue(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQuery(value);
    }, DEBOUNCE_MS);
  };

  const setQueryImmediate = (value: string) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    setInputValue(value);
    setQuery(value);
  };

  const reset = () => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setInputValue('');
    setQuery('');
  };

  return { inputValue, query, handleInput, setQueryImmediate, reset };
}
