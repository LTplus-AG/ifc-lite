---
"@ifc-lite/viewer": patch
---

Fix `clearAllModels` leaving a registered 4D-animation overlay layer (`overlaySlice.overlayLayers`) pointed at a federation that no longer exists.

`federationRegistry.clear()` (called by `clearAllModels`) resets the offset counter to 0, so the next model registered can be handed the exact global-id offsets a still-registered layer's `hiddenIds`/`colorOverrides` describe. `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment` calls `clearAllModels()` directly, without `resetViewerState()`, then reloads every model — the same shape that made `compareResult` and the lens state misresolvable in #2854. `useConstructionSequence.ts` writes the 'animation' layer's ids as already-translated GLOBAL ids at registration time, and its registration effect's deps exclude `models`; `scheduleData` is untouched by `clearAllModels`, so a paused animation leaves the layer registered indefinitely across the reload. `useOverlayCompositor.ts` applies the composite straight to `hideEntities`/`setPendingColorUpdates` by global id, so a recycled offset would hide or tint whatever live entity the reloaded federation assigns that number to.

`clearAllModels` now drops every registered overlay layer. `removeModel` is left alone: `unregisterModel` burns the freed offset range instead of reclaiming it, so a layer left registered after a partial removal cannot ever be handed to a new model.
