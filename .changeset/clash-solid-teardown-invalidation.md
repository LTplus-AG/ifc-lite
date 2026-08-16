---
'@ifc-lite/viewer': patch
---

Fix an orphaned clash intersection-solid render surviving the clash tour and Home / "Show all".

`focusClash` (`apps/viewer/src/hooks/useClash.ts`) computes the true intersection solid for a focused clash pair asynchronously, ghosts the whole model, and draws the solid opaque. The in-flight compute was staled out by `solidRequestGuard`, a `useRef` private to one `useClash()` hook instance — no code outside that hook's own callbacks could ever invalidate it.

Two teardown paths reset the same fields `useClash.clearHighlight()` resets (selection, isolation, ghost, pair colours, the contact overlay, `clashSelectedId`) directly against the store, written before the on-demand solid feature landed:

- the clash tour's "zoom-to-clash" step cleanup (`apps/viewer/src/lib/tours/tours/clash.ts`)
- the Home / "Show all" reset, `resetVisibilityForHomeFromStore` (`apps/viewer/src/store/homeView.ts`)

Neither called anything that could invalidate the guard, so running the clash tour to completion, or clicking Home / "Show all", while a clash solid was showing (or its compute was still in flight) left an orphaned opaque intersection-solid mesh rendering with nothing selected and no clash focused — or let a since-superseded compute land afterward and reapply the full-model ghost the user had just cleared.

Rather than adding `clearClashSolid()` calls at these two sites (which would leave the same gap for the next teardown path that forgets to), the invalidation now lives in the clash store slice itself: `setClashSelectedId`, `clearClashSolid` and `clearClash` (`apps/viewer/src/store/slices/clashSlice.ts`) all reset the solid presentation and bump a new `clashSolidRequestSeq` counter. `focusClash`'s async compute checks that counter instead of a private ref, so any code path that changes or clears the focused **clash** — including ones not written yet — invalidates an in-flight solid compute by construction. `Viewport.tsx` additionally gates the solid draw on `clashSelectedId !== null` as defence in depth.

That "by construction" property covers clash-*focus* teardown. The paths that replace or unload the **model** the presentation belongs to are a separate, pre-existing gap and touched no clash field at all, so a resolved solid and a non-null `clashSelectedId` both survived them — which meant the render gate passed too, and the previous model's solid was eligible to be re-pushed into the new scene when the renderer re-initialised. All three now route through the same store invalidation:

- `resetViewerState()` (`apps/viewer/src/store/index.ts`), the primary-file "open another model" reset, calls `clearClash()`. Same stale-model-reference class as the `compareResult` / `zoneAssignments` / `searchIndexes` drops beside it — a clash result is keyed by `model:expressId` pairs from the outgoing model, and an IFCX recomposition reassigns expressIds outright.
- `clearAllModels()` (`apps/viewer/src/store/slices/modelSlice.ts`) calls `clearClash()`: a full federation teardown leaves nothing for a solid to be drawn against.
- `removeModel()` drops the focused-clash **presentation** (`setClashSelectedId(null)` + `clearClashSolid()`) but keeps the clash **result**: the result is a list the user is reading, while the solid is a mesh in the live scene whose model set just changed under it.

Clash presets and settings are workspace preferences and survive all three, as they do everywhere else `clearClash` is called.
