---
"@ifc-lite/create": minor
---

New `extractGridAxesForStorey` (#6232): the design-grid axes that apply to a storey, in storey-local metres. It reads the IfcGrids contained in the storey or in any spatial ancestor (building, site), from the file and from grids authored this session, through the same overlay-aware reader as `extractWallSegmentsForStorey`. Each axis carries its grid, canonical `AxisTag` and U/V/W family; straight polyline axes and IfcTrimmedCurve-over-IfcLine axes are read, bent polylines and other curves are counted in `skippedAxes`.
