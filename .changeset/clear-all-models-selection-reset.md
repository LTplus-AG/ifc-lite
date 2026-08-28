---
'@ifc-lite/viewer': patch
---

Fix `clearAllModels()` leaving the `EntityRef`-keyed half of selection state (`selectedEntity`, `selectedEntities`, `selectedEntitiesSet`, `selectedModelId`, `activeStorey`) pointing at models that were just removed.

The `all-models-cleared` teardown scope only ever cleared the global-id half (`selectedEntityId`, `selectedEntityIds`, `selectedStoreys`). `resetViewerState()` clears both halves, so the gap only showed on a path that calls `clearAllModels()` without it — `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`, which left the properties panel bound to a model that no longer existed.

Since `clearAllModels` removes every model, there is no surviving federated sibling to preserve a selection for (unlike the single-model `model-removed` scope, which filters by `modelId`), so both halves now clear unconditionally.
