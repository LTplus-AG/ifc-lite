---
"@ifc-lite/create": minor
---

New in-store builders `addCurtainWallToStore` and `addGridToStore` (#6232). `addCurtainWallToStore` writes an IfcCurtainWall along a straight base line that aggregates its real parts: IfcMember mullions and transoms and IfcPlate panels, laid out on a regular or explicit U/V grid. Member sections come from the shared profile factory, and the panel thickness is a parameter. `curtainWallLayout` returns the same layout without emitting anything. `addGridToStore` writes an IfcGrid on a storey with tagged U, V and optional W IfcGridAxis axes. `rectangularGridAxes` builds the usual numbered and lettered axes. `gridIntersectionPlacement` writes the IfcGridPlacement that puts an element on the intersection of two grid axes. All of them lay out their attributes for the anchor's schema (IFC2X3, IFC4, IFC4X3) and refuse IFC5.
