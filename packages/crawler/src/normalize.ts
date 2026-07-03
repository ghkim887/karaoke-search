/**
 * Identity-key normalization shared by the merger and alias resolver.
 *
 * This is the SAME operation as the search index's compact-text folding
 * (NFKC → locale-independent casefold → keep only `\p{L}`/`\p{N}`/`\p{M}`), so
 * as of T1-3 it is single-sourced from `@karaoke/search` rather than kept as a
 * hand-copied duplicate. The `normalize` name is retained because the merger /
 * alias-resolver docblocks refer to it as the identity key.
 *
 * Design notes: docs/PROJECT-KNOWLEDGE.md (Merger and alias resolution).
 */
export { compactSearchText as normalize } from '@karaoke/search';
