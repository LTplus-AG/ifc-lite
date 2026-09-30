---
"@ifc-lite/create": minor
---

New `extractGridAxesForStorey` (#6232): the design-grid axes that apply to a storey, in storey-local metres. It reads the IfcGrids contained in the storey or in any spatial ancestor (building, site), from the file and from grids authored this session, through the same overlay-aware reader as `extractWallSegmentsForStorey`. Each axis carries its grid, canonical `AxisTag` and U/V/W family; straight polyline axes and IfcTrimmedCurve-over-IfcLine axes are read, bent polylines and other curves are counted in `skippedAxes`.

Grid, wall and hosted planar frame reads share the canonical strict placement reader: omitted optional directions retain IFC defaults, while explicit unreadable, degenerate or incomplete directions and non-horizontal frames are refused on every required placement hop. Shared ancestor frames cancel when converting to storey-local coordinates. Grid axes skipped because their frame cannot be read are counted in `skippedAxes`.

Trimmed line axes require a readable 2D `IfcLine` basis, including a typed `IfcVector`, nonzero `IfcDirection` and finite positive `Magnitude`, even when trimmed by points. Parameter trims normalize the direction and apply its vector magnitude once; unreadable bases and nonfinite endpoints are counted in `skippedAxes`.

A grid without `ObjectPlacement` uses identity only when its readable storey also omits `ObjectPlacement`. Unplaced grids on placed or unreadable storeys are counted in `skippedAxes`.
