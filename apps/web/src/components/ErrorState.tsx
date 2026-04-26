interface ErrorStateProps {
  message: string;
}

/**
 * Friendly bilingual error message shown when `loadIndex()` rejects.
 * The underlying error string is rendered in small text below the headline
 * so the user sees something actionable without being overwhelmed.
 */
export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div class="error-state" role="alert">
      <p class="error-state-headline">
        데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. / データの読み込みに失敗しました。
      </p>
      <p class="error-state-detail">{message}</p>
    </div>
  );
}
