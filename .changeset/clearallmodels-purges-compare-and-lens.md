---
"@ifc-lite/viewer": patch
---

Fix `clearAllModels` leaving an active model-comparison result and lens still pointed at a federation that no longer exists, and fix `removeModel` leaving a comparison result stale when the removed model was either side of it.

`federationRegistry.clear()` (called by `clearAllModels`) resets the offset counter to 0, so the next model registered can be handed the exact global-id offsets a surviving `compareResult` or lens state describes. `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment` calls `clearAllModels()` directly, without `resetViewerState()` — the only other place either was cleared — then reloads every model. If a comparison or a lens was active, its `excludedHiddenIds`/`diff` or `lensHiddenIds`/`lensColorMap`/`lensAppliedColors` could then silently hide or tint elements of the freshly reloaded, unrelated model. `useLens.ts`'s effect deps (`[activeLensId, activeLens]`) also never re-run on a model add/remove on their own, so a lens stays stale across any such reload regardless.

`clearAllModels` now clears `compareResult` and deactivates the lens (mirroring what `resetViewerState` already does on an ordinary file load). `removeModel` now clears `compareResult` when the removed model was the comparison's base or head — offsets are never reused on a partial removal, so this is precautionary consistency, not a misresolution fix — and leaves it alone otherwise, so removing an unrelated federated sibling does not disturb a comparison between two other still-loaded models.
