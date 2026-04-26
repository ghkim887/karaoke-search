// Mirror of packages/crawler/src/normalize.ts. Keep in sync. Parity is asserted in apps/web/src/lib/normalize.test.ts.

/**
 * Identity-key normalization shared by the merger and (via a copy) the
 * frontend search index. Steps, in order:
 *   1. Unicode NFKC.
 *   2. Locale-independent casefold via `toLocaleLowerCase('und')`.
 *   3. Strip every code point outside `\p{L}` (letters), `\p{N}` (numbers),
 *      and `\p{M}` (combining marks).
 *
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-design.md, Data Model.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}
