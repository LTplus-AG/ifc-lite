---
'@ifc-lite/viewer-embed': patch
'@ifc-lite/viewer': patch
---

Fix isolating a geometry-less entity (an `IfcElementAssembly` or similar container with no mesh of its own) blanking the entire 3D view instead of leaving the current isolation alone, across every `isolateEntities`/`setIsolatedEntities` call site routed through `cameraCallbacks.resolveHighlightIds` — the embed bridge's `ISOLATE` command, `?isolate=` URL params, IDS row/set isolation, the BCF viewpoint isolation mode, the anonymized-export preview, the SDK/MCP `isolate()` adapter, and a lens rule isolate.

A previous pass (#3382/#3338) unioned the resolver's result with the raw ids whenever the resolver returned `[]`, on the theory that `??` alone only guards an absent resolver. That is true while geometry is still streaming in — `resolveHighlightIds` legitimately returns nothing until the meshes arrive, and unioning the raw ids there lets the isolation apply correctly once they do. But when the resolver has already run against loaded geometry and genuinely finds nothing renderable, falling back to the raw ids isolates a set with no mesh id in it either, which blanks the model exactly like isolating `[]` does — it just converts one empty viewport into a different one (#3426).

`resolveHighlightIds` (Viewport.tsx) now distinguishes the two cases by returning `null` — "cannot answer yet, geometry not streamed in" — instead of `[]` in that case, reserving `[]` for "resolved, and nothing renders." A shared helper, `resolveIsolationIds` (`apps/viewer/src/lib/isolation/resolveIsolationIds.ts`), encodes the resulting policy once: union the raw ids when the resolver is absent or returns `null` (self-heals once geometry lands), and leave the isolation channel untouched when it returns `[]`. Every isolation call site now routes through this helper.

This still does not defer and re-resolve once geometry finishes streaming — the `null`/absent-resolver rows remain a "self-heals if geometry eventually renders these ids" gamble, not a guarantee. That signal is what a future deferred-resolution pass would hook into.
