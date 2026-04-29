---
"@ifc-lite/create": minor
"@ifc-lite/viewer": minor
---

Auto Spaces — generate IfcSpace volumes from a storey's walls.

Pick the **Space** type in the Add Element panel and the new **Auto
Spaces** section appears underneath the dimensions. Hit **Preview** to
see every enclosed region the wall graph forms (live SVG overlay,
labelled with area), then **Generate** to commit one IfcSpace per
region. Settings: snap tolerance (collapse sloppy wall ends), min area
(drop closets and slivers), height (extrusion), name pattern, and
IfcSpaceTypeEnum.

**`@ifc-lite/create`** — three new modules, all parser-pure:
- `auto-space-detect.ts` — planar-graph face finder. Snap →
  resolve crossings → DCEL half-edge graph → leftmost-turn cycle
  walk → drop unbounded faces → filter by min area. Handles
  multi-component layouts (two non-touching rooms find both),
  T-junctions, and snap-induced corner merges. 8 fixture tests.
- `extract-walls.ts` — pulls every wall axis on a target storey
  from a parsed `IfcDataStore`. Walks
  IfcRelContainedInSpatialStructure → IfcWall → placement chain →
  IfcRectangleProfileDef.XDim. Optional overlay reader includes
  walls created via the Add Element tool without a re-parse.
- `generate-spaces.ts` — orchestration: extract → detect → emit
  via `addSpaceToStore` polygon mode. `dryRun` runs detection only.

**`@ifc-lite/viewer`** — `mutationSlice.generateSpacesFromWalls`
returns the detection result. `AddElementPanel` gains the Auto Spaces
section; `AddElementOverlay` projects detected outlines back to screen
using the storey's elevation so the preview tracks the camera in
real time.
