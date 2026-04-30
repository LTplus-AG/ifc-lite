---
"@ifc-lite/ifcx": patch
"@ifc-lite/viewer": patch
---

Fix two regressions that prevented point clouds from rendering in the viewer:

1. **IFCx samples extracted zero points.** The entity extractor required
   `bsi::ifc::class` on every node before assigning an `expressId`, but the
   buildingSMART Point_Cloud_*.ifcx fixtures place `pcd::base64` /
   `points::array` / `points::base64` on nodes that carry only USD
   `xformop`. Those nodes now also become first-class entities (synthetic
   `IfcGeographicElement` type) so the point cloud extractor can emit
   them. Added regression assertions in `verify-dist-hello-wall.mjs`.

2. **`.las` / `.laz` files were silently ignored on single-file load.**
   The drop / picker single-file path goes through `useIfcLoader.loadFile`,
   which only branched on `ifcx` / `glb` / `ifc`. Added the LAS/LAZ branch
   there and wired it into the streaming ingest. Camera fit-to-view now
   triggers from `usePointCloudSync` for points-only scenes (the geometry
   streaming hook bails out early when there are no meshes).
