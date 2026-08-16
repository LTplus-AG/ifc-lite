---
'@ifc-lite/viewer': patch
---

Fix an orphaned clash intersection-solid render surviving the clash tour and Home / "Show all".

`focusClash` (`apps/viewer/src/hooks/useClash.ts`) computes the true intersection solid for a focused clash pair asynchronously, ghosts the whole model, and draws the solid opaque. The in-flight compute was staled out by `solidRequestGuard`, a `useRef` private to one `useClash()` hook instance — no code outside that hook's own callbacks could ever invalidate it.

Two teardown paths reset the same fields `useClash.clearHighlight()` resets (selection, isolation, ghost, pair colours, the contact overlay, `clashSelectedId`) directly against the store, written before the on-demand solid feature landed:

- the clash tour's "zoom-to-clash" step cleanup (`apps/viewer/src/lib/tours/tours/clash.ts`)
- the Home / "Show all" reset, `resetVisibilityForHomeFromStore` (`apps/viewer/src/store/homeView.ts`)

Neither called anything that could invalidate the guard, so running the clash tour to completion, or clicking Home / "Show all", while a clash solid was showing (or its compute was still in flight) left an orphaned opaque intersection-solid mesh rendering with nothing selected and no clash focused — or let a since-superseded compute land afterward and reapply the full-model ghost the user had just cleared.

Rather than adding `clearClashSolid()` calls at these two sites (which would leave the same gap for the next teardown path that forgets to), the invalidation now lives in the clash store slice itself: `setClashSelectedId` and `clearClashSolid` (`apps/viewer/src/store/slices/clashSlice.ts`) both reset the solid presentation and bump a new `clashSolidRequestSeq` counter. `focusClash`'s async compute checks that counter instead of a private ref, so any code path that changes or clears the focused clash — including ones not written yet — invalidates an in-flight solid compute by construction. `Viewport.tsx` additionally gates the solid draw on `clashSelectedId` as defence in depth.
