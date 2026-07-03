import type { SongRecord } from '@karaoke/schema';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';

interface ResultCardProps {
  record: SongRecord;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
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

/**
 * Append `(Alias1, Alias2)` to the canonical artist when `aliases` is non-
 * empty. Spec 2026-05-04: alias-display preserves the canonical pipe-form
 * order (no alphabetic sort), and aliases join with `", "`.
 */
function joinArtistDisplay(primary: string, aliases: string[] | undefined): string {
  if (!aliases || aliases.length === 0) return primary;
  return `${primary} (${aliases.join(', ')})`;
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
    <>
      <button
        type="button"
        class={`badge badge-number ${value === null ? 'badge-disabled' : ''}`}
        data-testid={testId}
        aria-label={t.copyNumberLabel(label)}
        disabled={value === null}
        onClick={handleClick}
      >
        <span class="badge-label">{label}</span>
        <span class="badge-value">{value ?? '—'}</span>
        {/* Visual-only toast; hidden from AT so it isn't double-announced with
            the sr-only live region beside it. */}
        {copied && (
          <span class="badge-toast" aria-hidden="true">
            {t.copiedToast}
          </span>
        )}
      </button>
      {/* Persistent polite live region (mirrors App's result-count pattern:
          aria-live span, no explicit role): filled on copy so screen readers
          announce it once, empty otherwise. */}
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="copy-status">
        {copied ? t.copiedAnnouncement : ''}
      </span>
    </>
  );
}

export function ResultCard({ record, isFavorite, onToggleFavorite }: ResultCardProps) {
  const titleText = joinBilingual(record.title_primary, record.title_ko);
  // Spec 2026-05-04: alias display runs first, then bilingual joiner. The
  // resulting string is e.g. `"スピッツ (Spitz) — 스피츠"` when both aliases
  // and `artist_ko` are present.
  const artistPrimaryWithAliases = joinArtistDisplay(record.artist_primary, record.artist_aliases);
  const artistText = joinBilingual(artistPrimaryWithAliases, record.artist_ko);

  return (
    <article class="result-card" data-testid="result-card">
      <button
        type="button"
        class={`favorite-star ${isFavorite ? 'favorite-star-on' : ''}`}
        aria-label={t.favoriteLabel}
        aria-pressed={isFavorite}
        onClick={() => onToggleFavorite(record.id)}
      >
        {isFavorite ? '★' : '☆'}
      </button>
      <h2 class="result-title">
        {titleText}
        {record.media_context_ko && !(record.title_ko ?? '').includes(record.media_context_ko) && (
          <span class="result-media-context">{` ${record.media_context_ko}`}</span>
        )}
      </h2>
      <div class="result-artist">{artistText}</div>
      <div class="result-numbers">
        <NumberBadge label="TJ" value={record.karaoke_numbers.tj} testId="badge-tj" />
        <NumberBadge label="KY" value={record.karaoke_numbers.ky} testId="badge-ky" />
        <NumberBadge label="JOY" value={record.karaoke_numbers.joysound} testId="badge-joysound" />
      </div>
    </article>
  );
}
