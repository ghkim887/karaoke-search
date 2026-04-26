import type { SongRecord } from '@karaoke/schema';
import { useEffect, useRef, useState } from 'preact/hooks';

interface ResultCardProps {
  record: SongRecord;
}

/**
 * Combine bilingual primary/ko fields with the spec separator ` — `. Falls
 * back to whichever side is non-null; if both are empty (impossible per
 * schema for primary fields, but defensive), returns an em-dash.
 */
function joinBilingual(primary: string | null, ko: string | null): string {
  if (primary && ko) return `${primary} — ${ko}`;
  return primary ?? ko ?? '—';
}

interface NumberBadgeProps {
  label: 'TJ' | 'KY' | 'JOY';
  value: string | null;
  testId: string;
}

function NumberBadge({ label, value, testId }: NumberBadgeProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // clipboard write failed (e.g. insecure context) — silently no-op.
    }
  };

  return (
    <button
      type="button"
      class={`badge badge-number ${value === null ? 'badge-disabled' : ''}`}
      data-testid={testId}
      aria-label={`${label} 번호 복사`}
      disabled={value === null}
      onClick={handleClick}
    >
      <span class="badge-label">{label}</span>
      <span class="badge-value">{value ?? '—'}</span>
      {copied && <span class="badge-toast">복사됨</span>}
    </button>
  );
}

export function ResultCard({ record }: ResultCardProps) {
  const titleText = joinBilingual(record.title_primary, record.title_ko);
  const artistText = joinBilingual(record.artist_primary, record.artist_ko);

  return (
    <article class="result-card" data-testid="result-card">
      <h2 class="result-title">{titleText}</h2>
      <div class="result-artist">{artistText}</div>
      <div class="result-tags">
        {record.release_year !== null && (
          <span class="badge badge-year">{record.release_year}</span>
        )}
        {record.categories.map((c) => (
          <span key={c} class="badge badge-category">
            {c}
          </span>
        ))}
      </div>
      <div class="result-numbers">
        <NumberBadge label="TJ" value={record.karaoke_numbers.tj} testId="badge-tj" />
        <NumberBadge label="KY" value={record.karaoke_numbers.ky} testId="badge-ky" />
        <NumberBadge label="JOY" value={record.karaoke_numbers.joysound} testId="badge-joysound" />
      </div>
      <a
        class="result-source"
        href={record.source_url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="원문 소스 새 창에서 열기"
      >
        Source ↗
      </a>
    </article>
  );
}
