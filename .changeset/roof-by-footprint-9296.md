---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/cli": minor
"@ifc-lite/viewer": minor
---

Roofs by footprint (#9296). `addRoofToStore` and `bim.store.addRoof` take `EdgeSlopes` (radians, one per footprint edge; 0 is a gable end) and `Overhang` (metres) on the rectangle and polygon forms. A hip, gable, mono-pitch, L-, T- or U-shaped roof is built from a weighted straight skeleton of the footprint: one `IfcRoof` with a plumb-cut solid per plane and its `HIP_ROOF`, `GABLE_ROOF`, `SHED_ROOF` or `FREEFORM` type. Each sloped edge is a pivot line at the base height. Footprints that are neither convex nor rectilinear are refused with a reason, as are slopes over 85°, slopes given in degrees and overhangs that cross the eaves. The definition is recorded as `IfcLite_RoofFootprint`, and the planes report `Qto_RoofBaseQuantities`. New: `editFootprintRoofInStore` (`bim.store.editRoof`) changes one edge's slope, all slopes, the overhang or the thickness and rebuilds the planes as one atomic, undoable edit. The flat rectangle and polygon forms are unchanged.
