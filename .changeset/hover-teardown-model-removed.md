---
'@ifc-lite/viewer': patch
---

Fix a hover tooltip or an open context menu surviving `removeModel` (dropping one model out of a live federation) and `clearAllModels`, so it kept naming a stale global express id that a later-loaded model could reuse.

`hoverSlice`'s `model-removed` and `all-models-cleared` teardown arms were both `notApplicable`. Only `session-reset` cleared `hoverState` / `contextMenu`, whose own doc comment already explains why that matters: "ids are reused across files, so a hover tooltip or an open context menu surviving a swap describes an unrelated element of the incoming one." That hazard applies just as much to removing a single federated model (other models staying loaded) or clearing the whole federation without a full session reset — several `clearAllModels()` call sites do exactly that (`GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`, a federation rebuild in `useFileCommands.tsx`).

`model-removed` now clears each field only when its `entityId` is stale (no surviving model owns that global id, mirroring `selectionSlice.teardown.ts`'s global-id half); `all-models-cleared` clears both unconditionally, since with every model gone there is no survivor left to ask.
