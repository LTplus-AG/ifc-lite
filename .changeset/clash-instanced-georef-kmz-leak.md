---
"@ifc-lite/viewer": patch
---

Fix the Location panel's KMZ export leaking every other loaded model's GPU-instanced geometry into a single model's export.

`GeoreferencingPanel` computed the `InstancedModelRange` it hands to `LocationMap`'s KMZ export by looking up its own `modelId` in the loaded-models map, falling back to `null` (no per-model filter) whenever that lookup failed — including while more than one model was loaded (no entity selected in a federation, or a stale id after a model was removed). `withInstancedMeshes(geometryResult, null)` treats `null` as "already spans every loaded model", so an unresolved `modelId` in a federation spliced every OTHER loaded model's instanced occurrences into this model's export.

`resolveInstancedExportGate` (new, in `@ifc-lite/viewer`'s `utils/instancedExport.ts`) makes `null` correct only when it's provably the sole loaded model, and otherwise withholds the export (`canExport: false`) rather than falling through to the leaky unfiltered case — mirroring the rule `KmzExportDialog` already followed for its own model list.
