---
"@ifc-lite/export": minor
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
"@ifc-lite/data": minor
"@ifc-lite/mutations": minor
---

Demesher: selective per-element mesh simplification with lightweight IFC re-export (#1767). `@ifc-lite/export` gains `DemeshSession` — pick elements (usually the heaviest, see `heaviest(n)`), escalate simplification one level per `simplify()` call (levels 1-4 = internal-cavity removal + vertex-clustering decimation at target ratios 0.5/0.25/0.10/0.03, level 5 = bounding-box collapse) with render-ready replacement meshes for live scene updates, then export a lighter IFC separately via `exportIfc()`, which authors `IfcTriangulatedFaceSet` geometry and prunes the replaced representation subgraphs (IFC2X3 input auto-upconverts to IFC4). Also exported: `applySimplifiedGeometry` and the supporting types.

`@ifc-lite/geometry` gains `GeometryProcessor.simplifyMeshes()` backed by the new wasm `simplifyMeshes` API (`SimplifiedMeshes`). `@ifc-lite/cli` gains `ifc-lite simplify <file.ifc> --level 1..5 [--ids ...] --out light.ifc [--json]` for dev/testing. `@ifc-lite/data` / `@ifc-lite/mutations` widen `IfcAttributeValue` with a write-only `{ real: number }` marker (serialized by `stepReal()` in `@ifc-lite/export`) so tessellation coordinates always carry a decimal point.
