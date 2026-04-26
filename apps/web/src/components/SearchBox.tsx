interface SearchBoxProps {
  /** Controlled value — what the input displays. */
  value: string;
  /** Called on every input event with the current raw string value.
   *  The parent is responsible for debouncing before running a search. */
  onInput: (value: string) => void;
}

/**
 * Fully-controlled search input. The parent (`App`) owns both the visible
 * value and the debounce timer so that programmatic updates (e.g. clicking a
 * featured-artist chip) are immediately reflected in the input box.
 */
export function SearchBox({ value, onInput }: SearchBoxProps) {
  const handleInput = (e: Event) => {
    onInput((e.currentTarget as HTMLInputElement).value);
  };

  return (
    <input
      class="search-input"
      type="search"
      aria-label="가라오케 검색"
      placeholder="노래/아티스트/曲名/imase ..."
      autocomplete="off"
      spellcheck={false}
      value={value}
      onInput={handleInput}
    />
  );
}
