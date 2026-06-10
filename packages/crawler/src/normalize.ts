/**
 * Identity-key normalization shared by the merger and (via a copy) the
 * frontend search index. Steps, in order:
 *   1. Unicode NFKC.
 *   2. Locale-independent casefold via `toLocaleLowerCase('und')`.
 *   3. Strip every code point outside `\p{L}` (letters), `\p{N}` (numbers),
 *      and `\p{M}` (combining marks).
 *
 * Design notes: docs/PROJECT-KNOWLEDGE.md (Merger and alias resolution).
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}
