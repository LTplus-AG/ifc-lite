---
"@ifc-lite/drawing-2d": minor
---

`storeyCutElevation(storeyElevation, cutHeight?, coordinateInfo?)` returns the render-frame Y for a plan cut a given height above a storey floor, so `generateFloorPlan` can cut storey-relative. `generateFloorPlan` takes a render-frame Y, and meshes are moved by the wasm RTC offset and the JS origin shift, so passing `Elevation + 1.2` cut at the wrong height on a re-based model. `IfcBuildingStorey.Elevation` is relative to the building placement, so the helper adds the site placement's Z and the building's local placement Z (`buildingOrigin.z` in the frame) and takes off both offsets. `DEFAULT_PLAN_CUT_HEIGHT` (1.2 m) is exported with it.
