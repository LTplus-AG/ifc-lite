---
"@ifc-lite/viewer": patch
---

Fix `removeModel`/`clearAllModels` leaving the AddElement panel's target-model pin, and every global-id set (isolate, ghost, hidden, selection, class filter), pointing at a model that no longer exists.

`removeModel`'s selection cleanup (added for #2654) purged `selectedEntity`/`activeStorey`/`selectedEntities` by comparing `.modelId`, but never touched the id-keyed state on the same slices: `addElementModelId`/`addElementStoreyId` (addElementSlice — the panel keeps naming a removed model and every placement click then fails with "No model loaded for id"), and `selectedEntityIds`/`selectedStoreys`/`hiddenEntities`/`isolatedEntities`/`ghostExceptEntities`/`classFilter`/`hiddenEntitiesByModel`/`isolatedEntitiesByModel` (selectionSlice/visibilitySlice — keyed by bare `globalId`, not `{modelId, expressId}`, so `.modelId` comparisons can't see them stale). A stale `isolatedEntities` was the worst of these: `syncSourceModel.ts`'s `purgeStaleEntityState` already runs the equivalent purge on the same-modelId resync path, and its own comment explains why an empty-but-non-null isolate set is worse than leaving it alone — `effectiveIsolatedIds` keeps returning it, so `isolatedIds` matches nothing in the surviving federation and the entire remaining scene renders as hidden. `removeModel` never got that treatment for the full-removal path.

Now `removeModel` resolves each id against which surviving model's parse range or mutation-view overlay owns it (mirroring `purgeStaleEntityState`), drops only the ids the removed model owned, and collapses an isolate/ghost set to `null` (not an empty `Set`) when nothing survives. `clearAllModels` clears all of it unconditionally, since no model survives.
