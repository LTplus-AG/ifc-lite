# P-05 — Model loop

**Problem.**
- Authors can't see what a spec matches until they run a checker.
- Nobody can explain why an element passed or failed in authoring terms.
- Deriving requirements from a good reference model is manual transcription.
- Blind spots (elements no spec governs) are invisible.

**Appetite.** 6 weeks, Track B (C3).

**Solution.** In the IDS worker, reusing validator internals (ADR-010):
- live funnel and requirement preview;
- 3D isolate/ghost/colour per stage;
- an explain tracer with near-miss reasons;
- distinct values in pickers;
- infer-from-selection with contrast learning and a pattern synthesiser;
- a coverage lens;
- model-aware lint rules;
- fix-in-place through mutations.

**Rabbit holes.**
- Federation: element identity across models. Always go through `FederationRegistry` / `resolveEntityRef`, and remember the selection footgun (`setSelectedEntityId`).
- Performance on 1M+ elements: sampling plus a confidence display, and stage caching keyed by facet prefix.
- Inference over-fitting (proposing 40 requirements). Rank by informativeness, show the top 8, and put the rest behind "more".

**No-gos.** No server-side computation. No new validator semantics (preview ≡ validate).

**Scopes.** IDS-055 … IDS-068.

**Done means.**
- p95 ≤ 300 ms funnel updates on a real 100k-element model.
- Preview/validator parity 100% on the corpus.
- Infer accuracy ≥ 90% on a labelled selection set.
- Coverage lens is live.

**Evidence.** Recordings on real models from at least two different authoring tools; benchmark baseline committed.
