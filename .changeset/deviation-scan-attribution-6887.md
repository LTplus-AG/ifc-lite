---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Attribute each scan row of the Deviation CSV to the scan's own model (#6887). In a federation where a streamed scan (LAS, LAZ, E57, PLY, PCD, PTS, XYZ or COPC) was not model 0, its row named model 0 and left GlobalId, Name and IfcClass empty. The panel now resolves the row's model and entity from the asset's federated id alone, and the viewer binds every streamed scan to its federated id and model index once the model is registered, so picks and `readDeviationDistances()` / `readDeviationAssetStats()` report the scan's model index instead of 0. `Renderer.relabelPointCloudAsset` takes an optional `modelIndex` for that binding.
