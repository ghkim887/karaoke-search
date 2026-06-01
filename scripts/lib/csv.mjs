/**
 * Shared CSV helpers for scripts/*.mjs.
 *
 * Exports:
 *   csvEscape(value)
 *     Quotes a field value when it contains commas, double-quotes, or
 *     newlines. Safe for UTF-8 BOM CSV files.
 */

/**
 * Escape a single CSV field value. Wraps in double-quotes when the value
 * contains a comma, double-quote, or newline; escapes embedded quotes as "".
 * @param {string|null|undefined} field
 * @returns {string}
 */
export function csvEscape(field) {
  const s = String(field ?? '');
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
