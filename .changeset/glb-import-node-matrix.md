---
"@ifc-lite/cache": patch
---

GLB importer: honor node matrices so instanced exports round-trip.

The GLB importer (`parseGLBToMeshData`) composed only `node.translation` down the
hierarchy, never `node.matrix`. The from-meshes export (the viewer's "Export GLB")
emits translations only and round-tripped fine, but the from-bytes instanced exporter
(#1443) places each shared-template occurrence with a node MATRIX (rotation +
translation). Re-importing such a GLB collapsed every instanced occurrence onto the
template (each matrix node contributed a zero translation), losing per-occurrence
position and rotation.

The importer now composes the full column-major 4x4 down the hierarchy. The composed
TRANSLATION rides each mesh as `MeshData.origin` (kept out of the f32 vertex buffer for
georeferenced precision, as before), and any ROTATION/SCALE is baked into the small,
local imported vertices and normals (which stay f32-precise because they are
template-local). The pure-translation path is byte-identical to before, so the viewer's
own exports are unaffected.

Verified end to end: a real instanced GLB exported by `ifc-lite-export` (C20-Institute)
re-imports with occurrences spread across the building at many distinct world poses (not
collapsed), with local vertices staying sub-metre. Normal note: rotation is exact; a
non-uniform-scale instance would want the inverse-transpose for normals (a rare,
accepted approximation, since instance transforms are rigid).
