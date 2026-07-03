interface ErrorStateProps {
  message: string;
  /** When provided, renders a retry affordance. Used by the API browse/favorites
   *  error paths, which can re-issue the failed request in place. The local
   *  corpus-load error omits it (recovery there needs a full page reload). */
  onRetry?: () => void;
}

/**
 * Friendly bilingual error message shown when a data fetch fails — the local
 * `loadIndex()` corpus download, or (with `onRetry`) an API browse/favorites
 * request. The underlying error string is rendered in small text below the
 * headline so the user sees something actionable without being overwhelmed.
 */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div class="error-state" role="alert">
      <p class="error-state-headline">
        데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. / Failed to load data. Please try
        again shortly.
      </p>
      <p class="error-state-detail">{message}</p>
      {onRetry ? (
        <button type="button" class="error-state-retry" onClick={onRetry}>
          다시 시도 / Retry
        </button>
      ) : null}
    </div>
  );
}
