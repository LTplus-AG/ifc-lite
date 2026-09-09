---
"@ifc-lite/viewer": patch
---

Register `splitToolSlice` in the viewer store's teardown seam (`store/teardown-registry.ts`). It previously had no entry at all, so removing the model the Split tool was armed against — or clearing every model — left `splitMode`, `splitTargetModelId`/`splitTargetExpressId`, the hover preview fields and the slab two-click anchor pointing at a model that no longer existed; `SplitOverlay.tsx` has no membership check against `state.models`, so it kept drawing a stale cut-line preview. `mutationSlice.splitWallAtDistance` was never at risk — `resolveSplitContext` already refuses a resolved-but-missing model id — this only affected the tool staying visibly armed. All eleven fields now clear on `removeModel` (when the split target belonged to the removed model), `clearAllModels`, and a session reset (new file load); `splitMode` itself resets to `'idle'` in every case, since an armed tool with a cleared target is worse than an idle one.
