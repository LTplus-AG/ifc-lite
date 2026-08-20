---
"@ifc-lite/viewer": patch
---

Fix the Add Element panel's Auto Spaces preview staying on screen after switching the target storey or federated model.

`AddElementAutoSpacePreview` is a dry-run wall-graph detection keyed to the storey it ran against (`storeyExpressId`), but nothing re-ran or cleared it when the target storey or model changed via the panel's selects — `AddElementOverlay` kept drawing the stale outlines at the old storey's elevation, and the panel kept reporting region/wall counts for a storey the user had since navigated away from. `setAddElementStoreyId` and `setAddElementModelId` now clear `addElementAutoSpacePreview` alongside the id, so a stale preview never outlives the selection it was computed for.
