import { t } from '../lib/i18n.js';
import { useLocale } from '../lib/locale-hooks.js';

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
  const locale = useLocale();
  return (
    <div class="error-state" role="alert">
      <p class="error-state-headline">{t(locale, 'loadDataFailed')}</p>
      <p class="error-state-detail">{message}</p>
      {onRetry ? (
        <button type="button" class="error-state-retry" onClick={onRetry}>
          {t(locale, 'retry')}
        </button>
      ) : null}
    </div>
  );
}
