# JOYSOUND classifier gate-array restructure — design

Closes the open ROADMAP refactor item "JOYSOUND classifier gate-array
restructure — only with a diagnostic-replay proof of behavior identity"
(deliberately skipped 2026-07-10: the replay proof was assumed heavy and the
v22 sweep was mid-flight; both preconditions have since resolved — the repo
already ships `scripts/joysound-replay-classifier.mjs`, and the v22 sweep's
340,653-row decision log exists as the replay corpus). Owner batch go
2026-07-12 ("백로그 처리해보자").

**Hard requirement: behavior identity.** This is a control-flow reshape ONLY.
No predicate may change — the RE_HAN/RE_HANGUL/RE_HAN_FOREIGN → shared-predicate
unification is the SEPARATE owner-held Phase-2 item and stays untouched
(classifier.ts predicates/constants, roughly lines 1–410, are off-limits).

## Target shape

Convert the monolithic guard-clause chain in
`packages/crawler/src/adapters/joysound-official/classifier.ts:442-563`
(`classifyJoysoundRecordWithReason`) into the house-style ordered gate array,
mirroring the TJ pattern (`adapters/tj-media-direct/filterSteps.ts:93-101,
319-361`):

- `JoysoundGate[]` of `{ name, phase, evaluate(ctx) }` run by a
  short-circuiting reducer;
- `PHASE_ORDER` as data + `assertPhaseOrder()` throwing at module load on
  mis-order (the order becomes machine-checked instead of prose-asserted —
  today it is only documented at classifier.ts:411-441 and pinned by the
  golden test);
- a context builder that precomputes the shared row surfaces ONCE
  (surface, titleArtist, artistSurface, artistFields, positiveKind) and hands
  them to every gate.

Phase order (load-bearing, from the current chain):
`override-drop → override-allow → foreign-name-detail-drop → foreign-act →
positive-cascade → injected-jp-artist → terminal`.

### Watch items (from recon — each is a known identity hazard)

1. `positiveKind` is computed once BEFORE the override-ALLOW path and reused
   later (classifier.ts:478). The context builder must replicate that
   compute-once semantics — recomputing per gate could diverge if any gate
   mutated state (none do today, but keep the single compute).
2. The final stage bundles `admit-jp-detail` recovery with the han/ascii-split
   fall-through drop and defensively RE-calls `foreignNameSignal`
   (classifier.ts:550-562). Keep it as ONE composite terminal gate — do not
   split it into separate gates, which would change short-circuit reachability
   semantics.
3. Detail-gated logic must stay inert when `detail` is absent (listing-only
   rows).

### Public API

`classifyJoysoundRecord` and `classifyJoysoundRecordWithReason` keep their
exact signatures (thin wrappers over the reducer). No caller changes
(crawler.ts, diagnostic.ts, scripts consume via these two).

## Tests

- The golden gate `packages/crawler/test/adapters/joysound-official/
  classifierGolden.test.ts` must stay green with **ZERO test edits** — that is
  the in-repo identity gate (21 Part-A scenarios + Part-B1/B2 pins + Part-C
  differential).
- New `joysoundGates` phase-order test mirroring the existing
  `filterSteps` phase-order test (assertPhaseOrder throws on a mis-ordered
  array).

## Replay proof (the ROADMAP's release obligation for this item)

Double-replay byte-diff — compares baseline vs restructured over the SAME
inputs, which neutralizes the two inputs the decision log does not capture
(curated override lists and the corpus-derived injected-JP-artist predicate):

1. Corpus copy: `scratchpad/v22-replay/decisions.jsonl` (local copy of
   `Z:\karaoke\runs\data-2026-07-10-v22-fullcatalog\decisions.jsonl`,
   221.9 MB / 340,653 rows). Never stream from the NAS mount; never write
   outputs to the repo tree or the NAS.
2. Baseline pass: on pre-restructure main, `pnpm build` (replay loads the
   BUILT classifier from packages/crawler/dist via scripts/lib/joysound-dist.mjs),
   then `node scripts/joysound-replay-classifier.mjs --in <local decisions.jsonl>
   --out <scratch>/baseline.replayed.jsonl --corpus apps/web/public/data/songs.json`
   (exact flag names: verify against the script's arg parser before running).
   The committed songs.json is the corpus for BOTH passes (any fixed corpus
   works for an identity proof; committed = deterministic).
3. Restructured pass: rebuild dist on the branch, run the identical command to
   `restructured.replayed.jsonl`.
4. Proof = the two outputs are byte-identical (hash compare). Replayed rows
   preserve every input field and rewrite only decision/reason/detailFlipRisk,
   so byte-identity of the outputs == (decision, reason) identity across all
   340,653 rows. Report sizes + SHA-256 of both files as evidence.
5. Known harness caveats (do NOT need fixing for this procedure): the
   harness's own flip classifier ignores reason-only changes and its purity
   check is wired to the 2026-06-12 洋楽-veto policy — both are bypassed by
   the external byte-diff; do not rely on the harness's internal summary as
   the proof.

## Size expectation

Medium: `classifier.ts:442-563` (~120 lines) → gate array + PHASE_ORDER +
assert + context builder + reducer (~+180/−120 net), one new phase-order test
(~120 lines), ROADMAP item closure note. Nothing else.

## Out of scope

- Any predicate/constant change (Phase 2, owner-held).
- The replay harness's internal flip/purity logic (works as-is for the
  byte-diff procedure).
- `.tmp_review` cleanup (separate owner-gated proposal; its June decision log
  is NOT this proof's corpus — the v22 `decisions.jsonl` is).
