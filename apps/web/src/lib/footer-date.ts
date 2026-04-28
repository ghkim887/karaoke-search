/**
 * Format the DB-update date for the footer.
 *
 * Branches:
 *   1. `gitOutput` non-empty → return its trimmed value (already YYYY-MM-DD).
 *   2. `envEpoch` parses as a positive integer → format as YYYY-MM-DD in UTC.
 *   3. Otherwise → return ''. The Footer component then renders no date token
 *      and no leading bullet separator.
 */
export function formatDbDate(gitOutput: string, envEpoch: string | undefined): string {
  const trimmed = gitOutput.trim();
  if (trimmed.length > 0) return trimmed;
  if (envEpoch !== undefined && /^[0-9]+$/.test(envEpoch)) {
    const seconds = Number.parseInt(envEpoch, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      const d = new Date(seconds * 1000);
      const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
      const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = d.getUTCDate().toString().padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  return '';
}
