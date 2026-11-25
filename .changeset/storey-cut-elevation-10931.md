---
"@ifc-lite/drawing-2d": minor
---

`generateFloorPlan` also takes a `StoreyCut` (`{ storeyElevation, cutHeight?, frame? }`) for a cut a given height above a storey floor, and `storeyCutElevation(storeyElevation, cutHeight?, frame?)` returns the same render-frame Y as a number. A plain number is still a render-frame Y. Meshes are moved by the wasm RTC offset and the JS origin shift, so passing `Elevation + 1.2` cut at the wrong height on a re-based model. `IfcBuildingStorey.Elevation` is relative to the building placement, so the site placement's Z and the building's local placement Z (`buildingOrigin.z` in the frame) are added and both offsets are taken off. `DEFAULT_PLAN_CUT_HEIGHT` (1.2 m) is exported with it.
