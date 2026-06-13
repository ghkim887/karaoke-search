// `kuroshiro` and its kuromoji analyzer ship no TypeScript types. They are used
// build-time ONLY (the opt-in `generateKanjiReadingHints` kanji-reading path),
// dynamically imported, and never reach the worker or web runtime bundles. The
// loose ambient declarations keep that interop confined to one module.
declare module 'kuroshiro';
declare module 'kuroshiro-analyzer-kuromoji';
