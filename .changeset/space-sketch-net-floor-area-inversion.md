---
'@ifc-lite/viewer': patch
---

Space Sketch no longer inverts `NetFloorArea` above `GrossFloorArea` when the "outer" boundary is emitted (twin of #3656). Confirming a drawn room only ever passed `grossFloorArea` (the wall-centreline area) to `addSpaceToStore`, leaving `NetFloorArea` to default to the emitted `OuterCurve`'s own area — the outer-face outline when the user picked "outer" in the boundary popover, which is larger than the centreline. `Qto_SpaceBaseQuantities.NetFloorArea` now always measures the room's inner-face outline, independent of which boundary the user chose to draw/emit, so it never exceeds `GrossFloorArea`.
