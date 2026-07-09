/**
 * Order-independent deep JSON serialization, for EQUALITY comparison only.
 *
 * Object keys are sorted recursively (default lexicographic UTF-16 order) so two
 * values that differ ONLY in key order serialize identically; array element
 * order is preserved. Used to decide whether two outputs of the SAME producer
 * are equal — e.g. did an existing record change at all before classifying HOW
 * (build-joysound-candidate), the merge-delta gate (corpus-audit-guardrails),
 * the replay-merger delta-0 write gate. The result is a comparison key, never a
 * persisted or exported canonical form.
 *
 * undefined handling: `JSON.stringify(undefined)` yields the JS value
 * `undefined` (not a string), so a top-level/nested `undefined` is normalized to
 * the literal `'null'` — the output is always a string. JSON-parsed corpus
 * records never contain `undefined`, so this only guards absent-key lookups.
 *
 * Do NOT reach for `JSON.stringify(value, Object.keys(value).sort())`: the 2nd
 * arg is a REPLACER ALLOWLIST, not a key sorter, and it recurses into nested
 * objects — so nested keys absent from the top-level allowlist (e.g.
 * `karaoke_numbers`'s tj/ky/joysound) serialize as `{}` and their changes go
 * invisible.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
