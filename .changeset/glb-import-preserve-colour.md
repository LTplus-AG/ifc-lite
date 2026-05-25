---
"@ifc-lite/cache": patch
"@ifc-lite/export": patch
---

fix(glb): preserve per-mesh colours when re-importing a `.glb`

Both GLB importers (`parseGLBToMeshData` in `@ifc-lite/cache` and the
secondary one in `@ifc-lite/export`) hardcoded
`color: [0.8, 0.8, 0.8, 1.0]` on every mesh and never looked at
`materials[*].pbrMetallicRoughness.baseColorFactor`. After the
GLB-export-dialog work (#688) wired colour authoring through the
exporter end-to-end, a round-trip
(IFC → GLB → re-import as model) silently lost all colour and the
viewport went grey.

Fix: resolve each primitive's `material` index against the glTF
`materials` array and copy `baseColorFactor` into `MeshData.color`,
keeping the previous grey as the fallback when a primitive has no
material (e.g. third-party glTFs). Regression tests added in both
packages cover the round-trip and the no-material fallback.
