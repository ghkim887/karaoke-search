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
    <div class="search-input-wrap">
      <svg
        class="search-input-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M10 4a6 6 0 1 0 3.873 10.59l4.768 4.768 1.414-1.415-4.768-4.767A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          fill="currentColor"
        />
      </svg>
      <input
        class="search-input"
        type="search"
        aria-label="가라오케 검색"
        placeholder="곡명/가수명"
        autocomplete="off"
        spellcheck={false}
        enterkeyhint="search"
        value={value}
        onInput={handleInput}
      />
    </div>
  );
}
